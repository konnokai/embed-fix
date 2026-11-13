---
name: Cloudflare edge cache observation
description: Worker 回應與 Cloudflare 邊緣快取曾回報不同 TTL，成因尚未確認。
---

2026-11-04 實測：帶唯一 query 的請求回 `Cache-Control: public, max-age=600`；一般請求則是 `CF-Cache-Status: HIT`、`Age: 81`、`Cache-Control: public, max-age=14400`。這表示邊緣快取可能覆蓋 Worker 的 TTL，但成因未確認。排查實際快取期限時，需查 Cloudflare cache rules，不能只看 Worker 回應或 README 的 Cache API TTL。
