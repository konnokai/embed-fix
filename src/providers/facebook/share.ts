/**
 * Resolves share links (`/share/p/{hash}`, `/share/r/…`, `/share/v/…`,
 * `/share/{hash}`) to a post path.
 *
 * From Cloudflare's network, www.facebook.com mostly answers a share link
 * with a login redirect, while m.facebook.com answers with a 302 to the post
 * (22 of 24 in F0, 2026-10-03); mbasic.facebook.com is the second try. Only
 * the Location header is read, so the post page itself is never fetched here.
 */

import type { PostRef, UpstreamResult } from "../../core/types";
import { facebookGet, isFacebookUrl, isLoginUrl, isTransientStatus, matchPostUrl, MAX_REDIRECTS, parseUrl } from "./http";
import { readMeta } from "./og";

export const SHARE_PATH = /^\/share\/(?:([prv])\/)?([A-Za-z0-9_-]+)\/?$/;

const SHARE_HOSTS = ["https://m.facebook.com", "https://mbasic.facebook.com"];

/** Targets that are never posts; anything else unknown may be a new URL format. */
const UNSUPPORTED_TARGET = /^\/(?:events|marketplace|stories|gaming|live)\//;

export function matchShare(url: URL): PostRef | null {
  const match = SHARE_PATH.exec(url.pathname);
  if (!match) {
    return null;
  }
  const code = match[1] ? `${match[1]}/${match[2]}` : match[2];
  return { key: `share:${code}`, params: { path: `/share/${code}/`, share: "1" } };
}

/** Reads one redirect target; null means "keep following". */
function fromTarget(target: URL, status: number): PostRef | UpstreamResult | null {
  if (isLoginUrl(target)) {
    return { kind: "transient", httpStatus: status, errorCode: "share_login" };
  }
  if (SHARE_PATH.test(target.pathname)) {
    return null;
  }
  const ref = matchPostUrl(target);
  if (ref) {
    return ref;
  }
  return UNSUPPORTED_TARGET.test(target.pathname)
    ? { kind: "not_found", httpStatus: status, errorCode: "unsupported_target" }
    : { kind: "transient", httpStatus: status, errorCode: "share_unknown_target" };
}

async function resolveOn(start: URL): Promise<PostRef | UpstreamResult> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await facebookGet(current.href);
    const status = response.status;

    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      const next = parseUrl(response.headers.get("location") ?? "", current);
      if (!next || !isFacebookUrl(next)) {
        return { kind: "transient", httpStatus: status, errorCode: "redirect_rejected" };
      }
      const result = fromTarget(next, status);
      if (result) {
        return result;
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

    // 失效的舊格式連結也回 200、不轉址（F0 的 /share/p/C3Dx…），所以讀不到貼文網址只算暫時失敗。
    const meta = await readMeta(response);
    for (const value of [meta.get("og:url"), meta.get("canonical")]) {
      const url = value ? parseUrl(value) : null;
      const ref = url && isFacebookUrl(url) ? matchPostUrl(url) : null;
      if (ref) {
        return ref;
      }
    }
    return { kind: "transient", httpStatus: status, errorCode: "share_unresolved" };
  }
  return { kind: "transient", httpStatus: null, errorCode: "too_many_redirects" };
}

export async function resolveShare(path: string): Promise<PostRef | UpstreamResult> {
  let last: PostRef | UpstreamResult = { kind: "transient", httpStatus: null, errorCode: "share_unresolved" };
  for (const origin of SHARE_HOSTS) {
    last = await resolveOn(new URL(path, origin));
    if (!("kind" in last) || last.kind !== "transient") {
      return last;
    }
  }
  return last;
}
