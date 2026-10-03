import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../../../src/providers/threads/http";
import { pluginFetcher } from "../../../src/providers/facebook/plugin";
import { html, stubFetch } from "../threads/stub";
import multiImage from "./fixtures/plugin-multi-image.html?raw";
import photo from "./fixtures/plugin-photo.html?raw";
import reel from "./fixtures/plugin-reel.html?raw";
import singleImage from "./fixtures/plugin-single-image.html?raw";
import storyPhp from "./fixtures/plugin-story-php.html?raw";
import styledText from "./fixtures/plugin-styled-text.html?raw";
import unavailable from "./fixtures/plugin-unavailable.html?raw";
import video from "./fixtures/plugin-video.html?raw";

const ref = { key: "posts:1602283071267063", params: { path: "/NASA/posts/1602283071267063" } };

async function run(body: string, status = 200) {
  stubFetch(() => html(body, status));
  return pluginFetcher.run(ref, {} as Env);
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

describe("plugin fetcher request", () => {
  it("asks the post plugin in English with a User-Agent, no cookies and no redirects", async () => {
    const calls = stubFetch(() => html(multiImage));
    await pluginFetcher.run(ref, {} as Env);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2FNASA%2Fposts%2F1602283071267063&locale=en_US",
    );
    expect(calls[0].init).toEqual({
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
    });
  });
});

