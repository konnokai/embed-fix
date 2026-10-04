import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, redirect, stubFetch } from "../threads/stub";
import broken from "./fixtures/embed-broken.html?raw";
import image from "./fixtures/embed-image.html?raw";
import video from "./fixtures/embed-video.html?raw";
import ogMissing from "./fixtures/og-missing.html?raw";
import ogPublic from "./fixtures/og-public.html?raw";

// Cache API 的內容在測試之間會留著，所以每個測試用不同的貼文代碼。
let counter = 0;
function uniqueCode(): string {
  counter += 1;
  return `Ig${counter}${Date.now().toString(36)}`;
}

function get(path: string, host = "proxy.example"): Promise<Response> {
  return exports.default.fetch(`https://${host}${path}`);
}

function componentEmbed(page: string): { component: { components: Array<Record<string, any>> } } {
  const script = page.match(/<script id="discord:component-embed" type="application\/json">([^<]*)<\/script>/);
  expect(script).not.toBeNull();
  return JSON.parse(script![1]);
}

const isEmbed = (url: string) => url.endsWith("/embed/captioned/");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instagram posts", () => {
  it("serves a single image from the embed page without forwarding the query", async () => {
    const code = uniqueCode();
    const calls = stubFetch(() => html(image));
    const response = await get(`/p/${code}/?igsh=tracking&img_index=1`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(calls.map((call) => call.url)).toEqual([`https://www.instagram.com/p/${code}/embed/captioned/`]);
    expect(page).toContain('<meta property="og:title" content="@nasa">');
    expect(page).toContain('<meta property="og:site_name" content="Instagram">');
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/p/${code}">`);
    expect(page).toContain("@nasa · Instagram — Some things are worth repeating");
    expect(page).toContain(`<meta http-equiv="refresh" content="0; url=https://www.instagram.com/p/${code}/">`);
    expect(page).toContain("前往 Instagram 原文");
    expect(page).not.toContain("tracking");

    const parts = componentEmbed(page).component.components;
    expect(parts.at(-1)?.components).toEqual([
      { type: 2, style: 5, label: "原貼文", url: `https://www.instagram.com/p/${code}/` },
      { type: 2, style: 5, label: "@nasa", url: "https://www.instagram.com/nasa/" },
    ]);

    const row = await env.DB.prepare("SELECT last_status, last_fetcher FROM posts WHERE platform = 'instagram' AND post_key = ?")
      .bind(code)
      .first();
    expect(row).toEqual({ last_status: "public", last_fetcher: "embed" });
  });

  it("renders a reel with video tags and keeps the username in the original link", async () => {
    const code = uniqueCode();
    // JSON 的 shortcode 要跟網址一致才會採用，所以把 fixture 裡的代碼換成這次的代碼。
    stubFetch(() => html(video.replaceAll("CuE2WNQs6vH", code)));
    const page = await (await get(`/google/reel/${code}/`)).text();

    expect(page).toContain('<meta name="twitter:card" content="player">');
    expect(page).toMatch(/<meta property="og:video" content="https:\/\/[a-z0-9.-]+\.(?:cdninstagram\.com|fbcdn\.net)\/o1\//);
    expect(page).toContain(`url=https://www.instagram.com/google/reel/${code}/`);
  });

  it("falls back to the og tags when the embed is broken", async () => {
    const code = uniqueCode();
    const calls = stubFetch((url) => (isEmbed(url) ? html(broken) : html(ogPublic)));
    const response = await get(`/reel/${code}`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      `https://www.instagram.com/p/${code}/embed/captioned/`,
      `https://www.instagram.com/reel/${code}/`,
    ]);
    expect(page).toContain("IKEA Taiwan (@ikea_taiwan) · Instagram — 記得喝水。");
  });

  it("shows the login card when the embed is broken and the page has no og tags", async () => {
    const code = uniqueCode();
    stubFetch((url) => (isEmbed(url) ? html(broken) : html(ogMissing)));
    const response = await get(`/p/${code}`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(page).toContain("需登入的貼文");
    expect(page).toContain("需要登入 Instagram 才能查看");
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns a 503 card when Instagram is unreachable", async () => {
    stubFetch(() => html("", 500));
    const response = await get(`/p/${uniqueCode()}`);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves a numeric /reel/ to Facebook on the shared domain", async () => {
    const calls = stubFetch(() => html("", 500));
    await (await get("/reel/2300161320399228")).text();

    expect(calls[0].url).toMatch(/^https:\/\/www\.facebook\.com\/plugins\/post\.php/);
  });

  it("resolves a share link on the shared domain and serves the post under its own URL", async () => {
    const code = uniqueCode();
    const share = uniqueCode();
    const calls = stubFetch((url) =>
      url.includes("/share/") ? redirect(`https://www.instagram.com/reel/${code}/?igsh=tracking`) : html(image),
    );
    const response = await get(`/share/reel/${share}`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      `https://www.instagram.com/share/reel/${share}/`,
      `https://www.instagram.com/p/${code}/embed/captioned/`,
    ]);
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/reel/${code}">`);
    expect(page).toContain(`url=https://www.instagram.com/reel/${code}/`);
    expect(page).not.toContain("tracking");
  });

  it("gives /share/p/ and /share/{hash} to Instagram on ig.ebfix.konnokai.me", async () => {
    const calls = stubFetch(() => html("", 500));
    await (await get(`/share/p/${uniqueCode()}/`, "ig.ebfix.konnokai.me")).text();
    await (await get(`/share/${uniqueCode()}`, "ig.ebfix.konnokai.me")).text();

    expect(calls.map((call) => new URL(call.url).hostname)).toEqual(["www.instagram.com", "www.instagram.com"]);
  });

  it("shows a 503 card that links back to the share URL when it cannot be resolved", async () => {
    const share = uniqueCode();
    stubFetch(() => html("<html><head><title>Instagram</title></head></html>"));
    const response = await get(`/share/reel/${share}`, "ig.ebfix.konnokai.me");
    const page = await response.text();

    expect(response.status).toBe(503);
    expect(page).toContain(`<meta property="og:url" content="https://ig.ebfix.konnokai.me/share/reel/${share}">`);
    expect(page).toContain(`https://www.instagram.com/share/reel/${share}/`);
  });

  it("is not served on the legacy Naver domain", async () => {
    const calls = stubFetch(() => html(image));
    const response = await get("/p/DdEy97xj9P-", "cafe.konnokai.me");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
