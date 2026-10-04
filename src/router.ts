/**
 * Picks the provider for a request: the hostname decides which providers are
 * allowed, then each one's path rule is tried in order.
 */

import type { PostRef, Provider } from "./core/types";
import { facebook } from "./providers/facebook";
import { instagram } from "./providers/instagram";
import { naver } from "./providers/naver";
import { threads } from "./providers/threads";

/** Order matters on the shared domain: Facebook's numeric `/reel/{id}` is tried before Instagram's. */
export const PROVIDERS: Provider[] = [naver, threads, facebook, instagram];

/**
 * The legacy domain keeps serving Naver only, so old links behave as before.
 * Facebook has its own domain because `/share/{hash}` is also a Threads path.
 */
const HOST_PROVIDERS: Record<string, Provider[]> = {
  "cafe.konnokai.me": [naver],
  "fb.ebfix.konnokai.me": [facebook],
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
