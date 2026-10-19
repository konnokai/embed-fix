import { afterEach, describe, expect, it, vi } from "vitest";
import { ogFetcher } from "../../../src/providers/facebook/og";
import { html, redirect, stubFetch } from "../threads/stub";
import ogGroup from "./fixtures/og-group.html?raw";
import ogGroupText from "./fixtures/og-group-text.html?raw";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("og fetcher (www pages captured 2026-10-03 from Cloudflare)", () => {
  it("reads a public group post: group name, text excerpt and one image", async () => {
    const calls = stubFetch(() => html(ogGroup));
    const result = await ogFetcher.run(groupRef, {} as Env);

    expect(calls.map((call) => call.url)).toEqual(["https://www.facebook.com/groups/1495321534752609/posts/1796616717956421/"]);
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
