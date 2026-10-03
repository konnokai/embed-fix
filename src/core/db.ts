/**
 * D1 read/write layer (schema from `0002_multi_platform.sql`).
 *
 * `posts` holds the current access state of every post that was public at
 * least once, `post_versions` holds every distinct publicly fetched content
 * version as a `NormalizedPost` JSON. Writes for one post are batched so the
 * state row and the version row land together.
 */

import type { AccessStatus, MediaItem, NormalizedPost } from "./types";

export interface AccessParams {
  platform: string;
  /** Naver: "{cafeId}/{articleId}"; Threads: the post code. */
  postKey: string;
  sourceUrl: string;
  status: AccessStatus;
  httpStatus: number | null;
  errorCode: string | null;
  /** Fetcher that produced the result, kept for debugging. */
  fetcher: string | null;
  /** When this request started, used to reject writes from a slower earlier request. */
  startedAt: number;
  /** Content hash of the current public version, or null for non-public results. */
  hash: string | null;
}

/**
 * Builds the access-state upsert for a public result. The `WHERE` guard keeps
 * a request that started earlier from overwriting a newer result, and
 * COALESCE keeps the version pointer if an older row ever lacks one.
 */
function accessStatement(db: D1Database, params: AccessParams): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO posts (
         platform, post_key, source_url, first_seen_at, last_checked_at,
         last_fetch_started_at, last_status, last_http_status, last_error_code,
         last_fetcher, latest_version_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, post_key) DO UPDATE SET
         source_url = excluded.source_url,
         last_checked_at = excluded.last_checked_at,
         last_fetch_started_at = excluded.last_fetch_started_at,
         last_status = excluded.last_status,
         last_http_status = excluded.last_http_status,
         last_error_code = excluded.last_error_code,
         last_fetcher = excluded.last_fetcher,
         latest_version_hash = COALESCE(excluded.latest_version_hash, posts.latest_version_hash)
       WHERE excluded.last_fetch_started_at >= posts.last_fetch_started_at`,
    )
    .bind(
      params.platform,
      params.postKey,
      params.sourceUrl,
      Date.now(),
      Date.now(),
      params.startedAt,
      params.status,
      params.httpStatus,
      params.errorCode,
      params.fetcher,
      params.hash,
    );
}

/**
 * Records a non-public result for a post that is already stored. Posts that
 * never answered publicly get no row: anyone can request made-up codes, and
 * without content there is nothing to fall back to anyway.
 *
 * Same guard as the upsert: a request that started earlier never overwrites a
 * newer result. The one race left is a post's very first fetch, where a later
 * non-public answer can land before the row exists; the next request corrects it.
 */
export async function recordAccess(db: D1Database, params: AccessParams): Promise<void> {
  await db
    .prepare(
      `UPDATE posts SET
         source_url = ?,
         last_checked_at = ?,
         last_fetch_started_at = ?,
         last_status = ?,
         last_http_status = ?,
         last_error_code = ?,
         last_fetcher = ?
       WHERE platform = ? AND post_key = ? AND last_fetch_started_at <= ?`,
    )
    .bind(
      params.sourceUrl,
      Date.now(),
      params.startedAt,
      params.status,
      params.httpStatus,
      params.errorCode,
      params.fetcher,
      params.platform,
      params.postKey,
      params.startedAt,
    )
    .run();
}

/**
 * Stores a public result: access state plus the content version.
 * One row per `(post, content hash)`. When the content is unchanged only the
 * JSON is refreshed, because signed media URLs (Threads) expire and the newest
 * ones are the most likely to still load when the stored copy is served.
 */
export async function savePublic(db: D1Database, params: AccessParams, post: NormalizedPost): Promise<void> {
  await db.batch([
    accessStatement(db, params),
    db
      .prepare(
        `INSERT INTO post_versions (platform, post_key, content_hash, content_json, first_fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (platform, post_key, content_hash) DO UPDATE SET
           content_json = excluded.content_json`,
      )
      .bind(params.platform, params.postKey, params.hash, JSON.stringify(post), Date.now()),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMedia(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is MediaItem =>
      isRecord(item) && (item.kind === "image" || item.kind === "video") && typeof item.url === "string",
  );
}

/**
 * Validates stored JSON before it is rendered. A row that no longer matches
 * the shape is treated as missing rather than rendered half-empty.
 */
export function parseStoredPost(json: string): NormalizedPost | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.title !== "string" || !isRecord(value.author)) {
    return null;
  }
  const author = value.author;
  const post: NormalizedPost = {
    title: value.title,
    siteName: typeof value.siteName === "string" ? value.siteName : "",
    author: {
      name: typeof author.name === "string" ? author.name : "",
      ...(typeof author.handle === "string" ? { handle: author.handle } : {}),
      ...(typeof author.avatar === "string" ? { avatar: author.avatar } : {}),
      ...(typeof author.verified === "boolean" ? { verified: author.verified } : {}),
      ...(typeof author.url === "string" ? { url: author.url } : {}),
    },
    text: typeof value.text === "string" ? value.text : "",
    media: parseMedia(value.media),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
  if (typeof value.topic === "string") {
    post.topic = value.topic;
  }
  if (isRecord(value.stats)) {
    const stats: NonNullable<NormalizedPost["stats"]> = {};
    for (const key of ["likes", "replies", "reposts", "shares"] as const) {
      const count = value.stats[key];
      if (typeof count === "string") {
        stats[key] = count;
      }
    }
    post.stats = stats;
  }
  if (isRecord(value.replyTo) && typeof value.replyTo.handle === "string") {
    post.replyTo = {
      handle: value.replyTo.handle,
      text: typeof value.replyTo.text === "string" ? value.replyTo.text : "",
    };
  }
  if (isRecord(value.quoted) && typeof value.quoted.handle === "string") {
    post.quoted = {
      handle: value.quoted.handle,
      text: typeof value.quoted.text === "string" ? value.quoted.text : "",
      media: parseMedia(value.quoted.media),
    };
  }
  return post;
}

/** Reads the last known public version, if any. */
export async function loadLatestVersion(
  db: D1Database,
  platform: string,
  postKey: string,
): Promise<NormalizedPost | null> {
  const row = await db
    .prepare(
      `SELECT v.content_json
         FROM posts p
         JOIN post_versions v
           ON v.platform = p.platform
          AND v.post_key = p.post_key
          AND v.content_hash = p.latest_version_hash
        WHERE p.platform = ? AND p.post_key = ?`,
    )
    .bind(platform, postKey)
    .first<{ content_json: string }>();

  return row ? parseStoredPost(row.content_json) : null;
}

/** Media URLs are signed and served from varying CDN hosts; only the path identifies the file. */
function mediaPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function mediaKeys(media: MediaItem[]): string[] {
  return media.map((item) => `${item.kind}:${mediaPath(item.url)}`);
}

/**
 * SHA-256 of what makes one content version. Avatar, badge and counters are
 * left out, and media are compared by path, so a refetch of unchanged content
 * does not add a version just because a signature or CDN host changed.
 */
export async function hashPost(post: NormalizedPost): Promise<string> {
  const payload = JSON.stringify([
    post.title,
    post.siteName,
    post.author.name,
    post.author.handle ?? null,
    post.text,
    mediaKeys(post.media),
    post.createdAt ?? null,
    post.replyTo ? [post.replyTo.handle, post.replyTo.text] : null,
    post.quoted ? [post.quoted.handle, post.quoted.text, mediaKeys(post.quoted.media)] : null,
    // 只在有主題時才加進去，沒有主題的貼文 hash 跟加這欄之前一樣，不會多出版本。
    ...(post.topic ? [post.topic] : []),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
