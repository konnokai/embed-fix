---
name: Cloudflare D1 remote inspection
description: 遠端 D1 臨時查詢前先看線上 schema，避免猜欄位。
---

2026-11-03 以 Wrangler 4.136.1 查遠端 D1 時，先執行 `npx wrangler d1 execute naver-cafe-embed-fix --remote --command "PRAGMA table_info(posts)" --json` 確認實際欄位。曾因猜用 `updated_at`、`version_hash` 查詢失敗；`SELECT *` 和 `COUNT(*)` 查詢可用。單次 API 回應 code 7403 後，同一查詢重試成功；這只是一次觀察，不能據此假設重試一定有效。
