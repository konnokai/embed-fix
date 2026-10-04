# Instagram Embed Fix 計畫

更新日期：2026-10-04

狀態：I1、I2 完成（2026-10-04，分支 `feat/instagram-provider`）。I3（上線）還沒做。共用架構（router、pipeline、page、D1、健康檢查）沿用
[THREADS_EMBED_FIX_PLAN.md](THREADS_EMBED_FIX_PLAN.md)，Meta 平台共通的作法參考
[FACEBOOK_EMBED_FIX_PLAN.md](FACEBOOK_EMBED_FIX_PLAN.md)。本文件只寫 Instagram 不一樣的地方。

第 3 節的結果都是**家中網路**測的，沒有做 Cloudflare 出口實測（理由見第 0 節）。

## 0. 已確定的決定

| 項目 | 決定 |
| --- | --- |
| 架構 | 新增 `src/providers/instagram/`，跟其他平台一樣是一個 provider |
| 帳號 | 不登入、不帶 Cookie、不用任何 Instagram 帳號或 token（沿用 Threads 規則） |
| 需登入的內容 | 顯示「需登入」提示卡，不轉址回 Instagram |
| 媒體 | 只存網址，不存 R2；簽章過期就算了（沿用 Threads 決定） |
| 專用網域 | `ig.ebfix.konnokai.me`（使用者 2026-10-04 決定） |
| Cloudflare 出口實測 | **不做**（使用者 2026-10-04 決定）。理由：同屬 Meta，Facebook 從 Cloudflare 出口正常運作。上線後由健康檢查監控，被擋會收到 Discord 通知 |
| Browser Run | 不做。Facebook 的研究結論（第 7 節）同樣適用：一律被標成 bot，沒登入也看不到更多 |

## 1. 範圍

要支援的內容：**未登入也看得到**的貼文。

- 一般貼文：單圖、多圖（輪播）、影片
- Reels（`/reel/`、`/reels/`）、舊的 IGTV（`/tv/`）
- 分享連結（`/share/reel/`、`/share/p/`）

不在範圍：

- 私人帳號、限時動態（`/stories/`）、精選動態、個人頁
- 留言內容
- 不登入呼叫 GraphQL（`/graphql/query`）：實測回 401，見第 3 節
- oEmbed API：要建立 Meta App、取得 app token，而且只回嵌入用的 HTML（沿用 Facebook 的判斷）

## 2. 參考專案：Wikidepia/InstaFix

