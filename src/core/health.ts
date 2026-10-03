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

export async function runHealthChecks(providers: Provider[], env: Env): Promise<HealthResult[]> {
  const checked = (await Promise.all(providers.map((provider) => checkProvider(provider, env)))).filter(
    (item): item is Checked => item !== null,
  );
  for (const { failure } of checked) {
    if (failure) {
      console.error(JSON.stringify(failure));
    }
  }
  await notifyFailures(env, checked);
  return checked.map((item) => item.result);
}
