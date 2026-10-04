import { afterEach, describe, expect, it, vi } from "vitest";
import { matchShare, resolveShare } from "../../../src/providers/instagram/share";
import { html, redirect, stubFetch } from "../threads/stub";
import ogPublic from "./fixtures/og-public.html?raw";

afterEach(() => {
  vi.unstubAllGlobals();
});

function match(path: string) {
  return matchShare(new URL(path, "https://proxy.example"));
}

describe("instagram share paths", () => {
  it("matches the three share formats", () => {
    expect(match("/share/reel/BAf7vyMOu4?igsh=abc")).toEqual({
      key: "share:reel/BAf7vyMOu4",
      params: { path: "/share/reel/BAf7vyMOu4", share: "1" },
    });
    expect(match("/share/p/BAf7vyMOu4/")?.key).toBe("share:p/BAf7vyMOu4");
    expect(match("/share/BAf7vyMOu4/")?.params.path).toBe("/share/BAf7vyMOu4");
  });

  it("rejects other share-like paths", () => {
    expect(match("/share/")).toBeNull();
    expect(match("/share/v/abc/")).toBeNull();
    expect(match("/share/reel/a.b/")).toBeNull();
  });
});

// 轉址目標的格式取自 2026-10-04 在家中網路記錄的 Location（/share/reel/BAf7vyMOu4）。
describe("instagram share resolving", () => {
  it("reads the post from the Location with a trailing slash request and drops igsh", async () => {
    const calls = stubFetch(() => redirect("https://www.instagram.com/reel/DIgLLaiptZg/?igsh=QkJiV3ZDOTUyeA%3D%3D"));

    expect(await resolveShare("/share/reel/BAf7vyMOu4")).toEqual({
      key: "DIgLLaiptZg",
      params: { code: "DIgLLaiptZg", kind: "reel" },
    });
    expect(calls.map((call) => call.url)).toEqual(["https://www.instagram.com/share/reel/BAf7vyMOu4/"]);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("follows a redirect to another share URL, then reads the post", async () => {
    const calls = stubFetch((_, call) =>
      call === 1
        ? redirect("https://www.instagram.com/share/p/BAf7vyMOu4/")
        : redirect("/nasa/p/DdEy97xj9P-/?igsh=x"),
    );

    expect(await resolveShare("/share/BAf7vyMOu4")).toEqual({
      key: "DdEy97xj9P-",
      params: { code: "DdEy97xj9P-", kind: "p", username: "nasa" },
    });
    expect(calls).toHaveLength(2);
  });

  it("falls back to og:url when the share page answers 200", async () => {
    stubFetch(() => html(ogPublic));
    expect(await resolveShare("/share/reel/BAf7vyMOu4")).toEqual({
      key: "DIgLLaiptZg",
      params: { code: "DIgLLaiptZg", kind: "reel", username: "ikea_taiwan" },
    });
  });

  it.each([
    ["a plain 200 page", () => html("<html><head><title>Instagram</title></head></html>"), "share_unresolved", 200],
    ["a login redirect", () => redirect("https://www.instagram.com/accounts/login/?next=x"), "share_login", 302],
    ["a redirect off Instagram", () => redirect("https://evil.example/reel/DIgLLaiptZg/"), "redirect_rejected", 302],
    ["an unknown target", () => redirect("https://www.instagram.com/nasa/"), "share_unknown_target", 302],
  ])("reports %s as transient", async (_, response, errorCode, httpStatus) => {
    stubFetch(response);
    expect(await resolveShare("/share/reel/BAf7vyMOu4")).toEqual({ kind: "transient", httpStatus, errorCode });
  });

  it("stops after too many share redirects", async () => {
    const calls = stubFetch(() => redirect("https://www.instagram.com/share/reel/BAf7vyMOu4/"));
    expect(await resolveShare("/share/reel/BAf7vyMOu4")).toEqual({
      kind: "transient",
      httpStatus: null,
      errorCode: "too_many_redirects",
    });
    expect(calls).toHaveLength(6);
  });

  it("maps 404 to not found", async () => {
    stubFetch(() => html("", 404));
    expect(await resolveShare("/share/reel/BAf7vyMOu4")).toEqual({ kind: "not_found", httpStatus: 404, errorCode: null });
  });
});
