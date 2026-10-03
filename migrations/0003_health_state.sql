-- 健康檢查與部署通知要記住上一次的狀態，才能只在狀態改變時送 Discord 通知。
-- key：'platform:{id}' 的 value 是 'ok' / 'failing'；'deploy' 的 value 是最後通知過的版本 ID。
-- 原本規劃的「刪舊表」改由 0004 處理。

CREATE TABLE health_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
