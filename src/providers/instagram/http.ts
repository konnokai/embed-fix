/**
 * Instagram URL rules and request helpers shared by the fetchers.
 *
 * A post is identified by its code alone: `/p/`, `/reel/`, `/reels/`, `/tv/`
 * and the `/{username}/p/…` form Instagram uses in `og:url` all lead to the
 * same post, and the embed page answers on `/p/{code}` for every kind. The
 * query string (`igsh`, `utm_source`, `img_index`) is tracking and is dropped.
 */

import type { PostRef } from "../../core/types";
import { USER_AGENT } from "../threads/http";

export const INSTAGRAM_ORIGIN = "https://www.instagram.com";

const INSTAGRAM_HOSTS = new Set(["www.instagram.com", "instagram.com"]);

export const MAX_REDIRECTS = 5;

/** Media hosts seen in embed pages and og tags (checked 2026-10-04). */
const MEDIA_HOST = /^[a-z0-9.-]+\.(?:cdninstagram\.com|fbcdn\.net)$/;

/**
 * `/{username}/p/{code}`, `/p/{code}`, `/reel/{code}`, `/reels/{code}`, `/tv/{code}`.
 * The username form only comes with `p` and `reel`.
 */
const POST_PATH = /^\/(?:([A-Za-z0-9._]+)\/(p|reel)|(p|reel|reels|tv))\/([A-Za-z0-9_-]+)\/?$/;

export function parseUrl(value: string, base?: URL | string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function isInstagramUrl(url: URL): boolean {
  return url.protocol === "https:" && INSTAGRAM_HOSTS.has(url.hostname);
}

export function isLoginUrl(url: URL): boolean {
  return /^\/(?:accounts\/login|challenge)\b/.test(url.pathname);
}

/** An https URL on an Instagram media host; null for anything else. */
export function mediaUrl(value: string | null | undefined): string | null {
  const url = value ? parseUrl(value) : null;
  return url && url.protocol === "https:" && MEDIA_HOST.test(url.hostname) ? url.href : null;
}

/** Matches an Instagram post path; the host is ignored, so the service domain works too. */
export function matchPostUrl(url: URL): PostRef | null {
  const match = POST_PATH.exec(url.pathname);
  if (!match) {
    return null;
  }
  const [, username, userKind, kind, code] = match;
  // reels、tv 都是同一篇貼文的別名，原文網址統一用 reel，tv 照舊。
  const normalized = (userKind ?? kind) === "reels" ? "reel" : (userKind ?? kind);
  return { key: code, params: { code, kind: normalized, ...(username ? { username } : {}) } };
}

/** `/{username}/p/{code}` when the username is known, otherwise `/{kind}/{code}`. */
export function postPath(ref: PostRef): string {
  const { username, kind, code } = ref.params;
  return username ? `/${username}/${kind}/${code}` : `/${kind}/${code}`;
}

export function postUrl(ref: PostRef): string {
  return `${INSTAGRAM_ORIGIN}${postPath(ref)}/`;
}

/**
 * Without an Accept-Language some labels follow the client IP ("已驗證"
 * instead of "Verified", observed 2026-10-04); the HTML parser relies on the
 * English ones. `?hl=en` does not help.
 */
export function instagramGet(url: string): Promise<Response> {
  return fetch(url, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
  });
}

/** Status codes that say "try again later" rather than anything about the post. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
