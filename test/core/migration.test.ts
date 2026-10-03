import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLatestVersion } from "../../src/core/db";
import { resetDatabase } from "../helpers";

const LEGACY = env.TEST_MIGRATIONS.filter((migration) => migration.name.startsWith("0001"));

/** Writes one article exactly the way the 0001-era code did. */
async function legacyArticle(options: {
  cafeId: string;
  articleId: string;
  status: string;
  hash: string | null;
  version?: { title: string; author: string; cafeName: string; text: string; images: string[]; writtenAt: string | null };
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO articles (cafe_id, article_id, source_url, first_seen_at, last_checked_at,
       last_fetch_started_at, last_status, last_http_status, last_error_code, latest_version_hash)
     VALUES (?, ?, ?, 100, 200, 150, ?, 401, '0004', ?)`,
  )
    .bind(
      options.cafeId,
      options.articleId,
      `https://cafe.naver.com/f-e/cafes/${options.cafeId}/articles/${options.articleId}`,
      options.status,
      options.hash,
    )
    .run();
  if (options.version && options.hash) {
    const v = options.version;
    await env.DB.prepare(
      `INSERT INTO article_versions (cafe_id, article_id, content_hash, title, author, cafe_name,
         content_text, image_urls, written_at, first_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 120)`,
    )
      .bind(
        options.cafeId,
        options.articleId,
        options.hash,
        v.title,
        v.author,
        v.cafeName,
        v.text,
        JSON.stringify(v.images),
        v.writtenAt,
      )
      .run();
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetDatabase();
});

describe("0002_multi_platform migration", () => {
  it("moves Naver rows into posts and post_versions", async () => {
    await reset();
    await applyD1Migrations(env.DB, LEGACY);
    await legacyArticle({
      cafeId: "29424353",
      articleId: "528107",
      status: "login_required",
      hash: "legacyhash1",
      version: {
        title: "부키는 \"여우\"야",
        author: "김공고",
        cafeName: "스텔라이브",
        text: "첫 줄\n\n둘째 줄 <b>&</b>",
        images: ["https://img.example/1.jpg?type=w800", "https://img.example/2.jpg"],
        writtenAt: "2024-06-23T23:35:18.670Z",
      },
    });
    await legacyArticle({
      cafeId: "1",
      articleId: "2",
      status: "public",
      hash: "legacyhash2",
      version: { title: "사진 없음", author: "", cafeName: "", text: "", images: [], writtenAt: null },
    });
    await legacyArticle({ cafeId: "1", articleId: "3", status: "not_found", hash: null });

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const posts = await env.DB.prepare(
      "SELECT * FROM posts ORDER BY post_key",
    ).all();
    expect(posts.results).toEqual([
      {
        platform: "naver",
        post_key: "1/2",
        source_url: "https://cafe.naver.com/f-e/cafes/1/articles/2",
        first_seen_at: 100,
        last_checked_at: 200,
        last_fetch_started_at: 150,
        last_status: "public",
        last_http_status: 401,
        last_error_code: "0004",
        last_fetcher: null,
        latest_version_hash: "legacyhash2",
      },
      expect.objectContaining({ post_key: "1/3", last_status: "not_found", latest_version_hash: null }),
      expect.objectContaining({ post_key: "29424353/528107", latest_version_hash: "legacyhash1" }),
    ]);

    expect(await loadLatestVersion(env.DB, "naver", "29424353/528107")).toEqual({
      title: "부키는 \"여우\"야",
      siteName: "스텔라이브",
      author: { name: "김공고" },
      text: "첫 줄\n\n둘째 줄 <b>&</b>",
      media: [
        { kind: "image", url: "https://img.example/1.jpg?type=w800" },
        { kind: "image", url: "https://img.example/2.jpg" },
      ],
      createdAt: "2024-06-23T23:35:18.670Z",
    });
    expect(await loadLatestVersion(env.DB, "naver", "1/2")).toEqual({
      title: "사진 없음",
      siteName: "",
      author: { name: "" },
      text: "",
      media: [],
      createdAt: null,
    });
    expect(await loadLatestVersion(env.DB, "naver", "1/3")).toBeNull();

    const versions = await env.DB.prepare("SELECT first_fetched_at FROM post_versions").all();
    expect(versions.results).toEqual([{ first_fetched_at: 120 }, { first_fetched_at: 120 }]);
    // 舊表先保留，等 0003 再刪。
    const legacy = await env.DB.prepare("SELECT COUNT(*) AS count FROM article_versions").first<{ count: number }>();
    expect(legacy?.count).toBe(2);
  });

  it("serves a migrated article when Naver no longer shows it", async () => {
    await reset();
    await applyD1Migrations(env.DB, LEGACY);
    await legacyArticle({
      cafeId: "29424353",
      articleId: "528107",
      status: "public",
      hash: "legacyhash1",
      version: {
        title: "옮겨진 글",
        author: "김공고",
        cafeName: "스텔라이브",
        text: "본문",
        images: ["https://img.example/1.jpg"],
        writtenAt: "2024-06-23T23:35:18.670Z",
      },
    });
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    vi.stubGlobal("fetch", async () => new Response('{"result":{"errorCode":"0004"}}', { status: 401 }));
    const response = await exports.default.fetch("https://proxy.example/f-e/cafes/29424353/articles/528107");
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain('<meta property="og:title" content="옮겨진 글">');
    expect(page).toContain('<meta property="og:image" content="https://img.example/1.jpg">');
    expect(page).not.toContain("需登入的文章");
  });
});
