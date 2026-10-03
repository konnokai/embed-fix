/**
 * Request helpers shared by the Threads fetchers.
 *
 * Every request carries an explicit User-Agent: without one Threads answers
 * with a redirect to facebook.com/unsupportedbrowser, and a desktop browser
 * User-Agent gets the script-only app shell instead of the embed markup
 * (both observed 2026-10-03). Redirects are followed by hand and only within
 * the Threads hosts, so a Location header can never point a request elsewhere.
 */

export const USER_AGENT = "ebfix/1.0 (+https://ebfix.konnokai.me)";

export const THREADS_ORIGIN = "https://www.threads.com";

const THREADS_HOSTS = new Set(["www.threads.com", "threads.com", "www.threads.net", "threads.net"]);

export const MAX_REDIRECTS = 5;

/** `/@{username}/post/{code}` on a Threads host; the username may be empty on login-only posts. */
export const POST_PATH = /^\/(?:@|%40)([A-Za-z0-9._]*)\/post\/([A-Za-z0-9_-]+)\/?$/;

export function isThreadsUrl(url: URL): boolean {
  return url.protocol === "https:" && THREADS_HOSTS.has(url.hostname);
}

export function parseUrl(value: string, base?: URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** Extracts username and code from a Threads post URL; null for anything else. */
export function parsePostUrl(value: string, base?: URL): { username: string; code: string } | null {
  const url = parseUrl(value, base);
  if (!url || !isThreadsUrl(url)) {
    return null;
  }
  const match = POST_PATH.exec(url.pathname);
  return match ? { username: match[1], code: match[2] } : null;
}

export function threadsGet(url: string, userAgent: string = USER_AGENT): Promise<Response> {
  return fetch(url, { redirect: "manual", headers: { "user-agent": userAgent } });
}

export type FollowResult =
  | { kind: "response"; response: Response; url: URL }
  | { kind: "redirect_rejected"; httpStatus: number };

/** GET that follows at most `MAX_REDIRECTS` redirects, all of them on Threads hosts. */
export async function getFollowingThreads(start: URL, userAgent: string = USER_AGENT): Promise<FollowResult> {
  let current = start;
  for (let hop = 0; ; hop += 1) {
    const response = await threadsGet(current.href, userAgent);
    if (response.status < 300 || response.status >= 400) {
      return { kind: "response", response, url: current };
    }
    await response.body?.cancel();
    const location = response.headers.get("location");
    const next = location ? parseUrl(location, current) : null;
    if (!next || !isThreadsUrl(next) || hop >= MAX_REDIRECTS) {
      return { kind: "redirect_rejected", httpStatus: response.status };
    }
    current = next;
  }
}

/** Status codes that say "try again later" rather than anything about the post. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
