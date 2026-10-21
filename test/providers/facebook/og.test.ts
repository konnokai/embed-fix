import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../../../src/core/http";
import { ogFetcher } from "../../../src/providers/facebook/og";
import { type Call, html, redirect, stubFetch } from "../threads/stub";
import ogGroup from "./fixtures/og-group.html?raw";
import ogGroupText from "./fixtures/og-group-text.html?raw";
import ogGroupHome from "./fixtures/og-group-home.html?raw";
import ogPage from "./fixtures/og-page.html?raw";
import ogProfile from "./fixtures/og-profile.html?raw";
import ogReel from "./fixtures/og-reel.html?raw";
import wwwLogin from "./fixtures/www-login.html?raw";

const groupRef = {
  key: "group:1495321534752609/1796616717956421",
  params: { path: "/groups/1495321534752609/posts/1796616717956421/" },
};
const textGroupRef = {
  key: "group:313398198123340/1089976933798792",
  params: { path: "/groups/313398198123340/posts/1089976933798792/" },
};
const videoRef = { key: "video:2300161320399228", params: { path: "/reel/2300161320399228" } };

const userAgent = (call: Call) => (call.init?.headers as Record<string, string>)["user-agent"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("og fetcher (www pages captured 2026-10-03 from Cloudflare)", () => {
  it("reads a public group post: group name, text excerpt and one image", async () => {
    const calls = stubFetch(() => html(ogGroup));
    const result = await ogFetcher.run(groupRef, {} as Env);

    expect(calls.map((call) => call.url)).toEqual(["https://www.facebook.com/groups/1495321534752609/posts/1796616717956421/"]);
    expect(userAgent(calls[0])).toBe(USER_AGENT);
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("Anime sama 🇨🇵/🇯🇵");
    expect(result.post.author).toEqual({ name: "Anime sama 🇨🇵/🇯🇵" });
    expect(result.post.text).toBe("Le point faible de chaque anime");
    expect(result.post.media).toHaveLength(1);
    expect(result.post.media[0].url).toMatch(/^https:\/\/scontent-sin2-1\.xx\.fbcdn\.net\/.*&ccb=1-7&/);
    expect(result.post.createdAt).toBeNull();
  });

  it("names a group post after the group and drops the group banner of a text-only post", async () => {
    // 2026-10-19 本機台灣 IP 抓的頁，不是 Cloudflare 出口：只留 og 標籤、<title> 和有 group_name 的那段 JSON。
    // og:title 只剩內文第一行，社團名要從 group_name 拿；og:image 是社團 banner。
    stubFetch(() => html(ogGroupText));
    const result = await ogFetcher.run(textGroupRef, {} as Env);

    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("COAT CLUB 微要素串");
    expect(result.post.author).toEqual({ name: "COAT CLUB 微要素串" });
    expect(result.post.media).toEqual([]);
  });

  it("keeps a group post's own image and falls back to the page title for the group name", async () => {
    // 圖片檔名跟社團 banner 不同，就是貼文自己的圖。
    stubFetch(() => html(ogGroupText.replace(/"group_image_url":"[^"]*"/, '"group_image_url":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/other_n.jpg"')));
    const own = await ogFetcher.run(textGroupRef, {} as Env);
    expect(own.kind === "public" && own.post.media).toHaveLength(1);

    stubFetch(() => html(ogGroupText.replace(/"group_name":"[^"]*",/, "")));
    const fallback = await ogFetcher.run(textGroupRef, {} as Env);
    expect(fallback.kind === "public" && fallback.post.title).toBe("COAT CLUB 微要素串");
  });

  it("follows a redirect to the video page and takes the author from the end of the title", async () => {
    const calls = stubFetch((url) =>
      url.includes("/reel/") ? redirect("https://www.facebook.com/zuck/videos/2300161320399228/") : html(ogReel),
    );
    const result = await ogFetcher.run(videoRef, {} as Env);

    expect(calls).toHaveLength(2);
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    // 影片的 og:title 是「觀看數 · 心情數 | 內文 | 作者」，作者在最後一段。
    expect(result.post.title).toBe("Mark Zuckerberg");
    expect(result.post.author.url).toBe("https://www.facebook.com/zuck");
    expect(result.post.text).toMatch(/^For our superintelligence effort, I'm focused/);
    expect(result.post.media[0].kind).toBe("image");
  });

  it("takes the author from the end of a full video title, never a numeric profile ID", async () => {
    // 2026-10-03 線上 /share/r/1D3piCezWh/ 轉到的 reel 的 og 標籤（只留標題和網址）。
    const head = (title: string) =>
      html(`<html><head><meta property="og:title" content="${title}" />
<meta property="og:url" content="https://www.facebook.com/17841401331580275/videos/786532990714237/" /></head></html>`);

    stubFetch(() => head("327K views &#xb7; 61K reactions | What do we think? &#x1f440;#anime | Katrina &#x9e97;&#x83ef;"));
    const full = await ogFetcher.run(videoRef, {} as Env);
    expect(full.kind === "public" && full.post.title).toBe("Katrina 麗華");

    stubFetch(() => head("327K views &#xb7; 61K reactions | What do we think..."));
    const short = await ogFetcher.run(videoRef, {} as Env);
    expect(short.kind === "public" && short.post.title).toBe("Facebook");
    expect(short.kind === "public" && short.post.author.url).toBe("https://www.facebook.com/17841401331580275");
  });

  it("follows profile.php to the profile's about page and reads its name, profile picture and bio", async () => {
    // 2026-10-21 本機台灣 IP 抓的 /zuck/ 頁，不是 Cloudflare 出口。出口抓 /zuck/ 會被導到登入頁，/zuck/about 不會。
    const calls = stubFetch((url) => (url.includes("profile.php") ? redirect("https://www.facebook.com/zuck/") : html(ogProfile)));
    const result = await ogFetcher.run({ key: "profile:4", params: { path: "/profile.php?id=4" } }, {} as Env);

    expect(calls.map((call) => call.url)).toEqual(["https://www.facebook.com/profile.php?id=4", "https://www.facebook.com/zuck/about"]);
    expect(calls.map(userAgent)).toEqual([USER_AGENT, USER_AGENT]);
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("Mark Zuckerberg");
    expect(result.post.author).toEqual({ name: "Mark Zuckerberg", url: "https://www.facebook.com/zuck" });
    expect(result.post.text).toBe("Bringing the world closer together.");
    expect(result.post.media).toHaveLength(1);
    expect(result.post.media[0].url).toMatch(/^https:\/\/scontent\.[a-z0-9.-]+\.fbcdn\.net\/v\/t39\.30808-1\//);
  });

  it("reads a page whose name ends with a period without leaking the counters into the bio", async () => {
    // 2026-10-21 本機台灣 IP 抓的粉專 /about 頁，不是 Cloudflare 出口。
    const calls = stubFetch(() => html(ogPage));
    const result = await ogFetcher.run(
      { key: "profile:CHUNITHM.International.ver", params: { path: "/CHUNITHM.International.ver" } },
      {} as Env,
    );

    expect(calls.map((call) => call.url)).toEqual(["https://www.facebook.com/CHUNITHM.International.ver/about"]);
    expect(userAgent(calls[0])).toBe(USER_AGENT);
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("CHUNITHM International ver.");
    expect(result.post.text).toMatch(/^CHUNITHM {2}is proudly presented by SEGA CORPORATION\./);
    expect(result.post.media).toHaveLength(1);
  });

  it("reads a group home page: name without the site suffix, description and cover image", async () => {
    // 2026-10-21 本機台灣 IP 用 Discordbot UA 抓的 m. 社團主頁。這張封面圖就是社團貼文會丟掉的 banner，主頁要留著。
    const calls = stubFetch(() => html(ogGroupHome));
    const result = await ogFetcher.run(
      { key: "group-home:313398198123340", params: { path: "/groups/313398198123340/" } },
      {} as Env,
    );

    expect(calls.map((call) => call.url)).toEqual(["https://m.facebook.com/groups/313398198123340/"]);
    expect(userAgent(calls[0])).toMatch(/Discordbot/);
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("COAT CLUB 微要素串");
    expect(result.post.author).toEqual({ name: "COAT CLUB 微要素串" });
    expect(result.post.text).toMatch(/^傳微要素違反迫真部規定/);
    expect(result.post.media).toHaveLength(1);
    expect(result.post.media[0].url).toContain("842331526_122180441558975330_1876734945724351989_n.jpg");
  });

  it("drops the sign-up text of a profile without a bio", async () => {
    // 2026-10-21 抓到的個人頁 og 標籤，名字換成假名。
    stubFetch(() =>
      html(`<html><head><meta property="og:title" content="Jane Doe" />
<meta property="og:description" content="Jane Doe is on Facebook. Join Facebook to connect with Jane Doe and others you may know. Facebook gives people the power to share and makes the world more open and connected." /></head></html>`),
    );
    const result = await ogFetcher.run({ key: "profile:100012345678901", params: { path: "/profile.php?id=100012345678901" } }, {} as Env);

    expect(result.kind === "public" && result.post.title).toBe("Jane Doe");
    expect(result.kind === "public" && result.post.text).toBe("");
  });

  it("does not turn a post redirected to its author's page into the page's about tab", async () => {
    const calls = stubFetch((url) => (url.includes("/reel/") ? redirect("https://www.facebook.com/NASA/") : html(wwwLogin)));
    await ogFetcher.run(videoRef, {} as Env);

    expect(calls.map((call) => call.url)).toEqual(["https://www.facebook.com/reel/2300161320399228", "https://www.facebook.com/NASA/"]);
  });

  it("stops at a login redirect without fetching the login page", async () => {
    const calls = stubFetch(() => redirect("https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fstory.php"));
    const result = await ogFetcher.run(videoRef, {} as Env);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ kind: "login_required", httpStatus: 302, errorCode: "login_redirect" });
  });

  it("treats the login page and a page without og tags as login required", async () => {
    stubFetch(() => html(wwwLogin));
    expect(await ogFetcher.run(videoRef, {} as Env)).toEqual({
      kind: "login_required",
      httpStatus: 200,
      errorCode: "login_page",
    });

    stubFetch(() => html("<html><head><title>Facebook</title></head><body></body></html>"));
    expect(await ogFetcher.run(videoRef, {} as Env)).toEqual({
      kind: "login_required",
      httpStatus: 200,
      errorCode: "og_missing",
    });
  });

  it("does not follow redirects off Facebook", async () => {
    const calls = stubFetch(() => redirect("https://evil.example/reel/1"));
    const result = await ogFetcher.run(videoRef, {} as Env);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ kind: "transient", httpStatus: 302, errorCode: "redirect_rejected" });
  });

  it("maps 404 and server errors", async () => {
    stubFetch(() => html("", 404));
    expect(await ogFetcher.run(videoRef, {} as Env)).toEqual({ kind: "not_found", httpStatus: 404, errorCode: null });

    stubFetch(() => html("", 503));
    expect(await ogFetcher.run(videoRef, {} as Env)).toEqual({ kind: "transient", httpStatus: 503, errorCode: null });
  });
});
