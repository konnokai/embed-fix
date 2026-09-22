/**
 * D1 read/write layer.
 *
 * `articles` holds the current access state per article, `article_versions`
 * holds every distinct publicly fetched content version. Writes for one
 * article are batched so the state row and the version row land together.
 */

export type AccessStatus = "public" | "login_required" | "not_found" | "restricted" | "transient";

export interface StoredContent {
  title: string;
  author: string;
  cafeName: string;
  text: string;
  images: string[];
  writtenAt: string | null;
}

export interface AccessParams {
  cafeId: string;
  articleId: string;
  sourceUrl: string;
  status: AccessStatus;
  httpStatus: number | null;
  errorCode: string | null;
  /** When this request started, used to reject writes from a slower earlier request. */
  startedAt: number;
  /** Content hash of the current public version, or null for non-public results. */
  hash: string | null;
}

/**
 * Builds the access-state upsert. The `WHERE` guard keeps a request that
 * started earlier from overwriting a newer result, and COALESCE keeps the last
 * known public version pointer when the article is no longer public.
 */
function accessStatement(db: D1Database, params: AccessParams): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO articles (
         cafe_id, article_id, source_url, first_seen_at, last_checked_at,
         last_fetch_started_at, last_status, last_http_status, last_error_code,
         latest_version_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cafe_id, article_id) DO UPDATE SET
         source_url = excluded.source_url,
         last_checked_at = excluded.last_checked_at,
         last_fetch_started_at = excluded.last_fetch_started_at,
         last_status = excluded.last_status,
         last_http_status = excluded.last_http_status,
         last_error_code = excluded.last_error_code,
         latest_version_hash = COALESCE(excluded.latest_version_hash, articles.latest_version_hash)
       WHERE excluded.last_fetch_started_at >= articles.last_fetch_started_at`,
    )
    .bind(
      params.cafeId,
      params.articleId,
      params.sourceUrl,
      Date.now(),
      Date.now(),
      params.startedAt,
      params.status,
      params.httpStatus,
      params.errorCode,
      params.hash,
    );
}

export async function recordAccess(db: D1Database, params: AccessParams): Promise<void> {
  await accessStatement(db, params).run();
}

/**
 * Stores a public result: access state plus the content version.
 * The version insert is deduplicated by `(article, content hash)`, so repeated
 * crawls of an unchanged article do not add rows.
 */
export async function savePublic(
  db: D1Database,
  params: AccessParams,
  content: StoredContent,
): Promise<void> {
  await db.batch([
    accessStatement(db, params),
    db
      .prepare(
        `INSERT OR IGNORE INTO article_versions (
           cafe_id, article_id, content_hash, title, author, cafe_name,
           content_text, image_urls, written_at, first_fetched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.cafeId,
        params.articleId,
        params.hash,
        content.title,
        content.author,
        content.cafeName,
        content.text,
        JSON.stringify(content.images),
        content.writtenAt,
        Date.now(),
      ),
  ]);
}

/** Reads the last known public version, if any. */
export async function loadLatestVersion(
  db: D1Database,
  cafeId: string,
  articleId: string,
): Promise<StoredContent | null> {
  const row = await db
    .prepare(
      `SELECT v.title, v.author, v.cafe_name, v.content_text, v.image_urls, v.written_at
         FROM articles a
         JOIN article_versions v
           ON v.cafe_id = a.cafe_id
          AND v.article_id = a.article_id
          AND v.content_hash = a.latest_version_hash
        WHERE a.cafe_id = ? AND a.article_id = ?`,
    )
    .bind(cafeId, articleId)
    .first<{
      title: string;
      author: string;
      cafe_name: string;
      content_text: string;
      image_urls: string;
      written_at: string | null;
    }>();

  if (!row) {
    return null;
  }

  let images: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.image_urls);
    if (Array.isArray(parsed)) {
      images = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    images = [];
  }

  return {
    title: row.title,
    author: row.author,
    cafeName: row.cafe_name,
    text: row.content_text,
    images,
    writtenAt: row.written_at,
  };
}

/** SHA-256 of the fields that make up one content version. */
export async function hashContent(content: StoredContent): Promise<string> {
  const payload = JSON.stringify([
    content.title,
    content.author,
    content.cafeName,
    content.text,
    content.images,
    content.writtenAt,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
