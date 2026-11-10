import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../../../src/core/http";
import { profileFetcher } from "../../../src/providers/threads/profile";
import embedPage from "./fixtures/profile-embed.html?raw";
import embedPageZh from "./fixtures/profile-embed-zh.html?raw";
import ogPage from "./fixtures/profile-og.html?raw";
import ogPageZh from "./fixtures/profile-og-zh.html?raw";
import unavailable from "./fixtures/profile-unavailable.html?raw";
import { html, stubFetch } from "./stub";

const ref = { key: "profile:margaret_inthebox", params: { username: "margaret_inthebox" } };

/** `/embed` 回傳嵌入頁，其他請求（貼文頁）回傳 og 標籤。 */
async function run(embed: string, og = ogPage) {
  const calls = stubFetch((url) => (url.endsWith("/embed") ? html(embed) : html(og)));
  const result = await profileFetcher.run(ref, {} as Env);
  return { result, calls };
}

async function publicPost(embed: string, og?: string) {
  const { result } = await run(embed, og);
  if (result.kind !== "public") {
    throw new Error(`expected public, got ${JSON.stringify(result)}`);
  }
  return result.post;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("profile fetcher request", () => {
  it("asks the embed page and the profile page with a User-Agent, no cookies and no redirects", async () => {
    const { calls } = await run(embedPage);

    expect(calls.map((call) => call.url)).toEqual([
      "https://www.threads.com/@margaret_inthebox/embed",
      "https://www.threads.com/@margaret_inthebox",
    ]);
    expect(calls[0].init).toEqual({ redirect: "manual", headers: { "user-agent": USER_AGENT } });
  });
});

describe("profile page parsing (fixtures captured 2026-11-10)", () => {
  it("reads the name, handle, avatar, bio, link in bio and both counts", async () => {
    const post = await publicPost(embedPage);

    expect(post.title).toBe("瑪格麗特。諾爾絲");
    expect(post.siteName).toBe("Threads");
    // 顯示名稱放在標題，作者那行只留 @handle。
    expect(post.author.name).toBe("");
    expect(post.author.handle).toBe("margaret_inthebox");
    expect(post.author.url).toBe("https://www.threads.com/@margaret_inthebox");
    expect(post.author.avatar).toMatch(/^https:\/\/scontent\.cdninstagram\.com\//);
    expect(post.author.avatar).not.toContain("&amp;");
    expect(post.text).toBe("來自西方的北極狐魔女🌼\n不是調酒🍸也不是披薩🍕");
    expect(post.media).toEqual([]);
    expect(post.createdAt).toBeNull();
    // 連結在 bio 裡包了一層 l.facebook.com/l.php。
    expect(post.links).toEqual([
      { label: "youtu.be/WwduRhc_PZE?si=9VFtWExZ3N6a_3WU", url: "https://youtu.be/WwduRhc_PZE?si=9VFtWExZ3N6a_3WU" },
    ]);
    expect(post.stats).toEqual({ followers: "26.0K", threads: "294" });
  });

  it("keeps the profile when the profile page does not answer, without the thread count", async () => {
    const post = await publicPost(embedPage, "");

    expect(post.stats).toEqual({ followers: "26.0K" });
    expect(post.text).toContain("北極狐魔女");
  });

  it("reads the localized counters of a Chinese profile page", async () => {
    const post = await publicPost(embedPageZh, ogPageZh);

    // 嵌入頁的中文是「26.0K 位追蹤者」，貼文頁是「2.6 萬位粉絲 • 294 則串文」。
    expect(post.stats).toEqual({ followers: "26.0K", threads: "294" });
  });

  it("leaves the thread count out when the description does not name the counter", async () => {
    const post = await publicPost(embedPage, '<html><head><meta property="og:description" content="26.0K Followers • 2026 台北遊記。查看 @margaret_inthebox 參與的最新對話。" /></head></html>');

    expect(post.stats).toEqual({ followers: "26.0K" });
  });

  it("treats a missing profile as unavailable", async () => {
    const { result } = await run(unavailable);

    expect(result).toEqual({ kind: "login_required", httpStatus: 200, errorCode: "profile_not_available" });
  });
});
