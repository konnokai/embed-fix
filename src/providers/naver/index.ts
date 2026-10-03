/**
 * Naver Cafe provider: `/f-e|/ca-fe/cafes/{cafeId}/articles/{articleId}`,
 * answered from the anonymous article API.
 */

import type { Fetcher, PostRef, Provider } from "../../core/types";
import { fetchArticle } from "./api";
import { parseContentHtml } from "./content";

const ARTICLE_PATH = /^\/(?:f-e|ca-fe)\/cafes\/(\d+)\/articles\/(\d+)\/?$/;

const apiFetcher: Fetcher = {
  name: "api",
  async run(ref) {
    const result = await fetchArticle(ref.params.cafeId, ref.params.articleId);
    if (result.kind !== "public") {
      return result;
    }
    const parsed = await parseContentHtml(result.article.contentHtml);
    return {
      kind: "public",
      httpStatus: 200,
      post: {
        title: result.article.title,
        siteName: result.article.cafeName,
        author: { name: result.article.author },
        text: parsed.text,
        media: parsed.images.map((url) => ({ kind: "image", url })),
        createdAt: result.article.writtenAt,
      },
    };
  },
};

function articlePath(ref: PostRef): string {
  return `/f-e/cafes/${ref.params.cafeId}/articles/${ref.params.articleId}`;
}

export const naver: Provider = {
  id: "naver",
  siteName: "Naver Cafe",
  lang: "ko",
  originalLinkText: "前往 Naver 原文",
  match(url) {
    const match = ARTICLE_PATH.exec(url.pathname);
    if (!match) {
      return null;
    }
    const [, cafeId, articleId] = match;
    return { key: `${cafeId}/${articleId}`, params: { cafeId, articleId } };
  },
  fetchers: [apiFetcher],
  originalUrl: (ref) => `https://cafe.naver.com${articlePath(ref)}`,
  canonicalPath: articlePath,
  statusText: {
    login_required: {
      title: "需登入的文章",
      description: "這篇文章需要 Naver 登入或會員閱讀權限，請前往 Naver 登入後確認。",
    },
    not_found: {
      title: "文章不存在或已刪除",
      description: "找不到這篇文章，可能已被刪除。",
    },
    restricted: {
      title: "文章無法公開預覽",
      description: "這篇文章目前已遮蔽或限制公開。",
    },
    transient: {
      title: "暫時無法取得預覽",
      description: "上游暫時無法回應，請稍後再試。",
    },
  },
  // 每次都重查上游，D1 只留歷史，所以不快取。
  cacheTtl: { post: 0, status: 0 },
  serveStoredWhenUnavailable: true,
  healthCheckPath: "/f-e/cafes/29424353/articles/528107",
};
