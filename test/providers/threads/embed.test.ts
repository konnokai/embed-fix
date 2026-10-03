import { afterEach, describe, expect, it, vi } from "vitest";
import { embedFetcher } from "../../../src/providers/threads/embed";
import { USER_AGENT } from "../../../src/providers/threads/http";
import carousel from "./fixtures/carousel.html?raw";
import image from "./fixtures/image.html?raw";
import link from "./fixtures/link.html?raw";
import quote from "./fixtures/quote.html?raw";
import reply from "./fixtures/reply.html?raw";
import sticker from "./fixtures/sticker.html?raw";
import text from "./fixtures/text.html?raw";
import topicTag from "./fixtures/topic-tag.html?raw";
import topic from "./fixtures/topic.html?raw";
import unavailable from "./fixtures/unavailable.html?raw";
import video from "./fixtures/video.html?raw";
import { html, redirect, stubFetch } from "./stub";

const ref = { key: "C-srcchPpp7", params: { username: "zuck", code: "C-srcchPpp7" } };

async function run(body: string) {
  stubFetch(() => html(body));
  return embedFetcher.run(ref, {} as Env);
}

async function publicPost(body: string) {
  const result = await run(body);
  if (result.kind !== "public") {
    throw new Error(`expected public, got ${JSON.stringify(result)}`);
  }
  return result.post;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embed fetcher request", () => {
  it("asks /t/{code}/embed with a User-Agent, no cookies and no redirects", async () => {
    const calls = stubFetch(() => html(text));
    await embedFetcher.run(ref, {} as Env);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.threads.com/t/C-srcchPpp7/embed");
    expect(calls[0].init).toEqual({ redirect: "manual", headers: { "user-agent": USER_AGENT } });
  });
});

