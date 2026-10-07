/**
 * Facebook URL rules and request helpers shared by the fetchers.
 *
 * A post is identified from the path plus a few query parameters
 * (`story_fbid`, `id`, `fbid`, `v`); every other parameter is tracking and is
 * dropped. The post key is derived from the URL alone, because the pipeline
 * looks up stored versions before anything is fetched. The same post can
 * therefore be stored under more than one key (pfbid, numeric ID, reel ID).
 */

import type { PostRef } from "../../core/types";
import { USER_AGENT } from "../threads/http";

export const FACEBOOK_ORIGIN = "https://www.facebook.com";

const FACEBOOK_HOST = /^(?:[a-z0-9-]+\.)?facebook\.com$/;

export const MAX_REDIRECTS = 5;

/** Query parameters that identify a post; kept in this order in canonical paths. */
const KEPT_PARAMS = ["story_fbid", "id", "fbid", "v"] as const;

const USER = "[A-Za-z0-9._-]+";
const POST_ID = "(pfbid[A-Za-z0-9]+|\\d+)";

interface PathRule {
  pattern: RegExp;
  /** Builds the key from the path match and the query; null when a required parameter is missing. */
  key(match: RegExpExecArray, query: URLSearchParams): string | null;
  /** Canonical path when it differs from the request path plus the kept parameters. */
  path?(match: RegExpExecArray, query: URLSearchParams): string;
}

const PATH_RULES: PathRule[] = [
  { pattern: new RegExp(`^/${USER}/posts/${POST_ID}/?$`), key: (m) => `posts:${m[1]}` },
  { pattern: /^\/reel\/(\d+)\/?$/, key: (m) => `video:${m[1]}` },
  { pattern: new RegExp(`^/${USER}/videos/(?:[^/]+/)?(\\d+)/?$`), key: (m) => `video:${m[1]}` },
  { pattern: /^\/watch\/?$/, key: (_, q) => numeric(q.get("v"), "video") },
  { pattern: /^\/(?:story|permalink)\.php$/, key: (_, q) => storyKey(q) },
  { pattern: /^\/(?:photo\/?|photo\.php)$/, key: (_, q) => numeric(q.get("fbid"), "photo") },
  {
    pattern: new RegExp(`^/groups/(${USER})/(?:posts|permalink)/(\\d+)/?$`),
    key: (m) => `group:${m[1]}/${m[2]}`,
  },
  {
    // 社團動態頁把某篇貼文置頂的網址；轉成那篇貼文的網址，原文按鈕才會只開那一篇。
    pattern: new RegExp(`^/groups/(${USER})/?$`),
    key: (m, q) => {
      const id = firstPermalink(q);
      return id ? `group:${m[1]}/${id}` : null;
    },
    path: (m, q) => `/groups/${m[1]}/posts/${firstPermalink(q)}/`,
  },
];

/** `multi_permalinks` can list several comma-separated post IDs; the first one is the post that was shared. */
function firstPermalink(query: URLSearchParams): string | null {
  const first = query.get("multi_permalinks")?.split(",")[0] ?? "";
  return /^\d+$/.test(first) ? first : null;
}

function numeric(value: string | null, prefix: string): string | null {
  return value && /^\d+$/.test(value) ? `${prefix}:${value}` : null;
}

function storyKey(query: URLSearchParams): string | null {
  const story = query.get("story_fbid");
  // story.php 的 id 是作者 ID，沒有它 Facebook 找不到貼文，所以兩個都要有。
  if (!story || !/^(?:pfbid[A-Za-z0-9]+|\d+)$/.test(story) || !/^\d+$/.test(query.get("id") ?? "")) {
    return null;
  }
  return `story:${story}`;
}

/** Path plus the kept query parameters, e.g. `/story.php?story_fbid=…&id=…`. */
function canonicalPath(url: URL): string {
  const kept = new URLSearchParams();
  for (const name of KEPT_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) {
      kept.set(name, value);
    }
  }
  const query = kept.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/** Matches a Facebook post path; the host is ignored, so the service domain works too. */
export function matchPostUrl(url: URL): PostRef | null {
  for (const rule of PATH_RULES) {
    const match = rule.pattern.exec(url.pathname);
    if (!match) {
      continue;
    }
    const key = rule.key(match, url.searchParams);
    if (!key) {
      return null;
    }
    return { key, params: { path: rule.path?.(match, url.searchParams) ?? canonicalPath(url) } };
  }
  return null;
}

export function postUrl(ref: PostRef): string {
  return `${FACEBOOK_ORIGIN}${ref.params.path}`;
}

export function parseUrl(value: string, base?: URL | string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function isFacebookUrl(url: URL): boolean {
  return url.protocol === "https:" && FACEBOOK_HOST.test(url.hostname);
}

/** Login walls, including the page shown to clients Facebook does not recognise. */
export function isLoginUrl(url: URL): boolean {
  return /^\/(?:login|checkpoint|recover|unsupportedbrowser)\b/.test(url.pathname);
}

/**
 * Facebook answers in the language of the client IP when no locale is given,
 * so English is always requested; the parsers rely on English labels.
 */
export function facebookGet(url: string): Promise<Response> {
  return fetch(url, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
  });
}

/** Status codes that say "try again later" rather than anything about the post. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
