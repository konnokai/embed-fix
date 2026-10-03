/**
 * Anonymous client for Naver Cafe's internal article API.
 *
 * Only one fixed host and one fixed path pattern are ever requested, with no
 * caller-supplied headers, cookies or query strings, so this module cannot be
 * used as an open proxy. The API is an internal interface without a
 * compatibility contract: every unexpected status, body or field type is
 * reported as `transient` instead of being guessed into a public article.
 */

export const ARTICLE_API_ORIGIN = "https://article.cafe.naver.com";

/** Error code the API returns when the viewer is not logged in (verified sample). */
export const LOGIN_ERROR_CODE = "0004";

export interface PublicArticle {
  cafeId: string;
  articleId: string;
  title: string;
  author: string;
  cafeName: string;
  contentHtml: string;
  writtenAt: string | null;
}

export type ArticleResult =
  | { kind: "public"; article: PublicArticle }
  | { kind: "login_required"; httpStatus: number; errorCode: string | null }
  | { kind: "not_found"; httpStatus: number; errorCode: null }
  | { kind: "restricted"; httpStatus: number; errorCode: string | null }
  | { kind: "transient"; httpStatus: number | null; errorCode: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toIsoString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Fetches a single article and classifies the outcome.
 *
 * Never throws: network errors, redirects and unparsable bodies become
 * `transient` so that upstream trouble is never shown as "needs login".
 */
export async function fetchArticle(cafeId: string, articleId: string): Promise<ArticleResult> {
  const apiUrl = `${ARTICLE_API_ORIGIN}/gw/v4/cafes/${cafeId}/articles/${articleId}`;

  let response: Response;
  try {
    // No credentials, no forwarded headers. Redirects are not followed: the
    // upstream must answer on its own host.
    response = await fetch(apiUrl, { redirect: "manual" });
  } catch {
    return { kind: "transient", httpStatus: null, errorCode: null };
  }

  const httpStatus = response.status;
  if (httpStatus >= 300 && httpStatus < 400) {
    return { kind: "transient", httpStatus, errorCode: null };
  }

  let result: Record<string, unknown> | null = null;
  if (httpStatus === 200 || httpStatus === 401 || httpStatus === 403) {
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && isRecord(body.result)) {
        result = body.result;
      }
    } catch {
      result = null;
    }
  }
  const errorCode = result ? asStringOrNull(result.errorCode) : null;

  if (httpStatus === 401) {
    return { kind: "login_required", httpStatus, errorCode };
  }
  if (httpStatus === 403) {
    return { kind: "restricted", httpStatus, errorCode };
  }
  if (httpStatus === 404) {
    return { kind: "not_found", httpStatus, errorCode: null };
  }
  if (httpStatus !== 200) {
    return { kind: "transient", httpStatus, errorCode };
  }
  if (!result) {
    return { kind: "transient", httpStatus, errorCode: null };
  }
  if (errorCode) {
    return errorCode === LOGIN_ERROR_CODE
      ? { kind: "login_required", httpStatus, errorCode }
      : { kind: "transient", httpStatus, errorCode };
  }

  const article = isRecord(result.article) ? result.article : null;
  if (!article) {
    return { kind: "transient", httpStatus, errorCode: null };
  }
  if (article.isReadable === false) {
    return { kind: "login_required", httpStatus, errorCode: null };
  }
  if (article.isBlind === true) {
    return { kind: "restricted", httpStatus, errorCode: null };
  }
  if (typeof article.subject !== "string" || typeof article.contentHtml !== "string") {
    return { kind: "transient", httpStatus, errorCode: null };
  }

  const writer = isRecord(article.writer) ? article.writer : {};
  const cafe = isRecord(result.cafe) ? result.cafe : {};
  return {
    kind: "public",
    article: {
      cafeId,
      articleId,
      title: article.subject,
      author: asStringOrNull(writer.nick) ?? "",
      cafeName: asStringOrNull(cafe.name) ?? "",
      contentHtml: article.contentHtml,
      writtenAt: toIsoString(article.writeDate),
    },
  };
}
