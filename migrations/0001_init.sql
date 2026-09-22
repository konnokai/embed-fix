-- Initial schema: current access state per article, and every distinct
-- publicly fetched content version.

CREATE TABLE articles (
  cafe_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  last_fetch_started_at INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  last_http_status INTEGER,
  last_error_code TEXT,
  latest_version_hash TEXT,
  PRIMARY KEY (cafe_id, article_id)
);

CREATE TABLE article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cafe_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  cafe_name TEXT NOT NULL,
  content_text TEXT NOT NULL,
  image_urls TEXT NOT NULL,
  written_at TEXT,
  first_fetched_at INTEGER NOT NULL,
  UNIQUE (cafe_id, article_id, content_hash)
);
