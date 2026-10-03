/**
 * Link-preview proxy for several platforms (ebfix).
 *
 * A request whose path matches a supported post URL is answered with a single
 * HTML document that carries Open Graph metadata and a Discord Components V2
 * payload, so a chat client can build a preview from the raw response without
 * running scripts. The path is the platform's own; users only swap the domain.
 */

import { readCache, writeCache } from "./core/cache";
import { runHealthChecks } from "./core/health";
import { announceDeploy } from "./core/notify";
import { servePost } from "./core/pipeline";
import { PROVIDERS, route } from "./router";

function htmlResponse(html: string, status: number, cacheTtl: number): Response {
  const headers = new Headers({ "content-type": "text/html;charset=UTF-8" });
  if (status >= 400) {
    // Keep error cards out of long-lived caches on both sides.
    headers.set("cache-control", "no-store");
  } else if (cacheTtl > 0) {
    headers.set("cache-control", `public, max-age=${cacheTtl}`);
  }
  return new Response(html, { status, headers });
}

// 每個 isolate 只檢查一次部署通知，之後的請求不再碰 D1。
let deployChecked = false;

function withoutBody(response: Response): Response {
  return new Response(null, { status: response.status, headers: response.headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!deployChecked) {
      deployChecked = true;
      ctx.waitUntil(announceDeploy(env));
    }
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      return htmlResponse(
        "<!DOCTYPE html><html lang=\"zh-Hant\"><body><p>不支援的請求方法。</p></body></html>",
        405,
        0,
      );
    }

    const url = new URL(request.url);
    const routed = route(url);
    if (!routed) {
      // Invalid paths never reach any upstream.
      const response = htmlResponse(
        "<!DOCTYPE html><html lang=\"zh-Hant\"><body><p>不支援的網址格式。</p></body></html>",
        400,
        0,
      );
      return isHead ? withoutBody(response) : response;
    }

    const { provider, ref } = routed;
    // The query string (for example Threads' `xmt` tracking) is never forwarded or cached.
    const cacheUrl = `${url.origin}${provider.canonicalPath(ref)}`;
    const cacheable = provider.cacheTtl.post > 0 || provider.cacheTtl.status > 0;
    if (cacheable) {
      const cached = await readCache(cacheUrl);
      if (cached) {
        return isHead ? withoutBody(cached) : cached;
      }
    }

    const page = await servePost(provider, ref, url.origin, env);
    const response = htmlResponse(page.html, page.status, page.cacheTtl);
    if (page.status === 200 && page.cacheTtl > 0) {
      ctx.waitUntil(writeCache(cacheUrl, response.clone()));
    }
    return isHead ? withoutBody(response) : response;
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await Promise.all([runHealthChecks(PROVIDERS, env), announceDeploy(env)]);
  },
} satisfies ExportedHandler<Env>;
