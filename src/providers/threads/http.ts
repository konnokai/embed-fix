/**
 * Request helpers shared by the Threads fetchers. Every request carries
 * `USER_AGENT` (see `core/http.ts` for why).
 */

import { USER_AGENT } from "../../core/http";

export const THREADS_ORIGIN = "https://www.threads.com";

const THREADS_HOSTS = new Set(["www.threads.com", "threads.com", "www.threads.net", "threads.net"]);

/**
 * `/@{username}/post/{code}` on a Threads host; the username may be empty on
 * login-only posts. Threads appends the post's title after the code
 * (`/post/{code}/{title}/`), so anything past the code is ignored.
 */
export const POST_PATH = /^\/(?:@|%40)([A-Za-z0-9._]*)\/post\/([A-Za-z0-9_-]+)(?:\/.*)?$/;

export function isThreadsUrl(url: URL): boolean {
  return url.protocol === "https:" && THREADS_HOSTS.has(url.hostname);
}

/** Extracts username and code from a Threads post URL; null for anything else. */
export function parsePostUrl(value: string): { username: string; code: string } | null {
  const url = URL.parse(value);
  if (!url || !isThreadsUrl(url)) {
    return null;
  }
  const match = POST_PATH.exec(url.pathname);
  return match ? { username: match[1], code: match[2] } : null;
}

export function threadsGet(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual", headers: { "user-agent": USER_AGENT } });
}
