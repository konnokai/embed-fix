import { afterEach, describe, expect, it, vi } from "vitest";
import { matchShare, resolveShare } from "../../../src/providers/facebook/share";
import { html, redirect, stubFetch } from "../threads/stub";

afterEach(() => {
  vi.unstubAllGlobals();
});

function match(path: string) {
  return matchShare(new URL(path, "https://proxy.example"));
}

describe("facebook share paths", () => {
  it("matches the four share formats", () => {
    expect(match("/share/p/1BAxhY4v7c/?mibextid=wwXIfr")).toEqual({
      key: "share:p/1BAxhY4v7c",
      params: { path: "/share/p/1BAxhY4v7c/", share: "1" },
    });
    expect(match("/share/r/15B1URzika")?.key).toBe("share:r/15B1URzika");
    expect(match("/share/v/1GdMNgXLSG/")?.key).toBe("share:v/1GdMNgXLSG");
    expect(match("/share/18FR7dRvre/")?.params.path).toBe("/share/18FR7dRvre/");
  });

  it("rejects other share-like paths", () => {
    expect(match("/share/")).toBeNull();
    expect(match("/share/x/abc/")).toBeNull();
    expect(match("/share/p/a.b/")).toBeNull();
  });
});

// 轉址目標的格式取自 F0 從 Cloudflare 出口記錄的 Location（2026-10-03）。
describe("facebook share resolving", () => {
  it("reads the post from m.facebook.com's Location and drops tracking parameters", async () => {
    const calls = stubFetch(() =>
      redirect(
        "https://m.facebook.com/story.php?story_fbid=pfbid0abc&id=100064&rdid=Z23iv6&share_url=https%3A%2F%2Fm.facebook.com%2Fshare%2Fp%2F1B44qfVcyF%2F",
      ),
    );

    expect(await resolveShare("/share/p/1B44qfVcyF/")).toEqual({
      key: "story:pfbid0abc",
      params: { path: "/story.php?story_fbid=pfbid0abc&id=100064" },
    });
    expect(calls.map((call) => call.url)).toEqual(["https://m.facebook.com/share/p/1B44qfVcyF/"]);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("resolves reels and videos", async () => {
    stubFetch(() => redirect("https://m.facebook.com/reel/1104950621297253/?rdid=x"));
    expect(await resolveShare("/share/r/16zSwR7RS8/")).toEqual({
      key: "video:1104950621297253",
      params: { path: "/reel/1104950621297253/" },
    });

    stubFetch(() => redirect("https://m.facebook.com/okgo/videos/1755864954920657/?rdid=x"));
    expect((await resolveShare("/share/1GdMNgXLSG/")) as { key: string }).toMatchObject({
      key: "video:1755864954920657",
    });
  });

  it("tries mbasic.facebook.com after a login redirect", async () => {
    const calls = stubFetch((url) =>
      url.startsWith("https://m.facebook.com/")
        ? redirect("https://m.facebook.com/login/?next=x")
        : redirect("https://mbasic.facebook.com/reel/1365309657880490?rdid=x"),
    );

    expect(await resolveShare("/share/r/15B1URzika/")).toMatchObject({ key: "video:1365309657880490" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://m.facebook.com/share/r/15B1URzika/",
      "https://mbasic.facebook.com/share/r/15B1URzika/",
    ]);
  });

  it("reports events as unsupported without trying mbasic", async () => {
    const calls = stubFetch(() => redirect("https://m.facebook.com/events/s/some-event/3974856429449647/?rdid=x"));

    expect(await resolveShare("/share/18FR7dRvre/")).toEqual({
      kind: "not_found",
      httpStatus: 302,
      errorCode: "unsupported_target",
    });
    expect(calls).toHaveLength(1);
  });

  it("reads og:url when the link answers 200, and gives up when there is none", async () => {
    stubFetch(() =>
      html('<html><head><meta property="og:url" content="https://www.facebook.com/NASA/posts/123"></head></html>'),
    );
    expect(await resolveShare("/share/p/abc/")).toEqual({ key: "posts:123", params: { path: "/NASA/posts/123" } });

    const calls = stubFetch(() => html("<html><head><title>Facebook</title></head></html>"));
    expect(await resolveShare("/share/p/C3DxyLM3Bf8R8a3u/")).toEqual({
      kind: "transient",
      httpStatus: 200,
      errorCode: "share_unresolved",
    });
    expect(calls).toHaveLength(2);
  });

  it("never follows a redirect off Facebook", async () => {
    stubFetch(() => redirect("https://evil.example/NASA/posts/123"));
    expect(await resolveShare("/share/p/abc/")).toEqual({
      kind: "transient",
      httpStatus: 302,
      errorCode: "redirect_rejected",
    });
  });
});
