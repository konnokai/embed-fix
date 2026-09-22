import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessParams, StoredContent } from "../src/db";
import { hashContent, loadLatestVersion, recordAccess, savePublic } from "../src/db";
import { resetDatabase } from "./helpers";

function content(overrides: Partial<StoredContent> = {}): StoredContent {
  return {
    title: "제목",
    author: "작성자",
    cafeName: "카페",
    text: "본문",
    images: ["https://img.example/1.png"],
    writtenAt: "2024-06-24T02:15:18.670Z",
    ...overrides,
  };
}

function params(overrides: Partial<AccessParams> = {}): AccessParams {
  return {
    cafeId: "1",
    articleId: "2",
    sourceUrl: "https://cafe.naver.com/f-e/cafes/1/articles/2",
    status: "public",
    httpStatus: 200,
    errorCode: null,
    startedAt: 1000,
    hash: null,
    ...overrides,
  };
}

async function versionCount(cafeId: string, articleId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM article_versions WHERE cafe_id = ? AND article_id = ?",
  )
    .bind(cafeId, articleId)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

afterEach(async () => {
  await resetDatabase();
});

describe("article storage", () => {
  it("round-trips a public version", async () => {
    const stored = content();
    const hash = await hashContent(stored);
    await savePublic(env.DB, params({ hash }), stored);

    expect(await loadLatestVersion(env.DB, "1", "2")).toEqual(stored);
  });

  it("stores an unchanged article once", async () => {
    const stored = content();
    const hash = await hashContent(stored);
    await savePublic(env.DB, params({ hash, startedAt: 1000 }), stored);
    await savePublic(env.DB, params({ hash, startedAt: 2000 }), stored);

    expect(await versionCount("1", "2")).toBe(1);
  });

  it("keeps both versions when the article changes and reads the newest", async () => {
    const first = content();
    await savePublic(env.DB, params({ hash: await hashContent(first), startedAt: 1000 }), first);

    const second = content({ text: "수정된 본문" });
    await savePublic(env.DB, params({ hash: await hashContent(second), startedAt: 2000 }), second);

    expect(await versionCount("1", "2")).toBe(2);
    expect(await loadLatestVersion(env.DB, "1", "2")).toEqual(second);
  });

  it("does not let an earlier request overwrite a newer result", async () => {
    await recordAccess(
      env.DB,
      params({ status: "transient", httpStatus: 503, startedAt: 2000 }),
    );
    await recordAccess(env.DB, params({ status: "public", httpStatus: 200, startedAt: 1000, hash: "stale" }));

    const row = await env.DB.prepare(
      "SELECT last_status, last_http_status, latest_version_hash FROM articles WHERE cafe_id = ? AND article_id = ?",
    )
      .bind("1", "2")
      .first();

    expect(row).toEqual({
      last_status: "transient",
      last_http_status: 503,
      latest_version_hash: null,
    });
  });

  it("remembers the last public version when access is no longer public", async () => {
    const stored = content();
    await savePublic(env.DB, params({ hash: await hashContent(stored), startedAt: 1000 }), stored);
    await recordAccess(env.DB, params({ status: "login_required", httpStatus: 401, startedAt: 2000 }));

    expect(await loadLatestVersion(env.DB, "1", "2")).toEqual(stored);
  });

  it("returns nothing for an unknown article", async () => {
    expect(await loadLatestVersion(env.DB, "9", "9")).toBeNull();
  });
});
