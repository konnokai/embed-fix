import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessParams } from "../../src/core/db";
import { hashPost, loadLatestVersion, parseStoredPost, recordAccess, savePublic } from "../../src/core/db";
import type { NormalizedPost } from "../../src/core/types";
import { resetDatabase } from "../helpers";

function post(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    title: "제목",
    siteName: "카페",
    author: { name: "작성자" },
    text: "본문",
    media: [{ kind: "image", url: "https://img.example/1.png" }],
    createdAt: "2024-06-24T02:15:18.670Z",
    ...overrides,
  };
}

function threadsPost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    title: "@zuck",
    siteName: "Threads",
    author: {
      name: "",
      handle: "zuck",
      avatar: "https://scontent.cdninstagram.com/a.jpg?oh=1",
      verified: true,
      url: "https://www.threads.com/@zuck",
    },
    topic: "明日方舟",
    stats: { likes: "5.9K", replies: "1K" },
    text: "hello",
    media: [{ kind: "video", url: "https://scontent-a.cdninstagram.com/o1/v/t16/clip.mp4?oe=1" }],
    createdAt: null,
    replyTo: { handle: "zuck", text: "parent" },
    quoted: { handle: "mosseri", text: "", media: [] },
    ...overrides,
  };
}

function params(overrides: Partial<AccessParams> = {}): AccessParams {
  return {
    platform: "naver",
    postKey: "1/2",
    sourceUrl: "https://cafe.naver.com/f-e/cafes/1/articles/2",
    status: "public",
    httpStatus: 200,
    errorCode: null,
    fetcher: "api",
    startedAt: 1000,
    hash: null,
    ...overrides,
  };
}

async function versionCount(platform: string, postKey: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM post_versions WHERE platform = ? AND post_key = ?",
  )
    .bind(platform, postKey)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

afterEach(async () => {
  await resetDatabase();
});

