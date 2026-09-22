/**
 * Naver Cafe link-preview proxy.
 *
 * A request for `/f-e|/ca-fe/cafes/{cafeId}/articles/{articleId}` is answered
 * with a single HTML document that carries Open Graph metadata, so a chat
 * client can build a preview from the raw response without running scripts.
 *
 * Every request re-checks the article anonymously upstream; D1 only keeps
 * history. When upstream no longer serves the article publicly but a stored
 * version exists, the stored version is returned instead of a status card.
 */

import { parseContentHtml } from "./content";
import { hashContent, loadLatestVersion, recordAccess, savePublic } from "./db";
import type { AccessParams, AccessStatus, StoredContent } from "./db";
import { fetchArticle } from "./naver";
import { renderArticlePage, renderStatusPage } from "./page";

const ARTICLE_PATH = /^\/(?:f-e|ca-fe)\/cafes\/(\d+)\/articles\/(\d+)\/?$/;
const SERVICE_NAME = "Naver Cafe Embed Fix";

const STATUS_PAGES: Record<
  Exclude<AccessStatus, "public">,
  { title: string; description: string; httpStatus: number }
> = {
  login_required: {
    title: "需登入的文章",
    description: "這篇文章需要 Naver 登入或會員閱讀權限，請前往 Naver 登入後確認。",
    httpStatus: 200,
  },
  not_found: {
    title: "文章不存在或已刪除",
    description: "找不到這篇文章，可能已被刪除。",
    httpStatus: 200,
  },
  restricted: {
    title: "文章無法公開預覽",
    description: "這篇文章目前已遮蔽或限制公開。",
    httpStatus: 200,
  },
  transient: {
    title: "暫時無法取得預覽",
    description: "上游暫時無法回應，請稍後再試。",
    httpStatus: 503,
  },
};

function htmlResponse(html: string, status: number, isHead: boolean): Response {
  const headers = new Headers({ "content-type": "text/html;charset=UTF-8" });
  if (status >= 400) {
    // Keep error cards out of long-lived caches on both sides.
    headers.set("cache-control", "no-store");
  }
  return new Response(isHead ? null : html, { status, headers });
}

/**
 * Persists access state, and the content version when the article is public.
 * A storage failure must not silently disappear: it is logged with the article
 * identifiers, and the freshly fetched preview is still served because the
 * upstream answer was valid.
 */
async function persist(
  env: Env,
  params: AccessParams,
  content: StoredContent | null,
): Promise<void> {
  try {
    if (content) {
      await savePublic(env.DB, params, content);
    } else {
      await recordAccess(env.DB, params);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "d1_write_failed",
        cafeId: params.cafeId,
        articleId: params.articleId,
        status: params.status,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function readStored(env: Env, cafeId: string, articleId: string): Promise<StoredContent | null> {
  try {
    return await loadLatestVersion(env.DB, cafeId, articleId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "d1_read_failed",
        cafeId,
        articleId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      return htmlResponse(
        "<!DOCTYPE html><html lang=\"zh-Hant\"><body><p>不支援的請求方法。</p></body></html>",
        405,
        false,
      );
    }

    const url = new URL(request.url);
    const match = ARTICLE_PATH.exec(url.pathname);
    if (!match) {
      // Invalid paths never reach the upstream API.
      return htmlResponse(
        "<!DOCTYPE html><html lang=\"zh-Hant\"><body><p>不支援的網址格式。</p></body></html>",
        400,
        isHead,
      );
    }

    const cafeId = match[1];
    const articleId = match[2];
    const canonicalUrl = `${url.origin}/f-e/cafes/${cafeId}/articles/${articleId}`;
    const originalUrl = `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/${articleId}`;
    const startedAt = Date.now();
    const result = await fetchArticle(cafeId, articleId);

    if (result.kind === "public") {
      const parsed = await parseContentHtml(result.article.contentHtml);
      const content: StoredContent = {
        title: result.article.title,
        author: result.article.author,
        cafeName: result.article.cafeName,
        text: parsed.text,
        images: parsed.images,
        writtenAt: result.article.writtenAt,
      };
      const hash = await hashContent(content);
      await persist(
        env,
        {
          cafeId,
          articleId,
          sourceUrl: originalUrl,
          status: "public",
          httpStatus: 200,
          errorCode: null,
          startedAt,
          hash,
        },
        content,
      );
      return htmlResponse(
        renderArticlePage({ canonicalUrl, originalUrl, content }),
        200,
        isHead,
      );
    }

    await persist(
      env,
      {
        cafeId,
        articleId,
        sourceUrl: originalUrl,
        status: result.kind,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode,
        startedAt,
        hash: null,
      },
      null,
    );

    const stored = await readStored(env, cafeId, articleId);
    if (stored) {
      return htmlResponse(renderArticlePage({ canonicalUrl, originalUrl, content: stored }), 200, isHead);
    }

    const page = STATUS_PAGES[result.kind];
    return htmlResponse(
      renderStatusPage({
        canonicalUrl,
        originalUrl: result.kind === "not_found" ? null : originalUrl,
        siteName: SERVICE_NAME,
        title: page.title,
        description: page.description,
      }),
      page.httpStatus,
      isHead,
    );
  },
} satisfies ExportedHandler<Env>;
