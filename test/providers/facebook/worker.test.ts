import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, redirect, stubFetch } from "../threads/stub";
import ogGroup from "./fixtures/og-group.html?raw";
import multiImage from "./fixtures/plugin-multi-image.html?raw";
import unavailable from "./fixtures/plugin-unavailable.html?raw";
import video from "./fixtures/plugin-video.html?raw";

// Cache API 的內容在測試之間會留著，所以每個測試用不同的貼文 ID。
let counter = 0;
function uniqueId(): string {
  counter += 1;
  return `${Date.now()}${counter}`;
}

function get(path: string, host = "proxy.example"): Promise<Response> {
  return exports.default.fetch(`https://${host}${path}`);
}

function componentEmbed(page: string): { component: { components: Array<Record<string, any>> } } {
  const script = page.match(/<script id="discord:component-embed" type="application\/json">([^<]*)<\/script>/);
  expect(script).not.toBeNull();
  return JSON.parse(script![1]);
}

const isPlugin = (url: string) => url.startsWith("https://www.facebook.com/plugins/post.php");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("facebook posts", () => {
  it("serves a public post from the plugin without forwarding tracking parameters", async () => {
    const id = uniqueId();
    const calls = stubFetch(() => html(multiImage));
    const response = await get(`/NASA/posts/${id}?mibextid=tracking&rdid=abc`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(calls.map((call) => call.url)).toEqual([
      `https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2FNASA%2Fposts%2F${id}&locale=en_US`,
    ]);
    expect(page).toContain('<meta property="og:title" content="NASA - National Aeronautics and Space Administration">');
    expect(page).toContain('<meta property="og:site_name" content="Facebook">');
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/NASA/posts/${id}">`);
    expect(page).toContain(`<meta http-equiv="refresh" content="0; url=https://www.facebook.com/NASA/posts/${id}">`);
    expect(page).toContain("前往 Facebook 原文");
    expect(page).not.toContain("tracking");

    const parts = componentEmbed(page).component.components;
    expect(parts.map((part) => part.type)).toEqual([9, 12, 14, 10, 1]);
    expect(parts[0].components[0].content).toMatch(
      /^## NASA - National Aeronautics and Space Administration\n-# Facebook\n\nOur photographers/,
    );
    expect(parts[1].items).toHaveLength(4);
    expect(parts[3].content).toBe("❤️ 18K · 💬 301 · <t:1786645039:f>");
    expect(parts[4].components).toEqual([
      { type: 2, style: 5, label: "原貼文", url: `https://www.facebook.com/NASA/posts/${id}` },
    ]);
  });

  it("renders a video post with video tags", async () => {
    stubFetch(() => html(video));
    const page = await (await get(`/reel/${uniqueId()}`)).text();

    expect(page).toContain('<meta name="twitter:card" content="player">');
    expect(page).toMatch(/<meta property="og:video" content="https:\/\/video\.xx\.fbcdn\.net\//);
    expect(page).not.toContain("og:image");
  });

  it("falls back to the og tags when the plugin says the post is unavailable", async () => {
    const group = uniqueId();
    const calls = stubFetch((url) => (isPlugin(url) ? html(unavailable) : html(ogGroup)));
    const response = await get(`/groups/${group}/posts/1796616717956421/`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`https://www.facebook.com/groups/${group}/posts/1796616717956421/`);
    expect(page).toContain("Le point faible de chaque anime");
    expect(page).toContain('<meta property="og:title" content="Anime sama 🇨🇵/🇯🇵">');

    const row = await env.DB.prepare("SELECT last_status, last_fetcher FROM posts WHERE platform = 'facebook' AND post_key = ?")
      .bind(`group:${group}/1796616717956421`)
      .first();
    expect(row).toEqual({ last_status: "public", last_fetcher: "og" });
  });

  it("serves a group feed link with multi_permalinks as that group post", async () => {
    const group = uniqueId();
    const calls = stubFetch((url) => (isPlugin(url) ? html(unavailable) : html(ogGroup)));
    const response = await get(`/groups/${group}/?multi_permalinks=1796616717956421&hoisted_section_header_type=recently_seen`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(calls[1].url).toBe(`https://www.facebook.com/groups/${group}/posts/1796616717956421/`);
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/groups/${group}/posts/1796616717956421/">`);
    expect(page).not.toContain("hoisted_section_header_type");
  });

  it("shows the login card when the plugin refuses and the page needs a login", async () => {
    const id = uniqueId();
    stubFetch((url) => (isPlugin(url) ? html(unavailable) : redirect("https://www.facebook.com/login/?next=x")));
    const response = await get(`/story.php?story_fbid=${id}&id=100`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(page).toContain("需登入的貼文");
    expect(page).toContain("需要登入 Facebook 才能查看");
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/story.php?story_fbid=${id}&amp;id=100">`);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns a 503 card when Facebook is unreachable", async () => {
    stubFetch(() => html("", 500));
    const response = await get(`/zuck/videos/${uniqueId()}/`);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("facebook routing", () => {
  it("leaves /share/ links to Threads on the shared domain", async () => {
    const calls = stubFetch(() => html("", 500));
    await (await get(`/share/${uniqueId()}`)).text();

    expect(calls[0].url).toMatch(/^https:\/\/www\.threads\.com\/share\//);
  });

  it("serves /share/p/, /share/r/ and /share/v/ on the shared domain", async () => {
    const id = uniqueId();
    const calls = stubFetch((url) => (isPlugin(url) ? html(video) : redirect(`https://m.facebook.com/reel/${id}/?rdid=x`)));
    const response = await get(`/share/r/${uniqueId()}/`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(calls[0].url).toMatch(/^https:\/\/m\.facebook\.com\/share\/r\//);
    expect(calls[1].url).toBe(
      `https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F${id}%2F&locale=en_US`,
    );
    expect(page).toContain(`<meta property="og:url" content="https://proxy.example/reel/${id}/">`);
    expect(page).not.toContain("rdid");
  });

  it("gives /share/{hash} to Facebook on fb.ebfix.konnokai.me and serves nothing else there", async () => {
    const id = uniqueId();
    const calls = stubFetch((url) => (isPlugin(url) ? html(multiImage) : redirect(`https://m.facebook.com/NASA/posts/${id}`)));
    const response = await get(`/share/${uniqueId()}/`, "fb.ebfix.konnokai.me");

    expect(response.status).toBe(200);
    expect(calls[0].url).toMatch(/^https:\/\/m\.facebook\.com\/share\//);
    expect(await response.text()).toContain(`<meta property="og:url" content="https://fb.ebfix.konnokai.me/NASA/posts/${id}">`);

    const threadsCalls = stubFetch(() => html(""));
    expect((await get("/@zuck/post/C-srcchPpp7", "fb.ebfix.konnokai.me")).status).toBe(400);
    expect(threadsCalls).toHaveLength(0);
  });

  it("shows the unsupported card for shared events without storing anything", async () => {
    const share = uniqueId();
    stubFetch(() => redirect("https://m.facebook.com/events/s/party/3974856429449647/"));
    const response = await get(`/share/p/${share}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("不支援的內容");
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE post_key LIKE ?")
      .bind(`%${share}%`)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("is not served on the legacy Naver domain", async () => {
    const calls = stubFetch(() => html(multiImage));
    const response = await get("/NASA/posts/1602283071267063", "cafe.konnokai.me");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
