---
name: Threads profile bio links
description: Threads 自介連結的上游包裝、安全處理與 Discord 按鈕限制。
---

Threads 個人頁自介連結曾以 `https://l.facebook.com/l.php?u=...` 包裝（2026-11-10 實測）。只在 hostname 是 `l.facebook.com` 且 path 是 `/l.php` 時取出 `u`；目標只接受 HTTPS。輸出到 ebfix HTML 時跳脫標籤與網址，並加 `rel="nofollow ugc"`。

Discord link button 的 URL 上限是 512 字元（官方 [Component Reference](https://docs.discord.com/developers/components/reference)，2026-11-13 查證）。超長網址要從 Discord payload 移除，避免整個預覽被拒；HTML 頁面仍可保留連結。測試長連結時，fixture 裡的 handle 要和請求的 profile username 相同，否則原頁與作者頁網址不同，會掩蓋重複按鈕問題。

相關：[[threads-profile-counts]]
