---
name: Wrangler local scheduled tests
description: 本機排程測試端點曾與專案說明不同，需依 Wrangler 啟動輸出確認。
---

Wrangler 4.136.1 以 `npx wrangler dev --port 8793 --local --test-scheduled` 啟動時，輸出列出的本機排程端點是 `/cdn-cgi/local/scheduled`；GET 回 HTTP 200（2026-11-13）。這和專案說明中的 `/__scheduled` 不同。此路徑是版本限定觀察；先看目前 Wrangler 的啟動輸出，再用 health state 或 logs 確認檢查結果，不要只憑 HTTP 200 判定健康檢查通過。
