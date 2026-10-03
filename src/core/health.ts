/**
 * Scheduled health check: fetches one known public post per platform through
 * the fetchers only (no D1 writes, no cache) and logs a structured error when
 * the answer is not `public`, so upstream format changes show up in Workers
 * Logs before users report them.
 */

import { fetchPost } from "./pipeline";
import type { AccessStatus, Provider } from "./types";

export interface HealthResult {
  platform: string;
  status: AccessStatus;
  fetcher: string | null;
}

async function checkProvider(provider: Provider, env: Env): Promise<HealthResult | null> {
  if (!provider.healthCheckPath) {
    return null;
  }
  const ref = provider.match(new URL(provider.healthCheckPath, "https://health-check.invalid"));
  if (!ref) {
    console.error(JSON.stringify({ event: "health_check_failed", platform: provider.id, reason: "path_not_matched" }));
    return { platform: provider.id, status: "transient", fetcher: null };
  }

  const { result, fetcher } = await fetchPost(provider, ref, env);
  if (result.kind !== "public") {
    console.error(
      JSON.stringify({
        event: "health_check_failed",
        platform: provider.id,
        fetcher,
        status: result.kind,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode,
      }),
    );
  }
  return { platform: provider.id, status: result.kind, fetcher };
}

export async function runHealthChecks(providers: Provider[], env: Env): Promise<HealthResult[]> {
  const results = await Promise.all(providers.map((provider) => checkProvider(provider, env)));
  return results.filter((result): result is HealthResult => result !== null);
}