describe("plugin page parsing (fixtures captured 2026-10-03 from Cloudflare)", () => {
  it("reads a post with several images", async () => {
    const post = await publicPost(multiImage);

    expect(post.title).toBe("NASA - National Aeronautics and Space Administration");
    expect(post.siteName).toBe("Facebook");
    expect(post.author).toEqual({
      name: "NASA - National Aeronautics and Space Administration",
      verified: true,
      avatar: expect.stringMatching(/^https:\/\/scontent\.xx\.fbcdn\.net\/v\/t39\.30808-1\//),
      url: "https://www.facebook.com/NASA",
    });
    expect(post.author.avatar).not.toContain("&amp;");
    // 連結文字是網址時換成 l.php 背後的真正網址。
    expect(post.text).toBe(
      "Our photographers were on hand in Maine and Spain to capture the Aug. 12 solar eclipse. Check out a few of their photos here and see the rest on Flickr: https://www.flickr.com/photos/nasahqphoto/",
    );
    expect(post.media).toHaveLength(4);
    for (const item of post.media) {
      expect(item.kind).toBe("image");
      expect(item.url).toMatch(/^https:\/\/scontent\.xx\.fbcdn\.net\/v\/t39\.30808-6\//);
    }
    expect(post.stats).toEqual({ likes: "18K", replies: "301", shares: "2.8K" });
    expect(post.createdAt).toBe("2026-08-13T18:17:19.000Z");
  });

  it("reads the collapsed part of the text and skips the See more link", async () => {
    const post = await publicPost(singleImage);

    expect(post.author.name).toBe("Malta Daily");
    expect(post.author.verified).toBe(false);
    expect(post.author.url).toBe("https://www.facebook.com/maltadaily.mt");
    expect(post.text).toContain("posing a potential risk to staff and patrons on site.\n\nFirefighters from Fire Stations");
    expect(post.text.endsWith("#MaltaDaily")).toBe(true);
    expect(post.text).not.toContain("See more");
    expect(post.text).not.toContain("...");
    expect(post.media).toHaveLength(1);
    expect(post.createdAt).toBe("2025-12-25T16:07:44.000Z");
  });

  it("keeps emoji and Unicode styled letters", async () => {
    const post = await publicPost(styledText);

    expect(post.author.name).toBe("The Malta Police Force");
    expect(post.text.startsWith("🔵𝗛𝗶𝗴𝗵𝗹𝗶𝗴𝗵𝘁𝗶𝗻𝗴 𝗣𝗼𝘀𝗶𝘁𝗶𝘃𝗲 𝗣𝗼𝗹𝗶𝗰𝗲 𝗘𝗳𝗳𝗼𝗿𝘁𝘀🔵\n\n#maltapolice recap from last week:")).toBe(true);
    expect(post.text).toContain("➡️ 2 men arrested & arraigned over drug possession");
    expect(post.text.endsWith("this Christmas and throughout the year. 👮🇲🇹")).toBe(true);
  });

  it("reads a photo post and keeps line breaks", async () => {
    const post = await publicPost(photo);

    expect(post.author.name).toBe("Ludus Magnus Studio");
    expect(post.text).toMatch(/^🌑𝐓𝐡𝐞 𝐏𝐢𝐥𝐠𝐫𝐢𝐦𝐚𝐠𝐞 𝐆𝐚𝐢𝐧𝐬 𝐒𝐭𝐫𝐞𝐧𝐠𝐭𝐡!🌑\nPenitents/);
    expect(post.text.endsWith("#boardgames #MeaCulpa")).toBe(true);
    expect(post.media).toHaveLength(1);
    expect(post.stats).toEqual({ likes: "605", replies: "9", shares: "568" });
  });

  it("reads a story.php post with outbound links", async () => {
    const post = await publicPost(storyPhp);

    expect(post.author.name).toBe("La tribu des Nacs");
    expect(post.author.url).toBe("https://www.facebook.com/Latribudesnacs");
    expect(post.text).toContain("- La découvreuse Laurine.\n- Nathalie ma super famille d'accueil");
    expect(post.text).toContain("La cagnotte :\nhttps://www.helloasso.com/associations/la-tribu-des-nacs");
    expect(post.text).not.toContain("l.facebook.com");
    expect(post.text).not.toContain("fbclid");
    expect(post.media).toHaveLength(2);
    expect(post.createdAt).toBe("2024-07-08T20:16:45.000Z");
  });

  it("reads a video post: the HD video instead of the poster, and no time", async () => {
    const post = await publicPost(video);

    expect(post.author.name).toBe("Mark Zuckerberg");
    expect(post.author.url).toBe("https://www.facebook.com/zuck");
    // 被摺疊的文字從句子中間接上：「onli」+「ne in '26」。
    expect(post.text).toContain("Prometheus and it's coming online in '26.");
    expect(post.text).toContain("Meta Superintelligence Labs will have industry-leading levels of compute");
    expect(post.media).toHaveLength(1);
    expect(post.media[0].kind).toBe("video");
    expect(post.media[0].url).toMatch(/^https:\/\/video\.xx\.fbcdn\.net\/o1\/v\/t2\/f2\/m366\//);
    expect(post.media[0].url).not.toContain("\\/");
    expect(post.createdAt).toBeNull();
    expect(post.stats).toEqual({ likes: "198K", replies: "77K", shares: "22K" });
  });

  it("reads a reel", async () => {
    const post = await publicPost(reel);

    expect(post.author.name).toBe("Sympa");
    expect(post.author.url).toBe("https://www.facebook.com/sympasympacom");
    expect(post.text).toBe("Stylisation du levier de vitesse façon Barbie 💅🏻.");
    expect(post.media.map((item) => item.kind)).toEqual(["video"]);
  });
});

describe("plugin fetcher results", () => {
  it("leaves 'no longer available' to the og fetcher", async () => {
    expect(await run(unavailable)).toEqual({ kind: "transient", httpStatus: 200, errorCode: "plugin_unavailable" });
  });

  it("reports an unknown page shape as transient", async () => {
    expect(await run("<html><body><div>Facebook</div></body></html>")).toEqual({
      kind: "transient",
      httpStatus: 200,
      errorCode: "plugin_unparsed",
    });
  });

  it("reports upstream errors and redirects as transient", async () => {
    expect(await run("", 500)).toEqual({ kind: "transient", httpStatus: 500, errorCode: null });
    expect(await run("", 302)).toEqual({ kind: "transient", httpStatus: 302, errorCode: "redirect" });
    expect(await run("", 403)).toEqual({ kind: "transient", httpStatus: 403, errorCode: "unexpected_status" });
  });

  it("ignores video URLs that are not on fbcdn", async () => {
    const tampered = video.replaceAll("video.xx.fbcdn.net", "evil.example");
    const post = await publicPost(tampered);
    expect(post.media.map((item) => item.kind)).toEqual(["image"]);
  });
});
