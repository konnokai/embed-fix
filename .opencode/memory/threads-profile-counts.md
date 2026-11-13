---
name: Threads profile counters
description: Threads 個人頁追蹤人數和串文數的來源、失效處理與格式注意事項。
---

個人頁的追蹤人數取自 `/@{username}/embed` 的 `.ProfileFollowerCount`；串文數取自另一個 profile page 的 `og:description`。兩頁格式或四捨五入可能不同，不能把 OG 的追蹤數當成 embed 顯示值。第二頁失敗時保留個人頁，只省略串文數。

解析串文數時，數字後必須接已知單位（例如 `Threads`、`則串文`、`串文`、`スレッド`、`스레드`）；不能只拿第二個 `•` 區段的數字，否則 bio 以數字開頭時會誤判。Threads 的中文 OG 內容使用過不換行空格，輸出前要正規化 U+00A0（2026-11-13 fixtures/tests）。

相關：[[threads-bio-links]]
