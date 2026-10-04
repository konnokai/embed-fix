import { afterEach, describe, expect, it, vi } from "vitest";
import { ogFetcher } from "../../../src/providers/instagram/og";
import { html, redirect, stubFetch } from "../threads/stub";
import ogMissing from "./fixtures/og-missing.html?raw";
import ogPublic from "./fixtures/og-public.html?raw";

const ref = { key: "DIgLLaiptZg", params: { code: "DIgLLaiptZg", kind: "reel" } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instagram og fetcher", () => {
  it("reads display name, handle, caption, counts and image from a public post page", async () => {
    const calls = stubFetch(() => html(ogPublic));
    const result = await ogFetcher.run(ref, {} as Env);

    expect(calls[0].url).toBe("https://www.instagram.com/reel/DIgLLaiptZg/");
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("@ikea_taiwan");
    expect(result.post.author).toEqual({
      name: "IKEA Taiwan",
      handle: "ikea_taiwan",
      url: "https://www.instagram.com/ikea_taiwan/",
    });
    expect(result.post.text).toMatch(/^記得喝水。\n\n喝水會變水，/);
    expect(result.post.text).toMatch(/#水杯 #水壺$/);
    expect(result.post.stats).toEqual({ likes: "44K", replies: "116" });
    expect(result.post.media).toEqual([{ kind: "image", url: expect.stringMatching(/^https:\/\/[^/]+\.cdninstagram\.com\//) }]);
    expect(result.post.createdAt).toBe("2025-04-16T09:39:13.822Z");
  });

  it("treats a page without og tags as login required", async () => {
    stubFetch(() => html(ogMissing));
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({ kind: "login_required", httpStatus: 200, errorCode: "og_missing" });
  });

  it("follows redirects on Instagram and stops at the login page", async () => {
    const calls = stubFetch((_, call) =>
      call === 1
        ? redirect("https://www.instagram.com/ikea_taiwan/reel/DIgLLaiptZg/")
        : redirect("https://www.instagram.com/accounts/login/?next=%2Freel%2F"),
    );
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({ kind: "login_required", httpStatus: 302, errorCode: "login_redirect" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.instagram.com/reel/DIgLLaiptZg/",
      "https://www.instagram.com/ikea_taiwan/reel/DIgLLaiptZg/",
    ]);
  });

  it("does not follow redirects off Instagram", async () => {
    const calls = stubFetch(() => redirect("https://evil.example/reel/DIgLLaiptZg/"));
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({ kind: "transient", httpStatus: 302, errorCode: "redirect_rejected" });
    expect(calls).toHaveLength(1);
  });

  it("maps 404 to not found and 5xx to transient", async () => {
    stubFetch(() => html("", 404));
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({ kind: "not_found", httpStatus: 404, errorCode: null });
    stubFetch(() => html("", 503));
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({ kind: "transient", httpStatus: 503, errorCode: null });
  });
});
