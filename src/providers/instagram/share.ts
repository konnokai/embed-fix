/**
 * Resolves share links (`/share/reel/{code}`, `/share/p/{code}`,
 * `/share/{code}`) to a post code.
 *
 * Instagram answers `/share/reel/BAf7vyMOu4/` with a 302 whose Location is
 * the post (`/reel/{code}/?igsh=…`); a HEAD and a request without a
 * User-Agent get the same answer (checked 2026-10-04). Without the trailing
 * slash some clients first get a 302 to the slashed share URL, so the request
 * always carries it. Only the Location header is read, so the post page
 * itself is never fetched here. `/share/p/` and `/share/{code}` had no sample
 * and are assumed to behave the same.
 */

import type { PostRef, UpstreamResult } from "../../core/types";
import { readMeta } from "../facebook/og";
import {
  INSTAGRAM_ORIGIN,
  instagramGet,
  isInstagramUrl,
  isLoginUrl,
  isTransientStatus,
  matchPostUrl,
  MAX_REDIRECTS,
  parseUrl,
} from "./http";

export const SHARE_PATH = /^\/share\/(?:(reel|p)\/)?([A-Za-z0-9_-]+)\/?$/;

export function matchShare(url: URL): PostRef | null {
  const match = SHARE_PATH.exec(url.pathname);
  if (!match) {
    return null;
  }
  const code = match[1] ? `${match[1]}/${match[2]}` : match[2];
  return { key: `share:${code}`, params: { path: `/share/${code}`, share: "1" } };
}

/** Reads one redirect target; null means "keep following". */
function fromTarget(target: URL, status: number): PostRef | UpstreamResult | null {
  if (isLoginUrl(target)) {
    return { kind: "transient", httpStatus: status, errorCode: "share_login" };
  }
  if (SHARE_PATH.test(target.pathname)) {
    return null;
  }
  return matchPostUrl(target) ?? { kind: "transient", httpStatus: status, errorCode: "share_unknown_target" };
}

/** `path` is the share path without the trailing slash, as stored by `matchShare`. */
export async function resolveShare(path: string): Promise<PostRef | UpstreamResult> {
  let current = new URL(`${path}/`, INSTAGRAM_ORIGIN);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await instagramGet(current.href);
    const status = response.status;

    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      const next = parseUrl(response.headers.get("location") ?? "", current);
      if (!next || !isInstagramUrl(next)) {
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

    // 假的分享代碼也回 200、不轉址，跟格式改變分不出來，所以讀不到貼文網址只算暫時失敗。
    const meta = await readMeta(response);
    for (const value of [meta.get("og:url"), meta.get("canonical")]) {
      const url = value ? parseUrl(value) : null;
      const ref = url && isInstagramUrl(url) ? matchPostUrl(url) : null;
      if (ref) {
        return ref;
      }
    }
    return { kind: "transient", httpStatus: status, errorCode: "share_unresolved" };
  }
  return { kind: "transient", httpStatus: null, errorCode: "too_many_redirects" };
}
