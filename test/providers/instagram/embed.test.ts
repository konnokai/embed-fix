import { afterEach, describe, expect, it, vi } from "vitest";
import { embedFetcher } from "../../../src/providers/instagram/embed";
import { USER_AGENT } from "../../../src/providers/threads/http";
import { html, stubFetch } from "../threads/stub";
import broken from "./fixtures/embed-broken.html?raw";
import image from "./fixtures/embed-image.html?raw";
import reelZh from "./fixtures/embed-reel-zh.html?raw";
import sidecar from "./fixtures/embed-sidecar.html?raw";
import video from "./fixtures/embed-video.html?raw";

function ref(code: string) {
  return { key: code, params: { code, kind: "p" } };
}

async function run(body: string, code: string, status = 200) {
  const calls = stubFetch(() => html(body, status));
  const result = await embedFetcher.run(ref(code), {} as Env);
  return { calls, result };
}

async function publicPost(body: string, code: string) {
  const { result } = await run(body, code);
  if (result.kind !== "public") {
    throw new Error(`expected public, got ${JSON.stringify(result)}`);
  }
  return result.post;
}

// 帶 accept-language 抓的頁面，媒體網址有些在 fbcdn.net。
const CDN = /^https:\/\/[a-z0-9.-]+\.(?:cdninstagram\.com|fbcdn\.net)\//;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instagram embed fetcher", () => {
  it("asks /p/{code}/embed/captioned/ in English, without cookies or redirects", async () => {
    const { calls } = await run(video, "CuE2WNQs6vH");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.instagram.com/p/CuE2WNQs6vH/embed/captioned/");
    expect(calls[0].init).toEqual({
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
    });
  });

  it("reads a video post from contextJSON", async () => {
    const post = await publicPost(video, "CuE2WNQs6vH");

    expect(post.title).toBe("@google");
    expect(post.siteName).toBe("Instagram");
    expect(post.author).toMatchObject({ name: "", handle: "google", verified: true, url: "https://www.instagram.com/google/" });
    expect(post.author.avatar).toMatch(CDN);
    expect(post.text).toMatch(/^Introducing Ballroom in Focus, the largest digital archive of Ballroom history/);
    expect(post.media).toHaveLength(1);
    expect(post.media[0].kind).toBe("video");
    expect(post.media[0].url).toMatch(CDN);
    expect(post.media[0].url).toMatch(/\/o1\/v\/.*\.mp4\?/);
    expect(post.media[0].width).toBeGreaterThan(0);
    expect(post.stats?.likes).toMatch(/^\d{1,3}(,\d{3})*$/);
    expect(post.stats?.replies).toMatch(/^\d{1,3}(,\d{3})*$/);
    expect(post.createdAt).toBe("2023-06-29T13:21:27.674Z");
  });

  it("reads every carousel item at its largest size", async () => {
    const post = await publicPost(sidecar, "Dc3zNGWlIpy");

    expect(post.title).toBe("@nasa");
    expect(post.author.verified).toBe(true);
    expect(post.text).toMatch(/^Godspeed, Roman\.\n\nICYMI: the Nancy Grace Roman Space Telescope/);
    expect(post.text).toMatch(/#NASA #Roman #AdoptAPixel$/);
    expect(post.media).toHaveLength(2);
    expect(post.media.every((item) => item.kind === "image" && CDN.test(item.url))).toBe(true);
    expect(post.media[0].width).toBe(1158);
  });

  it("falls back to the HTML when contextJSON is null on a single image", async () => {
    const post = await publicPost(image, "DdEy97xj9P-");

    expect(post.title).toBe("@nasa");
    expect(post.author).toMatchObject({ handle: "nasa", verified: true });
    expect(post.author.avatar).toMatch(CDN);
    expect(post.text).toMatch(/^Some things are worth repeating 📸\n\nLike observing a galaxy cluster!/);
    expect(post.text).toContain("several @NASAHubble science observations. Hubble's multiple looks");
    expect(post.text).toMatch(/Credit: NASA\n\n#NASA #Hubble #Stars$/);
    expect(post.text).not.toContain("View all");
    expect(post.media).toHaveLength(1);
    expect(post.media[0]).toMatchObject({ kind: "image" });
    expect(post.media[0].url).toMatch(CDN);
    expect(post.stats).toEqual({ likes: "257,134", replies: "777" });
    expect(post.createdAt).toBe("2026-09-09T17:27:27.420Z");
  });

  it("keeps Chinese captions and line breaks from contextJSON", async () => {
    const post = await publicPost(reelZh, "DIgLLaiptZg");

    expect(post.title).toBe("@ikea_taiwan");
    expect(post.text).toBe(
      "記得喝水。\n\n喝水會變水，\n用漂亮杯子喝水，心情又更水了✨\n\n分享給你最寶貝的朋友！\n\nIKEA 漂亮寶杯 新上市\n官網🔎新品專區 餐廳用品與家具\n\n#IKEA #IKEATW #IKEATaiwan\n#新品 #News #水杯 #水壺",
    );
    expect(post.media[0].kind).toBe("video");
  });

  it("ignores contextJSON that belongs to another post", async () => {
    const post = await publicPost(video.replaceAll("CuE2WNQs6vH", "OtherCode00"), "CuE2WNQs6vH");

    // JSON 不採用，改用 HTML：只剩封面圖，沒有影片。
    expect(post.title).toBe("@google");
    expect(post.media).toEqual([{ kind: "image", url: expect.stringMatching(CDN) }]);
  });

  it("leaves a broken embed to the og fetcher", async () => {
    const { result } = await run(broken, "CuE2WNQs6vA");
    expect(result).toEqual({ kind: "transient", httpStatus: 200, errorCode: "embed_broken" });
  });

  it("reports an unknown page shape as transient", async () => {
    const { result } = await run("<html><body><div>changed</div></body></html>", "CuE2WNQs6vH");
    expect(result).toEqual({ kind: "transient", httpStatus: 200, errorCode: "embed_unparsed" });
  });

  it.each([
    [404, { kind: "not_found", httpStatus: 404, errorCode: null }],
    [302, { kind: "transient", httpStatus: 302, errorCode: "redirect" }],
    [429, { kind: "transient", httpStatus: 429, errorCode: null }],
    [403, { kind: "transient", httpStatus: 403, errorCode: "unexpected_status" }],
  ])("maps HTTP %i", async (status, expected) => {
    const { result } = await run("", "CuE2WNQs6vH", status);
    expect(result).toEqual(expected);
  });
});
