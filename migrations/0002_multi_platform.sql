-- 多平台 schema：posts 存每篇貼文目前的存取狀態，post_versions 存每個不同的公開內容版本。
-- 舊的 articles / article_versions 先保留，確認線上正常後由 0003 刪除。

CREATE TABLE posts (
  platform TEXT NOT NULL,
  post_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  last_fetch_started_at INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  last_http_status INTEGER,
  last_error_code TEXT,
  last_fetcher TEXT,
  latest_version_hash TEXT,
  PRIMARY KEY (platform, post_key)
);

CREATE TABLE post_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  post_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  first_fetched_at INTEGER NOT NULL,
  UNIQUE (platform, post_key, content_hash)
);

INSERT INTO posts (
  platform, post_key, source_url, first_seen_at, last_checked_at,
  last_fetch_started_at, last_status, last_http_status, last_error_code,
  last_fetcher, latest_version_hash
)
SELECT
  'naver', cafe_id || '/' || article_id, source_url, first_seen_at, last_checked_at,
  last_fetch_started_at, last_status, last_http_status, last_error_code,
  NULL, latest_version_hash
FROM articles;

-- content_json 是 NormalizedPost。舊 hash 原樣保留，latest_version_hash 才對得上；
-- 子查詢結果要再包一層 json()，不然會被當成字串塞進 JSON。
INSERT INTO post_versions (platform, post_key, content_hash, content_json, first_fetched_at)
SELECT
  'naver',
  v.cafe_id || '/' || v.article_id,
  v.content_hash,
  json_object(
    'title', v.title,
    'siteName', v.cafe_name,
    'author', json_object('name', v.author),
    'text', v.content_text,
    'media', json((
      SELECT json_group_array(json_object('kind', 'image', 'url', image.value))
      FROM json_each(v.image_urls) AS image
    )),
    'createdAt', v.written_at
  ),
  v.first_fetched_at
FROM article_versions AS v
ORDER BY v.id;
