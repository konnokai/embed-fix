/**
 * Scheduled health check: fetches known public posts of every platform through
 * the fetchers only (no D1 writes, no cache) and logs a structured error when
 * the answer is not `public`, so upstream format changes show up in Workers
 * Logs before users report them. A sample that turns from ok to failing is
 * also announced on the Discord webhook (see `notify.ts`), once per outage.
 * The first sample of a platform is its status on the home page; the others
 * have their own state, so another fetch route that stays broken never hides
 * a new outage of the first one.
 */

import { readState, sendWebhook, writeState } from "./notify";
import { fetchPost } from "./pipeline";
import type { AccessStatus, Provider } from "./types";

export interface HealthResult {
  platform: string;
  path: string;
  status: AccessStatus;
  fetcher: string | null;
}

interface HealthFailure {
  event: "health_check_failed";
  /** The platform id, followed by the path for samples other than the first. */
  platform: string;
  fetcher?: string | null;
  status?: AccessStatus;
  httpStatus?: number | null;
  errorCode?: string | null;
  reason?: string;
}

interface Checked {
  result: HealthResult;
  failure: HealthFailure | null;
  primary: boolean;
}

async function checkPath(provider: Provider, path: string, primary: boolean, env: Env): Promise<Checked> {
  const name = primary ? provider.id : `${provider.id} ${path}`;
  const ref = provider.match(new URL(path, "https://health-check.invalid"));
  if (!ref) {
    return {
      result: { platform: provider.id, path, status: "transient", fetcher: null },
      failure: { event: "health_check_failed", platform: name, reason: "path_not_matched" },
      primary,
    };
  }

  const { result, fetcher } = await fetchPost(provider, ref, env);
  return {
    result: { platform: provider.id, path, status: result.kind, fetcher },
    failure:
      result.kind === "public"
        ? null
        : {
            event: "health_check_failed",
            platform: name,
            fetcher,
            status: result.kind,
            httpStatus: result.httpStatus,
            errorCode: result.errorCode,
          },
    primary,
  };
}

/** Notification state key; samples after the first append their path, e.g. `platform:facebook/groups/…/`. */
function stateKey({ result, primary }: Checked): string {
  return `platform:${result.platform}${primary ? "" : result.path}`;
}

function describeFailure(failure: HealthFailure): string {
  if (failure.reason) {
    return `- **${failure.platform}**：${failure.reason}`;
  }
  const details = [
    `fetcher ${failure.fetcher ?? "-"}`,
    `HTTP ${failure.httpStatus ?? "-"}`,
    ...(failure.errorCode ? [failure.errorCode] : []),
  ];
  return `- **${failure.platform}**：${failure.status}（${details.join("，")}）`;
}

/**
 * Returns the failures not announced yet, and marks recovered samples `ok`.
 * 讀不到 D1 時當成沒通知過：寧可多送一次，也不要漏掉。
 */
async function newFailures(env: Env, checked: Checked[]): Promise<Checked[]> {
  const fresh: Checked[] = [];
  for (const item of checked) {
    const key = stateKey(item);
    try {
      if (!item.failure) {
        await writeState(env.DB, key, "ok");
      } else if ((await readState(env.DB, key)) !== "failing") {
        fresh.push(item);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "health_state_failed", key, error: String(error) }));
      if (item.failure) {
        fresh.push(item);
      }
    }
  }
  return fresh;
}

/**
 * 只在樣本從正常變成失敗時通知一次，恢復時只改回 `ok`、不送訊息。
 * 送出成功後才標成 `failing`，送不出去下一小時會再試。
 */
async function notifyFailures(env: Env, checked: Checked[]): Promise<void> {
  const fresh = await newFailures(env, checked);
  if (fresh.length === 0) {
    return;
  }
  const content = ["⚠️ ebfix 健康檢查失敗", ...fresh.map((item) => describeFailure(item.failure!))].join("\n");
  if (!(await sendWebhook(env, content))) {
    return;
  }
  for (const item of fresh) {
    const key = stateKey(item);
    try {
      await writeState(env.DB, key, "failing");
    } catch (error) {
      console.error(JSON.stringify({ event: "health_state_failed", key, error: String(error) }));
    }
  }
}

const LAST_CHECK_KEY = "check:last";

/**
 * 首頁的狀態區塊用的紀錄，跟通知用的 `platform:{id}` 分開：那組只在通知送出後才標成 `failing`。
 * `check:{id}` 是最近一次的結果（`ok`／`failing`），只在結果改變時更新 `updated_at`，
 * 所以 `updated_at` 是「從什麼時候開始」；`check:last` 的 `updated_at` 是最後一次檢查的時間。
 */
async function recordResults(env: Env, results: HealthResult[]): Promise<void> {
  try {
    for (const result of results) {
      await writeState(env.DB, `check:${result.platform}`, result.status === "public" ? "ok" : "failing");
    }
    await writeState(env.DB, LAST_CHECK_KEY, String(Date.now()));
  } catch (error) {
    console.error(JSON.stringify({ event: "health_state_failed", error: String(error) }));
  }
}
export interface PlatformHealth {
  ok: boolean;
  /** When the platform entered this state, in epoch milliseconds. */
  since: number;
}

export interface HealthStatus {
  /** Epoch milliseconds of the last run, or null before the first one. */
  checkedAt: number | null;
  platforms: Record<string, PlatformHealth>;
}

export async function readHealthStatus(db: D1Database): Promise<HealthStatus> {
  const { results } = await db
    .prepare("SELECT key, value, updated_at FROM health_state WHERE key LIKE 'check:%'")
    .all<{ key: string; value: string; updated_at: number }>();
  const status: HealthStatus = { checkedAt: null, platforms: {} };
  for (const row of results) {
    if (row.key === LAST_CHECK_KEY) {
      status.checkedAt = row.updated_at;
    } else {
      status.platforms[row.key.slice("check:".length)] = { ok: row.value === "ok", since: row.updated_at };
    }
  }
  return status;
}

export async function runHealthChecks(providers: Provider[], env: Env): Promise<HealthResult[]> {
  const checked = await Promise.all(
    providers.flatMap((provider) =>
      (provider.healthCheckPaths ?? []).map((path, index) => checkPath(provider, path, index === 0, env)),
    ),
  );
  for (const { failure } of checked) {
    if (failure) {
      console.error(JSON.stringify(failure));
    }
  }
  // 首頁只看每個平台的第一個樣本。
  await recordResults(env, checked.filter((item) => item.primary).map((item) => item.result));
  await notifyFailures(env, checked);
  return checked.map((item) => item.result);
}
