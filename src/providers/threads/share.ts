/**
 * Resolves `/share/{shareCode}` links to `/@{username}/post/{code}`.
 *
 * Threads answers a share link with a 302 whose Location is the post URL
 * (plus an `xmt` tracking query that is dropped). A desktop browser
 * User-Agent gets a script-only page without `og:url` or a canonical link
 * (observed 2026-10-03), so the page fallback reuses the same agent.
 */

import { resolveShareLink } from "../../core/http";
import type { PostRef, UpstreamResult } from "../../core/types";
import { isThreadsUrl, parsePostUrl, THREADS_ORIGIN, threadsGet } from "./http";

/** The post a URL points to, when it carries a username; null otherwise. */
function resolved(url: URL): PostRef | null {
  const post = parsePostUrl(url.href);
  return post && post.username ? { key: post.code, params: { username: post.username, code: post.code } } : null;
}

export function resolveShare(shareCode: string): Promise<PostRef | UpstreamResult> {
  return resolveShareLink(new URL(`/share/${shareCode}/`, THREADS_ORIGIN), {
    get: threadsGet,
    allowed: isThreadsUrl,
    fromTarget: resolved,
    fromPage: resolved,
  });
}