- [InstaFix](https://github.com/Wikidepia/InstaFix)（ddinstagram 背後的程式）。2026-04-02 已封存，只讀。
- 作法同樣是讀公開 embed 頁產生 OG 標籤。ddinstagram 後來長期失效，
  [issue #122](https://github.com/Wikidepia/InstaFix/issues/122) 記錄 2024-09 embed 頁改版過一次。
- 本專案只參考作法，程式碼自己寫。

## 3. 實測結果（家中網路，2026-10-04）

UA 是 `ebfix/1.0 (+https://ebfix.konnokai.me)`，沒有 Cookie。

樣本：

| 代碼 | 內容 | 類型 |
| --- | --- | --- |
| `CuE2WNQs6vH` | Google 的 reel（2023-06-29） | `GraphVideo` |
| `Dc3zNGWlIpy` | NASA 兩張圖（2026-09） | `GraphSidecar` |
| `DdEy97xj9P-` | NASA 單圖（2026-09-09） | 單圖 |
| `DIgLLaiptZg` | IKEA Taiwan 的 reel（2025-04-16），由分享連結 `/share/reel/BAf7vyMOu4` 解析出來 | `GraphVideo` |
| `CuE2WNQs6vA` | 改一個字元的假代碼 | — |

### 各種抓法

| 抓法 | 結果 |
| --- | --- |
| `/p/{code}/embed/captioned/`：影片、多圖 | 200。script 裡的 `contextJSON` 有完整 JSON，見下一節 |
| 同上：單圖 | 200，但 `"contextJSON":null`。重抓 3 次、換 Discordbot UA、改用 `/embed/` 都一樣。HTML 有完整欄位，見下一節 |
| 同上：不存在的貼文 | 200，只有 `.EmbedBrokenMedia`。私人帳號、已刪除推測也長這樣（**沒有樣本，未驗證**） |
| `/reel/{code}/embed/captioned/` | 200，但只有一般 app 頁（約 620 KB），沒有貼文資料。**reel 也要用 `/p/{code}/embed/captioned/`**，代碼通用 |
| `/p/{code}/` 貼文頁 | 200，有 `og:title`、`og:description`、`og:image`、`og:url`。不存在的代碼也是 200，但沒有任何 og 標籤 |
| `/graphql/query?doc_id=...`（加 `x-ig-app-id`） | 401，不登入不能用 |
| `video_url`（`*.cdninstagram.com`，有時是 `instagram.*.fna.fbcdn.net`） | 不帶標頭、或帶 Discordbot UA，都回 206 `video/mp4`。兩種網域都測過。`oe` 參數顯示大約 1–2 天後過期（Facebook 約 5 天） |

### 分享連結

`/share/reel/BAf7vyMOu4`：

| 抓法 | 結果 |
| --- | --- |
| `www`，ebfix UA，有沒有結尾 `/` 都一樣 | 302，`Location` 是 `/reel/DIgLLaiptZg/?igsh=...` |
| `www`，不帶 UA | 同上 |
| `www`，Discordbot UA，沒有結尾 `/` | 302 到補上 `/` 的分享網址，第二跳才到貼文 |
| `HEAD` | 一樣回 302 和 `Location` |
| `m.instagram.com` | 301 回 `www`，沒有幫助 |
| 假的分享代碼 | 200，沒有轉址 |

`igsh` 是追蹤參數，要丟掉。`/share/p/...` 沒有樣本，沒測。

### 語言

不帶 `accept-language` 時，HTML 的 `lang` 是 `en`，但部分文字會跟著 IP 變成中文
（例如認證標章的 `<u>` 是「已驗證」）。帶 `accept-language: en-US,en;q=0.9` 後變成 `Verified`。
`?hl=en` 沒有用。**一律帶 `accept-language`**（跟 Facebook 一樣）。

### `contextJSON` 的欄位

`contextJSON` 是一段 JSON 字串（在 script 裡又被跳脫一次），內容是
`{ context: { type, shortcode }, gql_data: { shortcode_media } }`。`shortcode_media` 有：

| 資料 | 欄位 |
| --- | --- |
| 類型 | `__typename`：`GraphVideo`、`GraphSidecar`（單圖時沒有 JSON） |
| media ID | `id`，跟從代碼解出來的數字一樣 |
| 作者 | `owner.username`、`owner.is_verified`、`owner.profile_pic_url`（`s100x100`）。**沒有顯示名稱** |
| 內文 | `edge_media_to_caption.edges[0].node.text`，全文 |
| 互動數 | `edge_liked_by.count`、`edge_media_to_comment.count`（精確數字）。影片另有 `video_view_count` |
| 圖片 | `display_url`、`display_resources`（多種尺寸）、`dimensions` |
| 影片 | `video_url`、`video_duration`。reel 的 `product_type` 是 `clips` |
| 多圖 | `edge_sidecar_to_children.edges[].node`：`is_video`、`display_url`、`dimensions`（子項目是影片時應該有 `video_url`，**沒有樣本，未驗證**） |
| 時間 | **沒有** `taken_at_timestamp` |

### HTML 的欄位（單圖時唯一的來源）

| 資料 | 位置 |
| --- | --- |
| 作者 | `.UsernameText` 的文字 |
| 頭像 | `a.Avatar img` |
| 認證 | `.VerifiedSprite` |
| 內文 | `.Caption`，到 `.CaptionComments` 之前。開頭是 `a.CaptionUsername` 加兩個 `<br>`，要去掉。實測是全文：多圖和 reel 樣本跟 JSON 的內文逐字相同 |
| 圖片 | `img.EmbeddedMediaImage`（只有第一張；影片是封面） |
| 讚數 | `.SocialProof` 的文字，例如 `257,132 likes` |
| 留言數 | `.CaptionComments` 的文字，例如 `View all 777 comments` |
| 不可用 | `.EmbedBrokenMedia` |

### og 標籤

- `og:title`：`{顯示名稱} on Instagram: "{內文開頭}"`，例如 `IKEA Taiwan on Instagram: "..."`。這是唯一拿得到**顯示名稱**的地方。
- `og:description`：`{讚數} likes, {留言數} comments - {username} on {英文日期}: "{內文開頭}"`。
- `og:url`：`https://www.instagram.com/{username}/reel/{code}/` 或 `/{username}/p/{code}/`。
- `og:image`：一張圖（影片是封面）。

### 從代碼算發文時間

IG 代碼就是 media ID 的 URL-safe base64，可以沿用 [code.ts](../src/providers/threads/code.ts)。3 篇樣本都對得上：

| 代碼 | 算出的時間（UTC） | og 的日期 |
| --- | --- | --- |
| `CuE2WNQs6vH` | 2023-06-29T13:21:27Z | June 29, 2023 |
| `DIgLLaiptZg` | 2025-04-16T09:39:13Z | April 16, 2025 |
| `DdEy97xj9P-` | 2026-09-09T17:27:27Z | September 9, 2026 |

`code.ts` 的 `EARLIEST_MS` 是 Threads 上線日（2023-07），IG 不能用。IG 也不能用上線日（2010-10）：
早期貼文的 ID 是流水號，數字很小，解出來都落在紀元（2011-08-24）後幾秒內，會顯示錯的日期。
所以 IG 的下限是「紀元後一週」，這種舊 ID 一律不顯示時間。

## 4. 路由

### 路徑

| 類型 | 路徑 |
| --- | --- |
| 貼文 | `/p/{code}`、`/{username}/p/{code}` |
| Reels | `/reel/{code}`、`/reels/{code}`、`/{username}/reel/{code}` |
| IGTV | `/tv/{code}` |
| 分享 | `/share/reel/{shareCode}`、`/share/p/{shareCode}`、`/share/{shareCode}`（後兩種沒有樣本） |

- `{code}` 是 `[A-Za-z0-9_-]+`。query string 一律丟掉（`igsh`、`utm_source`、`img_index` 等）。
- 同一篇貼文不論從哪個路徑進來，`post_key` 都是 `{code}`。分享連結用 `share:{shareCode}`，解析後改成 `{code}`（跟 Threads 一樣）。
- 原文網址：有 `{username}` 時用 `/{username}/p/{code}/`，沒有時用 `/p/{code}/`。reel 也可以用 `/p/`，Instagram 會自己導過去。

### 網域

| 路徑 | `ebfix.konnokai.me` 上給誰 | 衝突 |
| --- | --- | --- |
| `/p/{code}`、`/reels/`、`/tv/`、`/{username}/p/`、`/{username}/reel/` | Instagram | 沒有 |
| `/reel/{code}` | 純數字給 Facebook，其他給 Instagram | Facebook 的 `/reel/(\d+)` |
| `/share/reel/{x}` | Instagram | 沒有（Facebook 只有 `p`、`r`、`v`） |
| `/share/p/{x}` | Facebook | Facebook 的 `/share/p/` |
| `/share/{x}` | Threads | Threads 的 `/share/{shareCode}` |

- 專用網域 `ig.ebfix.konnokai.me`：只服務 Instagram，上表全部路徑都歸 Instagram。
- `router.ts` 的 `PROVIDERS` 把 instagram 排在 facebook **後面**，這樣純數字的 `/reel/` 和 `/share/p/` 在共用網域上照舊給 Facebook。
- `HOST_PROVIDERS` 加一行 `"ig.ebfix.konnokai.me": [instagram]`。
- Custom Domain 在 dashboard 加（Workers → `naver-cafe-embed-fix` → Settings → Domains & Routes → Add → Custom Domain），
  不寫進 `wrangler.jsonc`（理由同 Facebook F4）。

## 5. Fetcher 順序

所有請求：ebfix UA、`accept-language: en-US,en;q=0.9`、`redirect: "manual"`、只跟隨 `instagram.com` 網域內的轉址。

1. **resolve（只有分享連結需要）**：`GET https://www.instagram.com/share/.../`（**帶結尾 `/`**，少一跳），只看 `Location`。
   - `Location` 是貼文網址（`/reel/{code}/`、`/p/{code}/`、`/{username}/p/{code}/`）→ 取出代碼，丟掉 `igsh`。
   - 回 200、沒有轉址 → `transient`。假代碼也是這樣，分不出是失效還是格式改變（跟 Threads、Facebook 一樣）。
   - 轉到登入頁或其他網址 → `transient`。
2. **embed**：主要來源。`GET https://www.instagram.com/p/{code}/embed/captioned/`。
   - 用 `HTMLRewriter` 走一次：同時取 script 文字裡的 `contextJSON`，和第 3 節的 HTML 欄位。
     `contextJSON` 先 `JSON.parse` 字串，再 `JSON.parse` 一次。不要用一個正規表示式處理整份 HTML。
   - 有 `contextJSON`：用 JSON 的欄位。HTML 欄位只用來補頭像等缺的東西。
   - `contextJSON` 是 `null`：用 HTML 欄位。
   - 有 `.EmbedBrokenMedia` → 回 `transient`，交給 og 那一層決定（跟 Facebook plugin 的 `no longer available` 一樣處理）。
   - 結構認不得（沒有 JSON，也沒有 `.UsernameText`）→ `transient`。
3. **og**：`GET https://www.instagram.com/p/{code}/`。
   - 有 `og:title` → 公開貼文，取顯示名稱、內文開頭、一張圖。內文只有開頭，沒有影片。
   - 200 但沒有 og 標籤 → `login_required`（卡片寫「需登入，也可能是私人帳號或已刪除」）。
   - 被導到 `/accounts/login` → `login_required`。

**顯示名稱**：embed 沒有，只有 og 有。為了一個名稱多抓一次約 620 KB 的頁面不划算，
所以 embed 成功時 `author.name` 留空，只顯示 `@username`（跟 Threads 一樣）。

## 6. 資料對應

| `NormalizedPost` | 來源 |
| --- | --- |
| `title` | `@{username}` |
| `siteName` | `Instagram` |
| `author.name` | embed：空字串。og：`og:title` 的顯示名稱 |
| `author.handle` / `avatar` / `verified` / `url` | `owner.username` / `owner.profile_pic_url` / `owner.is_verified` / `https://www.instagram.com/{username}/` |
| `text` | 內文全文 |
| `media` | 影片：一個 `video`。多圖：每個子項目，影片子項目用 `video_url`，最多 10 個（Discord 上限）。單圖：一個 `image` |
| `stats` | `likes`＝讚數、`replies`＝留言數。JSON 是精確數字，轉成跟 embed 頁一樣的千分位文字（`214,767`）；og 是縮寫（`44K`） |
| `createdAt` | 從代碼算（第 3 節） |

- D1 不用改 schema，`platform = 'instagram'`。
- 快取：公開貼文 600 秒、狀態卡 60 秒（跟 Threads 一樣）。
- 健康檢查樣本：`/p/CuE2WNQs6vH`（Google 的 reel，2023 年，有 `contextJSON` 和 `video_url`）。

### 媒體品質

- 圖片：`display_resources` 有多種尺寸，取最大的（樣本的最大寬度：多圖 1158、reel 封面 720 和 960）。單圖只有 HTML 的 `EmbeddedMediaImage`，直接用。
- 影片：`video_url` 簽章只有 1–2 天，比 Facebook 短。D1 存的舊版本過期後影片會播不了，沿用「簽章過期就算了」的決定。

## 7. 實作階段

### 階段 I1：provider 基本版（**完成，2026-10-04**，分支 `feat/instagram-provider`）

- `src/providers/instagram/{index.ts, http.ts, embed.ts, og.ts}`，router 加入 instagram（排在 facebook 後面）。
- 從代碼算時間：`createdAtFromCode` 的最早時間改成參數（`THREADS_EARLIEST_MS`、`INSTAGRAM_EARLIEST_MS`），Threads 和 Instagram 共用。
- fixture 存到 `test/providers/instagram/fixtures/`，用第 3 節的樣本重新下載（帶 `accept-language`）：
  - `embed-video.html`（`CuE2WNQs6vH`）、`embed-sidecar.html`（`Dc3zNGWlIpy`）、`embed-image.html`（`DdEy97xj9P-`，沒有 JSON）、
    `embed-reel-zh.html`（`DIgLLaiptZg`，中文內文）、`embed-broken.html`（假代碼）。
    原檔 220–280 KB，大多是 script；只留含 `contextJSON` 的那段 script，其他 script、style、link 都拿掉（87–141 KB）
  - `og-public.html`、`og-missing.html`：只留 `<head>`，再拿掉 script 和 style。原檔約 620–690 KB
- 用 fixture 寫解析測試，再寫 worker 測試（照 `test/providers/threads/` 的寫法）。
- 驗收：`npm test`、`npm run typecheck` 通過。每一種 fixture 都有測試。
- 結果：`npm test` 213 個測試通過（Instagram 50 個），`npm run typecheck` 通過。
  另外用 `wrangler dev --local`（家中網路）打真的 Instagram：單圖、多圖、兩個 reel 都拿到內容和互動數，影片有 `og:video`；
  假代碼顯示需登入卡。
- 實作時新增的規則：
  - `contextJSON` 的 `shortcode` 跟網址的代碼不一樣時，不用 JSON，改用 HTML 欄位。
  - 媒體網址只接受 https 的 `*.cdninstagram.com`、`*.fbcdn.net`。帶 `accept-language` 抓時，有些網址在 `instagram.*.fna.fbcdn.net`。
- 還沒做：健康檢查樣本（I3 才加，理由同 Facebook F1）。

### 階段 I2：分享連結與專用網域（**完成，2026-10-04**）

- `src/providers/instagram/share.ts`。轉址回應用 stub 產生，不用存檔。
- `HOST_PROVIDERS` 加 `ig.ebfix.konnokai.me`。
- 測試共用網域的衝突規則：純數字 `/reel/`、`/share/p/` 給 Facebook，`/share/{x}` 給 Threads。
- 驗收：`/share/reel/` 能解析到貼文，或回 `transient`。不會轉址回 Instagram。
- 結果：`npm test` 235 個測試通過（Instagram 72 個），`npm run typecheck` 通過。
  `wrangler dev --local` 打真的 `/share/reel/BAf7vyMOu4`（有沒有結尾 `/`、有沒有 `igsh` 都一樣）：解析到 `DIgLLaiptZg`，有內文、互動數和 `og:video`。
  假的分享代碼回 503 卡片，`og:url` 和原文連結留在分享網址。
- 實作時新增的規則：
  - `/share/p/{x}`、`/share/reel/{x}` 也符合 `/{username}/p|reel/{code}` 的格式，所以 username 是 `share` 時不當成貼文。
  - 分享頁回 200 時，跟 Threads、Facebook 一樣讀 `og:url` 和 canonical。都沒有就回 `transient`（`share_unresolved`）。
  - 解析失敗時，卡片的 `og:url` 和原文連結用分享網址本身。

### 階段 I3：上線（**要使用者同意才做**）

- Cloudflare dashboard 新增 Custom Domain `ig.ebfix.konnokai.me`（使用者操作）。
- 健康檢查加 Instagram 樣本 `/p/CuE2WNQs6vH`，失敗會走現有的 Discord webhook 通知。**完成。**
- 更新 README。**完成。**
- push 後由 Workers Builds 部署。這次不用 migration。
- 上線後先用 curl 測一次。**這是第一次從 Cloudflare 出口抓 Instagram**，被擋的話健康檢查會失敗、送 Discord 通知。
- 在 Discord 實測：單圖、多圖、影片、reel、分享連結、不存在的貼文、影片能不能播放。

## 8. 待確認事項

1. **Cloudflare 出口會不會被擋**：沒有實測（第 0 節）。被擋的話，先看 og 層還能不能用，再決定下一步。
2. **私人帳號、已刪除、年齡限制的貼文**：沒有樣本。推測 embed 都是 `.EmbedBrokenMedia`、og 沒有標籤，會顯示需登入卡。
3. **多圖裡的影片**：沒有樣本，`video_url` 欄位位置未驗證。
4. **`/share/p/`、`/share/{x}`**：沒有樣本，推測跟 `/share/reel/` 一樣是 302。
5. ~~共用網域要不要也服務 Instagram~~：要，不衝突的路徑兩邊都能用（使用者 2026-10-04 決定）。

## 9. 參考資料

- InstaFix：https://github.com/Wikidepia/InstaFix
- InstaFix issue #122（embed 頁改版）：https://github.com/Wikidepia/InstaFix/issues/122
- Instagram oEmbed：https://developers.facebook.com/docs/instagram-platform/oembed
