/**
 * Scheduled health check: fetches one known public post per platform through
 * the fetchers only (no D1 writes, no cache) and logs a structured error when
 * the answer is not `public`, so upstream format changes show up in Workers
 * Logs before users report them. A platform that turns from ok to failing is
 * also announced on the Discord webhook (see `notify.ts`), once per outage.
 */

import { readState, sendWebhook, writeState } from "./notify";
import { fetchPost } from "./pipeline";
import type { AccessStatus, Provider } from "./types";

export interface HealthResult {
  platform: string;
  status: AccessStatus;
  fetcher: string | null;
}

interface HealthFailure {
  event: "health_check_failed";
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
}

async function checkProvider(provider: Provider, env: Env): Promise<Checked | null> {
  if (!provider.healthCheckPath) {
    return null;
  }
  const ref = provider.match(new URL(provider.healthCheckPath, "https://health-check.invalid"));
  if (!ref) {
    return {
      result: { platform: provider.id, status: "transient", fetcher: null },
      failure: { event: "health_check_failed", platform: provider.id, reason: "path_not_matched" },
    };
  }

  const { result, fetcher } = await fetchPost(provider, ref, env);
  return {
    result: { platform: provider.id, status: result.kind, fetcher },
    failure:
      result.kind === "public"
        ? null
        : {
            event: "health_check_failed",
            platform: provider.id,
            fetcher,
            status: result.kind,
            httpStatus: result.httpStatus,
            errorCode: result.errorCode,
          },
  };
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
 * Returns the failures not announced yet, and marks recovered platforms `ok`.
 * 讀不到 D1 時當成沒通知過：寧可多送一次，也不要漏掉。
 */
async function newFailures(env: Env, checked: Checked[]): Promise<HealthFailure[]> {
  const fresh: HealthFailure[] = [];
  for (const { result, failure } of checked) {
    const key = `platform:${result.platform}`;
    try {
      if (!failure) {
        await writeState(env.DB, key, "ok");
      } else if ((await readState(env.DB, key)) !== "failing") {
        fresh.push(failure);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "health_state_failed", platform: result.platform, error: String(error) }));
      if (failure) {
        fresh.push(failure);
      }
    }
  }
  return fresh;
}

/**
 * 只在平台從正常變成失敗時通知一次，恢復時只改回 `ok`、不送訊息。
 * 送出成功後才標成 `failing`，送不出去下一小時會再試。
 */
async function notifyFailures(env: Env, checked: Checked[]): Promise<void> {
  const fresh = await newFailures(env, checked);
  if (fresh.length === 0) {
    return;
  }
  const content = ["⚠️ ebfix 健康檢查失敗", ...fresh.map(describeFailure)].join("\n");
  if (!(await sendWebhook(env, content))) {
    return;
  }
  for (const failure of fresh) {
    try {
      await writeState(env.DB, `platform:${failure.platform}`, "failing");
    } catch (error) {
      console.error(JSON.stringify({ event: "health_state_failed", platform: failure.platform, error: String(error) }));
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
  const checked = (await Promise.all(providers.map((provider) => checkProvider(provider, env)))).filter(
    (item): item is Checked => item !== null,
  );
  for (const { failure } of checked) {
    if (failure) {
      console.error(JSON.stringify(failure));
    }
  }
  const results = checked.map((item) => item.result);
  await recordResults(env, results);
  await notifyFailures(env, checked);
  return results;
}
