import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import ogPublic from "./fixtures/og-public.html?raw";
import reply from "./fixtures/reply.html?raw";
import text from "./fixtures/text.html?raw";
import unavailable from "./fixtures/unavailable.html?raw";
import video from "./fixtures/video.html?raw";
import { html, redirect, stubFetch } from "./stub";

// Cache API 的內容在測試之間會留著，所以每個測試用不同的貼文代碼。
let counter = 0;
function uniqueCode(): string {
  counter += 1;
  return `Test${counter}${Date.now().toString(36)}`;
}

function get(path: string, init?: RequestInit, host = "proxy.example"): Promise<Response> {
  return exports.default.fetch(`https://${host}${path}`, init);
}

function componentEmbed(page: string): { component: { components: Array<Record<string, any>> } } {
  const script = page.match(/<script id="discord:component-embed" type="application\/json">([^<]*)<\/script>/);
  expect(script).not.toBeNull();
  return JSON.parse(script![1]);
}

// Threads 還不寫 D1，所以不 reset：reset 會清掉 Cache API 的儲存，跟 waitUntil 裡的快取寫入互相衝突。
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("threads posts", () => {
  it("serves a public post from the embed page without forwarding the query", async () => {
    const code = uniqueCode();
    const calls = stubFetch(() => html(text));
    const response = await get(`/@zuck/post/${code}?xmt=tracking`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(calls.map((call) => call.url)).toEqual([`https://www.threads.com/t/${code}/embed`]);
    expect(page).toContain('<html lang="zh-Hant">');
    expect(page).toContain('<meta property="og:title" content="@zuck">');
    expect(page).toContain('<meta property="og:site_name" content="Threads">');
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/@zuck/post/${code}">`);
    expect(page).toContain("@zuck · Threads — We&#39;re bringing post insights");
    expect(page).toContain(`<meta http-equiv="refresh" content="0; url=https://www.threads.com/@zuck/post/${code}">`);
    expect(page).toContain("前往 Threads 原文");
    expect(page).not.toContain("tracking");

    const parts = componentEmbed(page).component.components;
    expect(parts[0].content).toBe(
      "## \\@zuck\n-# Threads\n\nWe're bringing post insights and the ability to save multiple drafts to Threads on web. The option to schedule posts is coming soon too.",
    );
    expect(parts[1].components[0].url).toBe(`https://www.threads.com/@zuck/post/${code}`);
  });

  it("answers the second request from the cache", async () => {
    const code = uniqueCode();
    const calls = stubFetch(() => html(text));
    await (await get(`/t/${code}`)).text();
    const second = await get(`/t/${code}/`);

    expect(second.status).toBe(200);
    expect(await second.text()).toContain("@zuck");
    expect(calls).toHaveLength(1);
  });

  it("renders video tags and the reply parent", async () => {
    stubFetch(() => html(video));
    const videoPage = await (await get(`/t/${uniqueCode()}`)).text();
    expect(videoPage).toContain('<meta name="twitter:card" content="player">');
    expect(videoPage).toMatch(/<meta property="og:video" content="https:\/\/[^"]+\.fbcdn\.net\//);
    expect(videoPage).toContain('<meta property="og:video:type" content="video/mp4">');
    expect(videoPage).not.toContain("og:image");
    expect(componentEmbed(videoPage).component.components[1].items).toHaveLength(1);

    stubFetch(() => html(reply));
    const replyPage = await (await get(`/t/${uniqueCode()}`)).text();
    const content = componentEmbed(replyPage).component.components[0].content as string;
    expect(content).toContain("-# 回覆 \\@zuck\n> Workflows can break out a task");
    expect(content).toContain("\n\nThere's an SDK in developer preview");
  });

  it("falls back to the og fetcher when the embed page is unusable", async () => {
    const code = uniqueCode();
    const calls = stubFetch((url) => (url.endsWith("/embed") ? html("", 500) : html(ogPublic)));
    const page = await (await get(`/@mosseri/post/${code}`)).text();

    expect(calls.map((call) => call.url)).toEqual([
      `https://www.threads.com/t/${code}/embed`,
      `https://www.threads.com/@mosseri/post/${code}`,
    ]);
    expect(page).toContain('<meta property="og:title" content="@mosseri">');
    expect(page).toContain("Adam Mosseri (@mosseri) · Threads");
  });

  it("falls back when a fetcher throws, and logs the fetcher", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => {
      if (url.endsWith("/embed")) {
        throw new Error("network down");
      }
      return html(ogPublic);
    });
    const response = await get(`/@mosseri/post/${uniqueCode()}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("@mosseri");
    errorSpy.mockRestore();
  });

  it("resolves share links and shows the login card for unavailable posts", async () => {
    const shareCode = uniqueCode();
    const calls = stubFetch((url) => {
      if (url.includes("/share/")) {
        return redirect("https://www.threads.com/@someone/post/Dd_vHLcCfNB?xmt=abc");
      }
      return url.endsWith("/embed") ? html(unavailable) : html("<html><head></head><body></body></html>");
    });
    const response = await get(`/share/${shareCode}`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(calls[0].url).toBe(`https://www.threads.com/share/${shareCode}/`);
    expect(calls[1].url).toBe("https://www.threads.com/t/Dd_vHLcCfNB/embed");
    expect(page).toContain("需登入的貼文");
    expect(page).toContain("也可能是私人帳號或已刪除");
    expect(page).toContain('<meta property="og:site_name" content="ebfix">');
    expect(page).toContain('<meta property="og:url" content="https://proxy.example/@someone/post/Dd_vHLcCfNB">');
    expect(page).not.toContain("xmt");
    // 抓不到內容時絕不用 HTTP 轉址回 Threads。
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns a 503 card that is never cached when every fetcher fails", async () => {
    const code = uniqueCode();
    const calls = stubFetch(() => html("", 429));
    const first = await get(`/t/${code}`);

    expect(first.status).toBe(503);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.text()).toContain("暫時無法取得預覽");

    await (await get(`/t/${code}`)).text();
    expect(calls).toHaveLength(4);
  });

  it("answers HEAD without a body", async () => {
    stubFetch(() => html(text));
    const response = await get(`/t/${uniqueCode()}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("threads storage", () => {
  it("stores public posts and serves them after they become unavailable", async () => {
    const code = uniqueCode();
    stubFetch(() => html(text));
    await (await get(`/t/${code}`)).text();

    const row = await env.DB.prepare(
      "SELECT last_status, last_fetcher, source_url FROM posts WHERE platform = 'threads' AND post_key = ?",
    )
      .bind(code)
      .first();
    expect(row).toEqual({ last_status: "public", last_fetcher: "embed", source_url: `https://www.threads.com/t/${code}` });

    // 換一條路徑避開 Cache API，post_key 仍是同一個代碼。
    stubFetch((url) => (url.endsWith("/embed") ? html(unavailable) : html("<html><head></head><body></body></html>")));
    const response = await get(`/@zuck/post/${code}`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain("We&#39;re bringing post insights");
    expect(page).not.toContain("需登入的貼文");
    const state = await env.DB.prepare("SELECT last_status FROM posts WHERE platform = 'threads' AND post_key = ?")
      .bind(code)
      .first();
    expect(state).toEqual({ last_status: "login_required" });
  });

  it("does not store share links that never resolved", async () => {
    const shareCode = uniqueCode();
    stubFetch(() => html("<html><head><title>Threads</title></head><body></body></html>"));
    const response = await get(`/share/${shareCode}`);

    expect(response.status).toBe(503);
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE post_key LIKE ?")
      .bind(`%${shareCode}%`)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
});

describe("routing by host", () => {
  it("keeps the legacy Naver domain Naver-only", async () => {
    const calls = stubFetch(() => html(text));
    const response = await get("/@zuck/post/C-srcchPpp7", undefined, "naver.konnokai.me");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects Threads-like paths that are not post links", async () => {
    const calls = stubFetch(() => html(text));

    expect((await get("/@zuck")).status).toBe(400);
    expect((await get("/@zuck/post/")).status).toBe(400);
    expect((await get("/@/post/C-srcchPpp7")).status).toBe(400);
    expect((await get("/t/abc/extra")).status).toBe(400);
    expect((await get("/share/a.b")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
