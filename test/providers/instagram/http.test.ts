import { describe, expect, it } from "vitest";
import { createdAtFromCode, INSTAGRAM_EARLIEST_MS } from "../../../src/providers/threads/code";
import { matchPostUrl, mediaUrl, postPath, postUrl } from "../../../src/providers/instagram/http";
import { route } from "../../../src/router";

function match(path: string) {
  return matchPostUrl(new URL(path, "https://proxy.example"));
}

describe("instagram path rules", () => {
  it.each([
    ["/p/DdEy97xj9P-/", { code: "DdEy97xj9P-", kind: "p" }],
    ["/p/DdEy97xj9P-?igsh=abc&img_index=2", { code: "DdEy97xj9P-", kind: "p" }],
    ["/reel/DIgLLaiptZg/", { code: "DIgLLaiptZg", kind: "reel" }],
    ["/reels/DIgLLaiptZg", { code: "DIgLLaiptZg", kind: "reel" }],
    ["/tv/CuE2WNQs6vH", { code: "CuE2WNQs6vH", kind: "tv" }],
    ["/nasa/p/DdEy97xj9P-/", { code: "DdEy97xj9P-", kind: "p", username: "nasa" }],
    ["/ikea_taiwan/reel/DIgLLaiptZg/", { code: "DIgLLaiptZg", kind: "reel", username: "ikea_taiwan" }],
  ])("matches %s", (path, params) => {
    expect(match(path)).toEqual({ key: params.code, params });
  });

  it.each(["/nasa", "/p/", "/p/abc/embed", "/stories/nasa/123", "/nasa/tv/abc", "/explore/tags/nasa", "/share/p/abc", "/share/reel/abc"])(
    "rejects %s",
    (path) => {
      expect(match(path)).toBeNull();
    },
  );

  it("builds the original URL with the username when it is known", () => {
    expect(postUrl({ key: "x", params: { code: "DIgLLaiptZg", kind: "reel" } })).toBe(
      "https://www.instagram.com/reel/DIgLLaiptZg/",
    );
    expect(postPath({ key: "x", params: { code: "DdEy97xj9P-", kind: "p", username: "nasa" } })).toBe("/nasa/p/DdEy97xj9P-");
  });

  it("only accepts https URLs on Instagram media hosts", () => {
    expect(mediaUrl("https://scontent-tpe1-1.cdninstagram.com/v/a.jpg")).toBe("https://scontent-tpe1-1.cdninstagram.com/v/a.jpg");
    expect(mediaUrl("https://scontent.xx.fbcdn.net/v/a.jpg")).toBe("https://scontent.xx.fbcdn.net/v/a.jpg");
    expect(mediaUrl("http://scontent.cdninstagram.com/v/a.jpg")).toBeNull();
    expect(mediaUrl("https://cdninstagram.com.evil.example/a.jpg")).toBeNull();
    expect(mediaUrl("")).toBeNull();
  });
});

describe("instagram routing on the shared domain", () => {
  it.each([
    ["/reel/2300161320399228", "facebook"],
    ["/reel/DIgLLaiptZg", "instagram"],
    ["/p/DdEy97xj9P-", "instagram"],
    ["/share/reel/BAf7vyMOu4", "instagram"],
    ["/share/p/1BAxhY4v7c/", "facebook"],
    ["/share/1BAxhY4v7c", "threads"],
  ])("gives %s to %s", (path, provider) => {
    expect(route(new URL(path, "https://ebfix.konnokai.me"))?.provider.id).toBe(provider);
  });

  it("is not served on the legacy Naver domain or the Facebook domain", () => {
    expect(route(new URL("/p/DdEy97xj9P-", "https://cafe.konnokai.me"))).toBeNull();
    expect(route(new URL("/p/DdEy97xj9P-", "https://fb.ebfix.konnokai.me"))).toBeNull();
  });
});

describe("instagram routing on ig.ebfix.konnokai.me", () => {
  it.each([
    ["/share/reel/BAf7vyMOu4", "share:reel/BAf7vyMOu4"],
    ["/share/p/BAf7vyMOu4/", "share:p/BAf7vyMOu4"],
    ["/share/BAf7vyMOu4", "share:BAf7vyMOu4"],
    ["/p/DdEy97xj9P-", "DdEy97xj9P-"],
  ])("gives %s to Instagram", (path, key) => {
    const found = route(new URL(path, "https://ig.ebfix.konnokai.me"));
    expect(found?.provider.id).toBe("instagram");
    expect(found?.ref.key).toBe(key);
  });

  it("serves nothing from the other platforms", () => {
    expect(route(new URL("/@zuck/post/C-srcchPpp7", "https://ig.ebfix.konnokai.me"))).toBeNull();
    expect(route(new URL("/NASA/posts/1602283071267063", "https://ig.ebfix.konnokai.me"))).toBeNull();
    expect(route(new URL("/f-e/cafes/1/articles/2", "https://ig.ebfix.konnokai.me"))).toBeNull();
  });
});

describe("instagram post time", () => {
  it.each([
    ["CuE2WNQs6vH", "2023-06-29T13:21:27.674Z"],
    ["DIgLLaiptZg", "2025-04-16T09:39:13.822Z"],
    ["DdEy97xj9P-", "2026-09-09T17:27:27.420Z"],
  ])("decodes %s", (code, time) => {
    expect(createdAtFromCode(code, INSTAGRAM_EARLIEST_MS)).toBe(time);
  });

  it("ignores early sequential IDs that decode to the epoch", () => {
    expect(createdAtFromCode("BAAA", INSTAGRAM_EARLIEST_MS)).toBeNull();
  });

  it("keeps the Threads lower bound by default", () => {
    expect(createdAtFromCode("CuE2WNQs6vH")).toBeNull();
  });
});