describe("embed page parsing (fixtures captured 2026-10-03)", () => {
  it("reads a text post", async () => {
    const post = await publicPost(text);

    expect(post.title).toBe("@zuck");
    expect(post.siteName).toBe("Threads");
    expect(post.author.handle).toBe("zuck");
    expect(post.author.verified).toBe(true);
    expect(post.author.avatar).toMatch(/^https:\/\/scontent\.cdninstagram\.com\//);
    expect(post.author.avatar).not.toContain("&amp;");
    expect(post.text).toBe(
      "We're bringing post insights and the ability to save multiple drafts to Threads on web. The option to schedule posts is coming soon too.",
    );
    expect(post.media).toEqual([]);
    expect(post.author.url).toBe("https://www.threads.com/@zuck");
    // embed 頁顯示 "9:58 AM · Aug 15, 2024"（太平洋時間），由貼文代碼算出。
    expect(post.createdAt).toBe("2024-08-15T16:58:07.259Z");
    expect(post.replyTo).toBeUndefined();
    expect(post.quoted).toBeUndefined();
  });

  it("reads a single image", async () => {
    const post = await publicPost(image);

    expect(post.author.handle).toBe("mosseri");
    expect(post.text).toBe("");
    expect(post.media).toHaveLength(1);
    expect(post.media[0].kind).toBe("image");
    expect(post.media[0].url).toMatch(/^https:\/\/scontent\.cdninstagram\.com\/v\/t51\.82787-15\//);
  });

  it("reads a single video", async () => {
    const post = await publicPost(video);

    expect(post.media).toHaveLength(1);
    expect(post.media[0].kind).toBe("video");
    expect(post.media[0].url).toMatch(/^https:\/\/[^/]+\.fbcdn\.net\//);
  });

  it("reads a carousel in order with mixed media and keeps line breaks", async () => {
    const post = await publicPost(carousel);

    expect(post.media.map((item) => item.kind)).toEqual([
      "image",
      "image",
      "image",
      "video",
      "image",
      "image",
      "image",
    ]);
    expect(post.text.startsWith("#photodump from a recent weekend")).toBe(true);
    expect(post.text).toContain("\n\nSnake!");
  });

  it("reads the quoted post handle without mixing it into the main post", async () => {
    const post = await publicPost(quote);

    expect(post.author.handle).toBe("mosseri");
    expect(post.text.startsWith("Excited about this launch.")).toBe(true);
    // 引用貼文的內文由 script 填入，HTML 裡只有帳號。
    expect(post.quoted).toEqual({ handle: "zuck", text: "", media: [] });
    expect(post.author.avatar).not.toBe(undefined);
  });

  it("takes the last block as the post and the block before as its parent", async () => {
    const post = await publicPost(reply);

    expect(post.text.startsWith("There's an SDK in developer preview")).toBe(true);
    expect(post.media).toEqual([]);
    expect(post.replyTo?.handle).toBe("zuck");
    expect(post.replyTo?.text.startsWith("Workflows can break out a task")).toBe(true);
    expect(post.replyTo?.text).not.toContain("Replying to");
  });

  it("keeps link text and ignores link-card favicons", async () => {
    const post = await publicPost(link);

    expect(post.text).toContain("meta.com/thefu…");
    expect(post.media).toEqual([]);
  });

  it("reads a community tag without taking it as the author", async () => {
    const post = await publicPost(topicTag);

    expect(post.author.handle).toBe("threads");
    expect(post.topic).toBe("Dating Threads");
    expect(post.text).not.toContain("Dating Threads");
    expect(post.media).toEqual([]);
  });

  it("reads a plain topic tag and drops the object placeholder from the text", async () => {
    const post = await publicPost(topic);

    expect(post.author.handle).toBe("threads");
    expect(post.topic).toBe("明日方舟");
    expect(post.text).toBe("想問有沒有會解釋關卡機制的攻略\n有點玩上癮了");
  });

  it("leaves the topic out when the post has none", async () => {
    expect((await publicPost(text)).topic).toBeUndefined();
  });

  it("reads the action bar counts in icon order and skips empty ones", async () => {
    expect((await publicPost(text)).stats).toEqual({ likes: "5.9K", replies: "1K", reposts: "439", shares: "81" });
    // 數量為 0 的圖示沒有 ActionBarCount。
    expect((await publicPost(image)).stats).toBeUndefined();
  });

  it("keeps the quoted post's counts out of the main post", async () => {
    expect((await publicPost(quote)).stats).toEqual({ likes: "233", replies: "149", reposts: "32", shares: "13" });
  });

  it("drops inline stickers", async () => {
    const post = await publicPost(sticker);

    expect(post.media).toEqual([]);
    expect(JSON.stringify(post)).not.toContain("giphy");
  });
});

describe("embed fetcher outcomes", () => {
  it("treats 'Thread not available' as login required", async () => {
    expect(await run(unavailable)).toEqual({
      kind: "login_required",
      httpStatus: 200,
      errorCode: "thread_not_available",
    });
  });

  it("treats an unknown page structure as transient, not public", async () => {
    expect(await run("<!DOCTYPE html><html><body><div class=\"Embed\">changed</div></body></html>")).toEqual({
      kind: "transient",
      httpStatus: 200,
      errorCode: "embed_unparsed",
    });
  });

  it("treats rate limits, server errors and redirects as transient", async () => {
    stubFetch(() => html("", 429));
    expect(await embedFetcher.run(ref, {} as Env)).toEqual({ kind: "transient", httpStatus: 429, errorCode: null });

    stubFetch(() => html("", 503));
    expect((await embedFetcher.run(ref, {} as Env)).kind).toBe("transient");

    stubFetch(() => redirect("https://www.facebook.com/unsupportedbrowser"));
    expect(await embedFetcher.run(ref, {} as Env)).toEqual({ kind: "transient", httpStatus: 302, errorCode: "redirect" });
  });

  it("treats a 404 as not found", async () => {
    stubFetch(() => html("", 404));
    expect((await embedFetcher.run(ref, {} as Env)).kind).toBe("not_found");
  });
});
