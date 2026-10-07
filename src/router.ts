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

export const MAIN_HOST = "ebfix.konnokai.me";
export const FACEBOOK_HOST = "fb.ebfix.konnokai.me";
export const INSTAGRAM_HOST = "ig.ebfix.konnokai.me";
const LEGACY_HOST = "cafe.konnokai.me";

/**
 * The legacy domain keeps serving Naver only, so old links behave as before.
 * Facebook has its own domain because `/share/{hash}` is also a Threads path;
 * Instagram's `/share/p/` and `/share/{hash}` collide the same way.
 */
const HOST_PROVIDERS: Record<string, Provider[]> = {
  [LEGACY_HOST]: [naver],
  [FACEBOOK_HOST]: [facebook],
  [INSTAGRAM_HOST]: [instagram],
};

export function providersFor(hostname: string): Provider[] {
  return HOST_PROVIDERS[hostname] ?? PROVIDERS;
}

/** 舊網域的 `/` 維持 400，跟以前一樣；其他網域的 `/` 都是同一個首頁。 */
export function servesHomePage(hostname: string): boolean {
  return hostname !== LEGACY_HOST;
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
