import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchArticle } from "../../../src/providers/naver/api";

const CAFE_ID = "29424353";
const ARTICLE_ID = "528107";
const API_URL = `https://article.cafe.naver.com/gw/v4/cafes/${CAFE_ID}/articles/${ARTICLE_ID}`;

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
        contentHtml: "<p>본문</p>",
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

function stub(handler: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchArticle", () => {
  it("maps a public article and sends no credentials or extra headers", async () => {
    const calls = stub(() => jsonResponse(articleBody()));
    const result = await fetchArticle(CAFE_ID, ARTICLE_ID);

    expect(result).toEqual({
      kind: "public",
      article: {
        cafeId: CAFE_ID,
        articleId: ARTICLE_ID,
        title: "부키는 여우야",
        author: "김공고",
        cafeName: "스텔라이브",
        contentHtml: "<p>본문</p>",
        writtenAt: "2024-06-23T23:35:18.670Z",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(API_URL);
    expect(calls[0].init).toEqual({ redirect: "manual" });
  });

  it("treats a 401 with error code 0004 as login required", async () => {
    stub(() =>
      jsonResponse(
        { result: { errorCode: "0004", reason: "로그인하지 않았습니다." } },
        401,
      ),
    );
    expect(await fetchArticle(CAFE_ID, "1083231")).toEqual({
      kind: "login_required",
      httpStatus: 401,
      errorCode: "0004",
    });
  });

  it("treats an error code in a 200 body as login required", async () => {
    stub(() => jsonResponse({ result: { errorCode: "0004" } }));
    expect(await fetchArticle(CAFE_ID, ARTICLE_ID)).toEqual({
      kind: "login_required",
      httpStatus: 200,
      errorCode: "0004",
    });
  });

  it("does not treat an unknown error code as public or as login", async () => {
    stub(() => jsonResponse({ result: { errorCode: "9999", message: "unknown" } }));
    expect(await fetchArticle(CAFE_ID, ARTICLE_ID)).toEqual({
      kind: "transient",
      httpStatus: 200,
      errorCode: "9999",
    });
  });

  it("treats unreadable and blind articles as restricted states", async () => {
    stub(() => jsonResponse(articleBody({ isReadable: false })));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("login_required");

    stub(() => jsonResponse(articleBody({ isBlind: true })));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("restricted");
  });

  it("separates deletion from login", async () => {
    stub(() => new Response("", { status: 404 }));
    expect(await fetchArticle(CAFE_ID, ARTICLE_ID)).toEqual({
      kind: "not_found",
      httpStatus: 404,
      errorCode: null,
    });
  });

  it("treats a 403 as restricted, not as login", async () => {
    stub(() => new Response("", { status: 403 }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("restricted");
  });

  it("treats redirects as transient without following them", async () => {
    const calls = stub(
      () => new Response("", { status: 302, headers: { location: "https://example.com/" } }),
    );
    expect(await fetchArticle(CAFE_ID, ARTICLE_ID)).toEqual({
      kind: "transient",
      httpStatus: 302,
      errorCode: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("treats rate limits, server errors and html bodies as transient", async () => {
    stub(() => new Response("", { status: 429 }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("transient");

    stub(() => new Response("<html>error</html>", { status: 500 }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("transient");

    stub(() => new Response("not json", { status: 200 }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("transient");
  });

  it("treats unknown structures as transient instead of public", async () => {
    stub(() => jsonResponse({ result: { article: { contentHtml: "<p>x</p>" } } }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("transient");

    stub(() => jsonResponse({ unexpected: true }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("transient");

    stub(() => jsonResponse({ result: { article: { ...{ subject: "제목", contentHtml: 1 } } } }));
    expect((await fetchArticle(CAFE_ID, ARTICLE_ID)).kind).toBe("transient");
  });

  it("treats network failures as transient", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await fetchArticle(CAFE_ID, ARTICLE_ID)).toEqual({
      kind: "transient",
      httpStatus: null,
      errorCode: null,
    });
  });
});
