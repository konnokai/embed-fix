/**
 * Facebook URL rules and request helpers shared by the fetchers.
 *
 * A post is identified from the path plus a few query parameters
 * (`story_fbid`, `id`, `fbid`, `v`); every other parameter is tracking and is
 * dropped. Profiles (`profile.php?id=`, `/people/{name}/{id}`, `/p/{name}-{id}`)
 * are matched too and keyed `profile:`; group home pages are `group-home:`. The post key is derived from the URL
 * alone, because the pipeline looks up stored versions before anything is
 * fetched. The same post can
 * therefore be stored under more than one key (pfbid, numeric ID, reel ID).
 */

import { USER_AGENT } from "../../core/http";
import type { PostRef } from "../../core/types";

export const FACEBOOK_ORIGIN = "https://www.facebook.com";

/** Discord's crawler UA; only group home pages are fetched with it (see `og.ts`). */
export const DISCORDBOT_USER_AGENT = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

const FACEBOOK_HOST = /^(?:[a-z0-9-]+\.)?facebook\.com$/;

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
    // 社團動態頁把某篇貼文置頂的網址；轉成那篇貼文的網址，原文按鈕才會只開那一篇。沒有置頂貼文就是社團主頁。
    pattern: new RegExp(`^/groups/(${USER})/?$`),
    key: (m, q) => {
      const id = firstPermalink(q);
      return id ? `group:${m[1]}/${id}` : `group-home:${m[1]}`;
    },
    path: (m, q) => {
      const id = firstPermalink(q);
      return id ? `/groups/${m[1]}/posts/${id}/` : `/groups/${m[1]}/`;
    },
  },
  { pattern: /^\/profile\.php$/, key: (_, q) => numeric(q.get("id"), "profile") },
  { pattern: new RegExp(`^/people/[^/]+/${POST_ID}/?$`), key: (m) => `profile:${m[1]}` },
  // Instagram 的 /p/{code} 也可能有 -，所以結尾要有 9 位以上的數字 ID 才當成個人頁，免得在共用網域搶走 Instagram 貼文。
  { pattern: /^\/p\/[^/]+-(\d{9,})\/?$/, key: (m) => `profile:${m[1]}` },
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

/** First path segments that are Facebook's own pages (`/watch/…`, `/story.php`, …), never a username. */
export const NOT_PROFILES = new Set([
  "watch", "reel", "reels", "photo", "photo.php", "story.php", "permalink.php", "groups", "share", "sharer",
  "people", "p", "events", "stories", "marketplace", "gaming",
]);

const PAGE_PATH = /^\/([A-Za-z0-9.]+)\/?$/;

/** Browsers and crawlers ask for these on any domain; they are never usernames. */
const FILE_NAME = /\.(?:ico|png|jpe?g|gif|svg|txt|xml|json|php|html?|js|css|webmanifest)$/i;

/** `/{username}` of a page or profile, keyed like the other profile paths. */
export function matchPageUrl(url: URL): PostRef | null {
  const match = PAGE_PATH.exec(url.pathname);
  if (!match || FILE_NAME.test(match[1]) || NOT_PROFILES.has(match[1].toLowerCase()) || isLoginUrl(url)) {
    return null;
  }
  return { key: `profile:${match[1]}`, params: { path: url.pathname } };
}

export function postUrl(ref: PostRef): string {
  return `${FACEBOOK_ORIGIN}${ref.params.path}`;
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
export function facebookGet(url: string, userAgent = USER_AGENT): Promise<Response> {
  return fetch(url, {
    redirect: "manual",
    headers: { "user-agent": userAgent, "accept-language": "en-US,en;q=0.9" },
  });
}