describe("post storage", () => {
  it("round-trips a public version", async () => {
    const stored = post();
    await savePublic(env.DB, params({ hash: await hashPost(stored) }), stored);

    expect(await loadLatestVersion(env.DB, "naver", "1/2")).toEqual(stored);
  });

  it("round-trips every Threads field", async () => {
    const stored = threadsPost();
    await savePublic(
      env.DB,
      params({ platform: "threads", postKey: "C-srcchPpp7", fetcher: "embed", hash: await hashPost(stored) }),
      stored,
    );

    expect(await loadLatestVersion(env.DB, "threads", "C-srcchPpp7")).toEqual(stored);
    const row = await env.DB.prepare("SELECT last_fetcher FROM posts WHERE platform = 'threads'").first();
    expect(row).toEqual({ last_fetcher: "embed" });
  });

  it("keeps platforms apart even with the same key", async () => {
    const naver = post();
    const threads = threadsPost();
    await savePublic(env.DB, params({ postKey: "same", hash: await hashPost(naver) }), naver);
    await savePublic(env.DB, params({ platform: "threads", postKey: "same", hash: await hashPost(threads) }), threads);

    expect(await loadLatestVersion(env.DB, "naver", "same")).toEqual(naver);
    expect(await loadLatestVersion(env.DB, "threads", "same")).toEqual(threads);
  });

  it("stores an unchanged post once", async () => {
    const stored = post();
    const hash = await hashPost(stored);
    await savePublic(env.DB, params({ hash, startedAt: 1000 }), stored);
    await savePublic(env.DB, params({ hash, startedAt: 2000 }), stored);

    expect(await versionCount("naver", "1/2")).toBe(1);
  });

  it("does not add a version when only signatures, CDN host, avatar or counters change", async () => {
    const first = threadsPost();
    const second = threadsPost({
      author: { name: "", handle: "zuck", avatar: "https://scontent-b.cdninstagram.com/a.jpg?oh=2", verified: true },
      media: [{ kind: "video", url: "https://scontent-z.cdninstagram.com/o1/v/t16/clip.mp4?oe=2" }],
      stats: { likes: "10" },
    });
    expect(await hashPost(second)).toBe(await hashPost(first));

    const key = params({ platform: "threads", postKey: "C1" });
    await savePublic(env.DB, { ...key, hash: await hashPost(first), startedAt: 1000 }, first);
    await savePublic(env.DB, { ...key, hash: await hashPost(second), startedAt: 2000 }, second);

    expect(await versionCount("threads", "C1")).toBe(1);
    // 內容沒變時更新成最新的網址，因為舊簽章會過期。
    expect((await loadLatestVersion(env.DB, "threads", "C1"))?.media[0].url).toBe(second.media[0].url);
  });

  it("keeps the hash of posts without a topic unchanged, and separates topics", async () => {
    const base = post();
    const payload = JSON.stringify([
      base.title, base.siteName, base.author.name, null, base.text,
      ["image:/1.png"], base.createdAt, null, null,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    expect(await hashPost(base)).toBe(expected);
    expect(await hashPost(post({ topic: "A" }))).not.toBe(expected);
    expect(await hashPost(post({ topic: "A" }))).not.toBe(await hashPost(post({ topic: "B" })));
  });

  it("keeps both versions when the post changes and reads the newest", async () => {
    const first = post();
    await savePublic(env.DB, params({ hash: await hashPost(first), startedAt: 1000 }), first);

    const second = post({ text: "수정된 본문" });
    await savePublic(env.DB, params({ hash: await hashPost(second), startedAt: 2000 }), second);

    expect(await versionCount("naver", "1/2")).toBe(2);
    expect(await loadLatestVersion(env.DB, "naver", "1/2")).toEqual(second);
  });

  it("does not create rows for posts that were never public", async () => {
    await recordAccess(env.DB, params({ status: "login_required", httpStatus: 401, startedAt: 1000 }));
    await recordAccess(env.DB, params({ platform: "threads", postKey: "madeUpCode", status: "login_required" }));

    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("does not let an earlier request overwrite a newer result", async () => {
    const stored = post();
    const hash = await hashPost(stored);
    await savePublic(env.DB, params({ hash, startedAt: 500 }), stored);
    await recordAccess(env.DB, params({ status: "transient", httpStatus: 503, fetcher: "og", startedAt: 2000 }));
    await savePublic(env.DB, params({ hash: "stale", startedAt: 1000 }), post({ text: "older" }));
    await recordAccess(env.DB, params({ status: "login_required", httpStatus: 401, startedAt: 1500 }));

    const row = await env.DB.prepare(
      "SELECT last_status, last_http_status, last_fetcher, latest_version_hash FROM posts WHERE platform = ? AND post_key = ?",
    )
      .bind("naver", "1/2")
      .first();

    expect(row).toEqual({
      last_status: "transient",
      last_http_status: 503,
      last_fetcher: "og",
      latest_version_hash: hash,
    });
    expect(await loadLatestVersion(env.DB, "naver", "1/2")).toEqual(stored);
  });

  it("does not let concurrent writes leave an older result in place", async () => {
    const stored = post();
    const hash = await hashPost(stored);
    await savePublic(env.DB, params({ hash, startedAt: 500 }), stored);
    // 三個請求同時寫入：最晚開始的結果（login_required）一定要留下來，不管誰先寫完。
    await Promise.all([
      recordAccess(env.DB, params({ status: "login_required", httpStatus: 401, startedAt: 3000 })),
      savePublic(env.DB, params({ hash, startedAt: 1000 }), stored),
      recordAccess(env.DB, params({ status: "transient", httpStatus: 503, startedAt: 2000 })),
    ]);

    const row = await env.DB.prepare("SELECT last_status, last_fetch_started_at FROM posts").first();
    expect(row).toEqual({ last_status: "login_required", last_fetch_started_at: 3000 });
  });

  it("remembers the last public version when access is no longer public", async () => {
    const stored = post();
    await savePublic(env.DB, params({ hash: await hashPost(stored), startedAt: 1000 }), stored);
    await recordAccess(env.DB, params({ status: "login_required", httpStatus: 401, startedAt: 2000 }));

    expect(await loadLatestVersion(env.DB, "naver", "1/2")).toEqual(stored);
  });

  it("returns nothing for an unknown post", async () => {
    expect(await loadLatestVersion(env.DB, "naver", "9/9")).toBeNull();
  });
});

describe("stored JSON validation", () => {
  it("rejects rows that are not a post", () => {
    expect(parseStoredPost("not json")).toBeNull();
    expect(parseStoredPost("[]")).toBeNull();
    expect(parseStoredPost('{"title":1,"author":{}}')).toBeNull();
    expect(parseStoredPost('{"title":"t"}')).toBeNull();
  });

  it("drops malformed media and fills missing optional fields", () => {
    expect(
      parseStoredPost('{"title":"t","author":{"name":"a"},"media":[{"kind":"image","url":"u"},{"kind":"gif","url":"x"},1]}'),
    ).toEqual({ title: "t", siteName: "", author: { name: "a" }, text: "", media: [{ kind: "image", url: "u" }], createdAt: null });
  });
});
