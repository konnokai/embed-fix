import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../../../src/providers/threads/http";
import { ogFetcher } from "../../../src/providers/threads/og";
import { resolveShare } from "../../../src/providers/threads/share";
import ogLogin from "./fixtures/og-login.html?raw";
import ogPublic from "./fixtures/og-public.html?raw";
import { html, redirect, stubFetch } from "./stub";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("og fetcher", () => {
  const ref = { key: "DZvEeVWAKrX", params: { username: "mosseri", code: "DZvEeVWAKrX" } };

  it("reads title, author and card image from a public post page", async () => {
    const calls = stubFetch(() => html(ogPublic));
    const result = await ogFetcher.run(ref, {} as Env);

    expect(calls[0].url).toBe("https://www.threads.com/@mosseri/post/DZvEeVWAKrX");
    expect(calls[0].init).toEqual({ redirect: "manual", headers: { "user-agent": USER_AGENT } });
    expect(result.kind).toBe("public");
    if (result.kind !== "public") return;
    expect(result.post.title).toBe("@mosseri");
    expect(result.post.author).toEqual({ name: "Adam Mosseri", handle: "mosseri" });
    expect(result.post.media).toHaveLength(1);
    expect(result.post.media[0].url).toMatch(/^https:\/\/[^/]+\.fbcdn\.net\/.*&ccb=/);
  });

  it("treats a page without og:title and an empty username as login required", async () => {
    stubFetch(() => html(ogLogin));
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({
      kind: "login_required",
      httpStatus: 200,
      errorCode: "og_empty_username",
    });
  });

  it("treats a page without any post metadata as transient", async () => {
    stubFetch(() => html("<html><head><title>Threads</title></head><body></body></html>"));
    expect((await ogFetcher.run(ref, {} as Env)).kind).toBe("transient");
  });

  it("follows the /t/ redirect on Threads hosts only", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/t/C-srcchPpp7") ? redirect("https://www.threads.com/@zuck/post/C-srcchPpp7", 301) : html(ogPublic),
    );
    const result = await ogFetcher.run({ key: "C-srcchPpp7", params: { code: "C-srcchPpp7" } }, {} as Env);

    expect(calls.map((call) => call.url)).toEqual([
      "https://www.threads.com/t/C-srcchPpp7",
      "https://www.threads.com/@zuck/post/C-srcchPpp7",
    ]);
    expect(result.kind).toBe("public");

    const offsite = stubFetch(() => redirect("https://www.facebook.com/unsupportedbrowser"));
    expect(await ogFetcher.run(ref, {} as Env)).toEqual({
      kind: "transient",
      httpStatus: 302,
      errorCode: "redirect_rejected",
    });
    expect(offsite).toHaveLength(1);
  });
});

describe("share resolver", () => {
  it("reads the post from the redirect Location and drops the query", async () => {
    const calls = stubFetch(() =>
      redirect("https://www.threads.com/@ting__.2/post/Dd_vHLcCfNB?xmt=AQG0MuCBURAd&slof=1"),
    );

    expect(await resolveShare("BAZqSEo-Yl")).toEqual({
      key: "Dd_vHLcCfNB",
      params: { username: "ting__.2", code: "Dd_vHLcCfNB" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.threads.com/share/BAZqSEo-Yl/");
  });

  it("follows Threads-only redirect chains", async () => {
    stubFetch((url, call) =>
      call === 1 ? redirect("https://www.threads.net/share/BAZqSEo-Yl/") : redirect("/@zuck/post/C-srcchPpp7"),
    );
    expect(await resolveShare("BAZqSEo-Yl")).toEqual({
      key: "C-srcchPpp7",
      params: { username: "zuck", code: "C-srcchPpp7" },
    });
  });

  it("rejects redirects that leave Threads", async () => {
    stubFetch(() => redirect("https://www.facebook.com/unsupportedbrowser"));
    expect(await resolveShare("BAZqSEo-Yl")).toEqual({
      kind: "transient",
      httpStatus: 302,
      errorCode: "redirect_rejected",
    });
  });

  it("falls back to og:url when the share page answers directly", async () => {
    stubFetch(() => html(ogPublic));
    expect(await resolveShare("BAZqSEo-Yl")).toEqual({
      key: "DZvEeVWAKrX",
      params: { username: "mosseri", code: "DZvEeVWAKrX" },
    });
  });

  it("does not call an unresolvable share link deleted", async () => {
    stubFetch(() => html("<html><head><title>Threads</title></head><body></body></html>"));
    expect(await resolveShare("AAAAAAAAAA")).toEqual({
      kind: "transient",
      httpStatus: 200,
      errorCode: "share_unresolved",
    });

    stubFetch(() => html(ogLogin));
    expect(await resolveShare("AAAAAAAAAA")).toMatchObject({ kind: "transient" });
  });

  it("maps 404 to not found and rate limits to transient", async () => {
    stubFetch(() => html("", 404));
    expect(await resolveShare("x1")).toMatchObject({ kind: "not_found" });

    stubFetch(() => html("", 429));
    expect(await resolveShare("x1")).toEqual({ kind: "transient", httpStatus: 429, errorCode: null });
  });

  it("stops after too many redirects", async () => {
    const calls = stubFetch(() => redirect("https://www.threads.com/share/loop/"));
    expect(await resolveShare("loop")).toEqual({ kind: "transient", httpStatus: null, errorCode: "too_many_redirects" });
    expect(calls).toHaveLength(6);
  });
});
