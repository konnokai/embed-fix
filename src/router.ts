/**
 * Picks the provider for a request: the hostname decides which providers are
 * allowed, then each one's path rule is tried in order.
 */

import type { PostRef, Provider } from "./core/types";
import { naver } from "./providers/naver";
import { threads } from "./providers/threads";

export const PROVIDERS: Provider[] = [naver, threads];

/** The legacy domain keeps serving Naver only, so old links behave as before. */
const HOST_PROVIDERS: Record<string, Provider[]> = {
  "naver.konnokai.me": [naver],
};

export function providersFor(hostname: string): Provider[] {
  return HOST_PROVIDERS[hostname] ?? PROVIDERS;
}

export function route(url: URL): { provider: Provider; ref: PostRef } | null {
  for (const provider of providersFor(url.hostname)) {
    const ref = provider.match(url);
    if (ref) {
      return { provider, ref };
    }
  }
  return null;
}
