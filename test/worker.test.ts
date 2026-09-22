import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetDatabase } from "./helpers";

const CAFE_ID = "29424353";
const ARTICLE_ID = "528107";
const ARTICLE_URL = `https://proxy.example/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`;
const IMAGE_URL = "https://cafeptthumb-phinf.pstatic.net/sample/photo.jpg?type=w800";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function articleBody(article: Record<string, unknown> = {}): unknown {
  return {
    result: {
      article: {
        subject: "부키는 여우야",
        contentHtml: `<p>머리에 드릴이 있어도 사람을 잘 꼬셔..</p><img src="${IMAGE_URL}" class="se-image-resource"><div class="se-sticker"><img src="https://storep-phinf.pstatic.net/cafe_004/original_5.png" class="se-sticker-image" alt="sticker"></div>`,
        writeDate: 1719185718670,
        isReadable: true,
        isBlind: false,
        writer: { nick: "김공고" },
        ...article,
      },
      cafe: { name: "스텔라이브" },
      user: { isLogin: false, isCafeMember: false },
    },
  };
}

function stubUpstream(handler: () => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler();
  });
  return calls;
}

function get(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://proxy.example${path}`, init);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetDatabase();
});

describe("article pages", () => {
  it("serves Open Graph metadata in the raw HTML", async () => {
    stubUpstream(() => jsonResponse(articleBody()));
    const response = await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html;charset=UTF-8");
    expect(html).toContain('<meta property="og:title" content="부키는 여우야">');
    expect(html).toContain('<meta property="og:site_name" content="스텔라이브">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain(
      `<meta property="og:url" content="https://proxy.example/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}">`,
    );
    expect(html).toContain(
      '<meta property="og:description" content="김공고 · 스텔라이브 — 머리에 드릴이 있어도 사람을 잘 꼬셔..">',
    );
    expect(html).toContain('<meta name="author" content="김공고">');
    expect(html).toContain(`<meta property="og:image" content="${IMAGE_URL}">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain("머리에 드릴이 있어도");
    expect(html).not.toContain("sticker");
    expect(html).not.toContain("storep-phinf");
    expect(html).toContain('href="https://cafe.naver.com/f-e/cafes/29424353/articles/528107"');
  });

  it("omits image metadata when the article has no image", async () => {
    stubUpstream(() => jsonResponse(articleBody({ contentHtml: "<p>사진 없는 글</p>" })));
    const html = await (await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`)).text();

    expect(html).not.toContain("og:image");
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  it("escapes article text and titles", async () => {
    stubUpstream(() =>
      jsonResponse(
        articleBody({
          subject: `<script>alert("x")</script>`,
          contentHtml: "<p>5 &lt; 6 &amp; \"quoted\"</p>",
        }),
      ),
    );
    const html = await (await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`)).text();

    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("5 &lt; 6 &amp; &quot;quoted&quot;");
  });

  it("accepts the /ca-fe path form", async () => {
    stubUpstream(() => jsonResponse(articleBody()));
    const response = await get(`/ca-fe/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`);
    expect(response.status).toBe(200);
  });

  it("answers HEAD without a body", async () => {
    stubUpstream(() => jsonResponse(articleBody()));
    const response = await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("rejected requests", () => {
  it("rejects unsupported paths and ids without calling upstream", async () => {
    const calls = stubUpstream(() => jsonResponse(articleBody()));

    expect((await get("/")).status).toBe(400);
    expect((await get(`/f-e/cafes/${CAFE_ID}/articles/abc`)).status).toBe(400);
    expect((await get("/f-e/cafes/29424353/articles/528107/extra")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects methods other than GET and HEAD", async () => {
    const calls = stubUpstream(() => jsonResponse(articleBody()));
    const response = await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});

describe("restricted and failing upstream", () => {
  it("shows a login card for member-only articles", async () => {
    stubUpstream(() => jsonResponse({ result: { errorCode: "0004" } }, 401));
    const response = await get(`/f-e/cafes/${CAFE_ID}/articles/1083231`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("需登入的文章");
    expect(html).toContain("前往 Naver 原文");
  });

  it("shows a deleted card for missing articles", async () => {
    stubUpstream(() => new Response("", { status: 404 }));
    const html = await (await get(`/f-e/cafes/${CAFE_ID}/articles/1`)).text();

    expect(html).toContain("文章不存在或已刪除");
  });

  it("shows a restricted card for blind articles", async () => {
    stubUpstream(() => jsonResponse(articleBody({ isBlind: true })));
    const html = await (await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`)).text();

    expect(html).toContain("文章無法公開預覽");
  });

  it("shows a temporary failure card without caching it", async () => {
    stubUpstream(() => new Response("", { status: 429 }));
    const response = await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("暫時無法取得預覽");
  });

  it("serves the stored version when the article stops being public", async () => {
    stubUpstream(() => jsonResponse(articleBody()));
    await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`);

    stubUpstream(() => jsonResponse({ result: { errorCode: "0004" } }, 401));
    const html = await (await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`)).text();

    expect(html).toContain("부키는 여우야");
    expect(html).not.toContain("需登入的文章");
  });

  it("stores one version when the same article is fetched twice", async () => {
    stubUpstream(() => jsonResponse(articleBody()));
    await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`);
    await get(`/f-e/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM article_versions WHERE cafe_id = ? AND article_id = ?",
    )
      .bind(CAFE_ID, ARTICLE_ID)
      .first<{ count: number }>();

    expect(row?.count).toBe(1);
  });
});

describe("storage failures", () => {
  it("still serves the preview and logs the error", async () => {
    stubUpstream(() => jsonResponse(articleBody()));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenDb = {
      prepare() {
        throw new Error("d1 unavailable");
      },
    } as unknown as D1Database;

    const ctx = createExecutionContext();
    const fetchWithCtx = worker.fetch as unknown as (
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>;
    const response = await fetchWithCtx(new Request(ARTICLE_URL), { DB: brokenDb } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("부키는 여우야");
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("d1_write_failed");
    errorSpy.mockRestore();
  });
});
