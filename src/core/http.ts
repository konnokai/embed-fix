/**
 * Upstream request helpers shared by the providers.
 *
 * Redirects are followed by hand and only to hosts the provider allows, so a
 * Location header can never point a request elsewhere.
 */

import { readMeta } from "./html";
import type { PostRef, UpstreamResult } from "./types";

/**
 * Sent on every upstream request. Without a User-Agent Threads redirects to
 * facebook.com/unsupportedbrowser, and a desktop browser User-Agent only gets
 * the script-only app shell (both observed 2026-10-03).
 */
export const USER_AGENT = "ebfix/1.0 (+https://ebfix.konnokai.me)";

const MAX_REDIRECTS = 5;

/** Status codes that say "try again later" rather than anything about the post. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * GET that follows at most `MAX_REDIRECTS` redirects, all of them to allowed
 * hosts. `onRedirect` sees every allowed target first and ends the walk by
 * returning something other than null. Returns the first non-redirect
 * response, the value `onRedirect` returned, or a transient result.
 */
export async function follow<T = never>(
  start: URL,
  get: (url: string) => Promise<Response>,
  allowed: (url: URL) => boolean,
  onRedirect: (target: URL, status: number) => T | null = () => null,
): Promise<Response | T | UpstreamResult> {
  let current = start;
  for (let hop = 0; ; hop += 1) {
    const response = await get(current.href);
    const status = response.status;
    if (status < 300 || status >= 400) {
      return response;
    }
    await response.body?.cancel();
    const location = response.headers.get("location");
    const next = location ? URL.parse(location, current.href) : null;
    if (!next || !allowed(next)) {
      return { kind: "transient", httpStatus: status, errorCode: "redirect_rejected" };
    }
    const stopped = onRedirect(next, status);
    if (stopped !== null) {
      return stopped;
    }
    if (hop >= MAX_REDIRECTS) {
      return { kind: "transient", httpStatus: null, errorCode: "too_many_redirects" };
    }
    current = next;
  }
}

export interface ShareRules {
  get(url: string): Promise<Response>;
  allowed(url: URL): boolean;
  /** Reads one redirect target; null means "keep following". */
  fromTarget(target: URL, status: number): PostRef | UpstreamResult | null;
  /** The post that the final page's `og:url` or canonical link points to, if any. */
  fromPage(url: URL): PostRef | null;
}

/**
 * Resolves a share link from its redirects; only the Location headers are
 * read, so the post page itself is never fetched. When the chain ends in a
 * 200 page instead, its `og:url` or canonical link is used. An unknown share
 * code also answers a plain 200 page, which cannot be told apart from a format
 * change, so that is only a transient failure.
 */
export async function resolveShareLink(start: URL, rules: ShareRules): Promise<PostRef | UpstreamResult> {
  const followed = await follow(start, rules.get, rules.allowed, rules.fromTarget);
  if (!(followed instanceof Response)) {
    return followed;
  }
  const status = followed.status;
  if (status === 404) {
    await followed.body?.cancel();
    return { kind: "not_found", httpStatus: status, errorCode: null };
  }
  if (status !== 200) {
    await followed.body?.cancel();
    return { kind: "transient", httpStatus: status, errorCode: isTransientStatus(status) ? null : "unexpected_status" };
  }

  const meta = await readMeta(followed);
  for (const value of [meta.get("og:url"), meta.get("canonical")]) {
    const url = value ? URL.parse(value) : null;
    const ref = url && rules.allowed(url) ? rules.fromPage(url) : null;
    if (ref) {
      return ref;
    }
  }
  return { kind: "transient", httpStatus: status, errorCode: "share_unresolved" };
}
