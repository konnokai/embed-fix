/**
 * Resolves share links (`/share/p/{hash}`, `/share/r/…`, `/share/v/…`,
 * `/share/{hash}`) to a post path.
 *
 * From Cloudflare's network, www.facebook.com mostly answers a share link
 * with a login redirect, while m.facebook.com answers with a 302 to the post
 * (22 of 24 in F0, 2026-10-03); mbasic.facebook.com is the second try.
 * Retired old-format links also answer a plain 200 page (F0's `/share/p/C3Dx…`).
 */

import { resolveShareLink } from "../../core/http";
import type { PostRef, UpstreamResult } from "../../core/types";
import { facebookGet, isFacebookUrl, isLoginUrl, matchPostUrl } from "./http";

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

export async function resolveShare(path: string): Promise<PostRef | UpstreamResult> {
  let last: PostRef | UpstreamResult = { kind: "transient", httpStatus: null, errorCode: "share_unresolved" };
  for (const origin of SHARE_HOSTS) {
    last = await resolveShareLink(new URL(path, origin), {
      get: facebookGet,
      allowed: isFacebookUrl,
      fromTarget,
      fromPage: matchPostUrl,
    });
    if (!("kind" in last) || last.kind !== "transient") {
      return last;
    }
  }
  return last;
}
