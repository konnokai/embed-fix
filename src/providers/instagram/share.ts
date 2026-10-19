/**
 * Resolves share links (`/share/reel/{code}`, `/share/p/{code}`,
 * `/share/{code}`) to a post code.
 *
 * Instagram answers `/share/reel/BAf7vyMOu4/` with a 302 whose Location is
 * the post (`/reel/{code}/?igsh=…`); a HEAD and a request without a
 * User-Agent get the same answer (checked 2026-10-04). Without the trailing
 * slash some clients first get a 302 to the slashed share URL, so the request
 * always carries it. `/share/p/` and `/share/{code}` had no sample and are
 * assumed to behave the same.
 */

import { resolveShareLink } from "../../core/http";
import type { PostRef, UpstreamResult } from "../../core/types";
import { INSTAGRAM_ORIGIN, instagramGet, isInstagramUrl, isLoginUrl, matchPostUrl } from "./http";

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
export function resolveShare(path: string): Promise<PostRef | UpstreamResult> {
  return resolveShareLink(new URL(`${path}/`, INSTAGRAM_ORIGIN), {
    get: instagramGet,
    allowed: isInstagramUrl,
    fromTarget,
    fromPage: matchPostUrl,
  });
}
