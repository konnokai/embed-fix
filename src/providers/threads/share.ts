/**
 * Resolves `/share/{shareCode}` links to `/@{username}/post/{code}`.
 *
 * Threads answers a share link with a 302 whose Location is the post URL
 * (plus an `xmt` tracking query that is dropped). Redirects are walked by hand
 * so the post URL can be read from the Location without fetching the post
 * page. When the chain ends in a 200 instead, the page's `og:url` or canonical
 * link is used. A desktop browser User-Agent gets a script-only page without
 * either tag (observed 2026-10-03), so that fallback reuses the same agent.
 */

import type { PostRef, UpstreamResult } from "../../core/types";
import { isThreadsUrl, isTransientStatus, MAX_REDIRECTS, parsePostUrl, parseUrl, THREADS_ORIGIN, threadsGet } from "./http";
import { readMeta } from "./og";

function resolved(username: string, code: string): PostRef {
  return { key: code, params: { username, code } };
}

export async function resolveShare(shareCode: string): Promise<PostRef | UpstreamResult> {
  let current = new URL(`/share/${shareCode}/`, THREADS_ORIGIN);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await threadsGet(current.href);
    const status = response.status;

    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location") ?? "";
      const post = parsePostUrl(location, current);
      if (post && post.username) {
        return resolved(post.username, post.code);
      }
      const next = parseUrl(location, current);
      if (!next || !isThreadsUrl(next)) {
        return { kind: "transient", httpStatus: status, errorCode: "redirect_rejected" };
      }
      current = next;
      continue;
    }

    if (status === 404) {
      await response.body?.cancel();
      return { kind: "not_found", httpStatus: status, errorCode: null };
    }
    if (status !== 200) {
      await response.body?.cancel();
      return { kind: "transient", httpStatus: status, errorCode: isTransientStatus(status) ? null : "unexpected_status" };
    }

    const meta = await readMeta(response);
    const post = parsePostUrl(meta.get("og:url") ?? "") ?? parsePostUrl(meta.get("canonical") ?? "");
    if (post && post.username) {
      return resolved(post.username, post.code);
    }
    // An unknown share code also ends here with a plain 200 page, so this
    // cannot be told apart from a format change and is not reported as deleted.
    return { kind: "transient", httpStatus: status, errorCode: "share_unresolved" };
  }
  return { kind: "transient", httpStatus: null, errorCode: "too_many_redirects" };
}
