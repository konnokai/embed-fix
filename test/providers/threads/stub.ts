import { vi } from "vitest";

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Handler = (url: string, call: number) => Response | Promise<Response>;

/** Replaces global fetch; every upstream request is recorded with its init. */
export function stubFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, calls.length);
  });
  return calls;
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}
