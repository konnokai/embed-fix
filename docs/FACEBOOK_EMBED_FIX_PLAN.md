# Facebook Embed Fix 計畫

更新日期：2026-10-03

狀態：F0、F1、F2、F4 完成，已上線（2026-10-03）。F3（Browser Run）沒做。共用架構（router、pipeline、page、D1、健康檢查）沿用
[THREADS_EMBED_FIX_PLAN.md](THREADS_EMBED_FIX_PLAN.md)，本文件只寫 Facebook 不一樣的地方。

第 3 節分兩部分：先在家中網路初測，再用 F0 從 Cloudflare 出口（新加坡機房 SIN）重測。
**實作以 Cloudflare 出口的結果為準。**

## 0. 已確定的決定

| 項目 | 決定 |
| --- | --- |
| 架構 | 新增 `src/providers/facebook/`，跟 Naver、Threads 一樣是一個 provider |
| 帳號 | 不登入、不帶 Cookie、不用任何 Facebook 帳號或 token（沿用 Threads 規則） |
| 需登入的內容 | 顯示「需登入」提示卡，不轉址回 Facebook |
| 媒體 | 只存網址，不存 R2；簽章過期就算了（沿用 Threads 決定） |
| Browser Run | 只當最後一層，預設關閉，先實測再決定要不要上線 |
| 專用網域 | `fb.ebfix.konnokai.me`（使用者 2026-10-03 決定） |
| Workers 方案 | Paid |

## 1. 範圍

要支援的內容：**未登入也看得到**的貼文。

- 粉絲專頁、公開個人檔案的貼文（文字、單圖、多圖、影片）
- Reels 與影片（`/reel/`、`/videos/`、`/watch`）
- 相片（`/photo/?fbid=`）
- 分享連結（`/share/p/`、`/share/r/`、`/share/v/`、`/share/{hash}`）
- 公開社團的貼文：只有 og 標籤（標題、內文開頭、一張圖），見第 3 節

不支援 `fb.watch`：從 Cloudflare 出口一律被導到登入頁，而且會無限轉址。

不在範圍：

- 私人社團、只限朋友的貼文、限時動態、Marketplace、活動頁
- 留言內容
- 模仿 Chrome TLS 指紋：facebed 用 `curl_cffi` 偽裝成 Chrome。Workers 的 `fetch` 不能改 TLS 指紋，所以做不到
- Graph API / oEmbed API：要建立 Meta App、取得 app token，而且 oEmbed 只回嵌入用的 HTML，不回內容欄位

## 2. 參考專案：facebed/facebed

讀過 `facebed.py`（單一檔案，約 4,000 行）、`requirements.txt`、`Dockerfile`、README、issue #1–#22。

- **授權：repo 沒有 LICENSE 檔，GitHub API 回 `license: null`。** 預設保留所有權利，所以**不能複製它的程式碼**。只參考它的作法，程式碼自己寫。
- 技術：Python、`curl_cffi` 偽裝 Chrome 146、bottle、BeautifulSoup。
- 抓法：抓未登入的 `www.facebook.com/{path}` 頁面，從 `<script type="application/json">` 裡的 Relay 資料取欄位
  （`creation_story`、`actors[0].name`、`message.text`、`browser_native_hd_url`、`feedback` 等）。不用 headless 瀏覽器、不用 proxy、不用 `plugins/post.php`。
- 分享連結：先用 `HEAD` 跟隨轉址。拿不到貼文網址時，改用 Discordbot UA 抓頁面，讀 canonical / `og:url`，
  排除 `login`、`checkpoint`、`recover`。
- 已知問題：
  - 放在機房的公開站常常失效，本機卻正常（issue #16、#19，推測是機房 IP 被擋）。
  - `/share/p/` 轉到 `story.php` 後常遇到登入牆（#8、#10、#16）。
  - `/{user}/posts/pfbid...` 時好時壞（#9、#13）。
  - 依賴 Facebook 內部的 Relay 欄位名稱，程式裡有很多「Facebook 改版後」的備援。
- 可以學的：支援的路徑清單、分享連結的兩段式解析、影片優先 HD 再 SD、登入牆的判斷方式。

## 3. 實測結果

UA 都是 `ebfix/1.0 (+https://ebfix.konnokai.me)`，沒有 Cookie。

### F0：Cloudflare 出口（2026-10-03，臨時 Worker `ebfix-f0-probe`，機房 SIN，測完已刪除）

樣本來自 facebed 的 issue 和公開粉專，共 15 個貼文網址、12 個分享連結。

| 樣本 | `plugins/post.php` | `www` 頁 |
| --- | --- | --- |
| 粉專貼文 `/{user}/posts/pfbid...`（NASA 多圖、Malta 單圖、花體字貼文） | 全部有內文、時間、圖片、互動數 | og 標籤 |
| 影片 `/{user}/videos/...`、`/reel/{id}`、`/watch/?v=` | 全部有內文和 `hd_src`／`sd_src`；**沒有** `data-utime` | og 標籤，標題是 `N views · N reactions \| 內文` |
| `/photo/?fbid=` | 有內文、時間、圖片 | 導到登入頁 |
| `/story.php?story_fbid=&id=`、`/permalink.php?story_fbid=pfbid...&id=` | 有內文、時間、圖片 | 導到登入頁 |
| 社團貼文 `/groups/{id}/posts/{id}`、`/permalink/{id}` | `no longer available` | og 標籤（標題是 `社團名 \| 內文開頭`） |
| 網址帶越南文 slug 的貼文 | `no longer available` | og 標籤 |
| 不存在的貼文 | `no longer available` | 沒有 og 標籤 |

plugin 回應時間 200–1,400 ms。

分享連結（不跟隨轉址，看第一個 `Location`）：

| 抓法 | 結果 |
| --- | --- |
| `www.facebook.com/share/...`，ebfix UA | 大多導到登入頁；偶爾成功 |
| `www.facebook.com/share/...`，HEAD（facebed 的作法） | 12 個裡只有 1 個成功 |
| `www.facebook.com/share/...`，不帶 UA | 一律 `unsupportedbrowser` |
| **`m.facebook.com/share/...`，ebfix UA** | **兩輪共 22/24 成功**。失敗的是同一個舊格式連結 `/share/p/C3Dx...`（回 200、沒有轉址，推測已失效） |
| `mbasic.facebook.com/share/...` | 4/4 成功 |
| `plugins/post.php?href={分享連結}` | `no longer available`，plugin 不會幫忙解析 |
| `fb.watch/{code}` | 不論哪種 UA，都導到 `www.fb.watch/login`，而且無限轉址 |

`m.facebook.com` 轉到的網址有：`/permalink.php`、`/story.php`、`/reel/{id}`、`/{user}/videos/{id}`、`/events/...`。
換成 `www.facebook.com`，去掉 `rdid`、`share_url` 參數，再交給 plugin。測了 11 個，8 個抓到內容；
另外 3 個是活動頁（不支援）或本來就不公開的貼文。

影片網址（`video.xx.fbcdn.net`）：不帶任何標頭、或帶 Discordbot UA，都回 206 `video/mp4`。
網址的 `oe` 參數顯示大約 5 天後過期。F4 在 Discord 實測可以播放。

### 家中網路初測（2026-10-03，F0 之前）

| 抓法 | 結果 |
| --- | --- |
| `www.facebook.com/{path}`，ebfix UA 或 Discordbot UA | 200。有 `og:title`（粉專名稱）、`og:description`（內文）、`og:image`、canonical。**沒有** Relay JSON，所以拿不到時間、多張圖、影片網址 |
| 同上，一般 Chrome UA | **400**（Facebook 擋掉沒有完整瀏覽器標頭的「瀏覽器」請求） |
| `www.facebook.com/photo/?fbid=...` | 200，但沒有任何 og 標籤 |
| `plugins/post.php?href={貼文網址}&locale=en_US` | 200。可見 HTML 有作者、頭像、內文、時間、圖片、互動數；影片貼文還有 `hd_src` / `sd_src` |
| `plugins/post.php`，用 `/reel/{id}/` 網址 | 200，有作者、內文、`hd_src` |
| `plugins/post.php`，不存在或不公開的貼文 | 200，內文是 `This Facebook post is no longer available...`，**分不出**是刪除還是不公開 |
| `plugins/post.php`，`photo/?fbid=` 網址 | 用自己湊的 ID 測，回「no longer available」。F0 用真實樣本測是成功的 |
| `plugins/video.php` | 有 `hd_src`，但沒有內文；`post.php` 已經涵蓋，不需要這個 |
| 假的 `/share/p/...` | 200，沒有轉址 |
| 真實分享連結（`www`，ebfix UA） | 302 到貼文網址。**跟 Cloudflare 出口不一樣**，Cloudflare 出口多半被導到登入頁 |

### `plugins/post.php` 的欄位位置（F0 樣本確認過）

| 資料 | 位置 |
| --- | --- |
| 作者 | 頭像 `img` 的 `aria-label`，或作者連結的 `title` |
| 頭像 | 帶 `aria-label` 的小圖（`stp` 是 `s40x40` 或 `s50x50`） |
| 內文 | `[data-testid="post_message"]`，段落是 `<p>`；emoji 是 `span._5mfr` 包住的文字。被摺疊的部分已經在 HTML 裡（`.text_exposed_show`），直接讀；`.text_exposed_hide` 只有 `...` 和 `See more` 連結，要跳過 |
| 時間 | `abbr[data-utime]`，Unix 秒數。**影片貼文沒有這個元素** |
| 圖片 | class 不固定：多圖是 `scaledImageFitWidth`／`scaledImageFitHeight`，單圖是 `_1p6f _1p6g`，`story.php` 樣本是 `_46-i`。改用「頭像以外、網域是 `scontent` 的 `img`」來找。**都是縮圖**（`p394x394`、`p403x403`、`s206x206`），網址有簽章，不能改尺寸參數。圖片有 `caption` 屬性（替代文字） |
| 互動數 | `div[title="Like"]`、`div[title="Comment"]`、`div[title="Share"]` 的文字（例如 `18K`、`301`、`2.8K`） |
| 數字貼文 ID | 留言按鈕的連結 `a._29bd[href]`，例如 `https://www.facebook.com/NASA/posts/1602283071267063?ref=embed_post`；分享按鈕的 `sharer.php?u=` 也有 |
| 影片 | script 文字裡的 `"hd_src":"..."`、`"sd_src":"..."`（JSON 字串跳脫過） |
| 不可用 | 內文含 `This Facebook post is no longer available` |

注意：沒帶 `locale=en_US` 時，回應語言跟著 IP 變（樣本是繁體中文）。一律帶 `locale=en_US`。

## 4. 路由

### 路徑

| 類型 | 路徑 |
| --- | --- |
| 貼文 | `/{user}/posts/{pfbid 或數字}`、`/permalink.php?story_fbid=&id=`、`/story.php?story_fbid=&id=` |
| 影片 | `/reel/{id}`、`/{user}/videos/{slug}/{id}`、`/{user}/videos/{id}`、`/watch/?v={id}` |
| 相片 | `/photo/?fbid=`、`/photo.php?fbid=` |
| 社團 | `/groups/{group}/posts/{id}`、`/groups/{group}/permalink/{id}`（只有 og） |
| 分享 | `/share/p/{hash}`、`/share/r/{hash}`、`/share/v/{hash}`、`/share/{hash}` |

- 這裡用 query string 判斷貼文（`story_fbid`、`id`、`fbid`、`v`）。這跟 Threads 不同：Threads 的 query 一律丟掉。
  Facebook 只保留這幾個參數，其他的（`mibextid`、`rdid`、`share_url` 等追蹤參數）丟掉。
- `m.facebook.com`、`web.facebook.com` 的網址路徑相同，使用者換網域就能用。

### 網域

`/share/{hash}` 跟 Threads 的 `/share/{shareCode}` 一模一樣，從路徑分不出是哪個平台。

- `ebfix.konnokai.me`：支援上表中**不衝突**的 Facebook 路徑。`/share/{hash}` 照舊給 Threads。
- 專用網域 `fb.ebfix.konnokai.me`：只服務 Facebook，`/share/{hash}` 歸 Facebook。
- 在 `router.ts` 的 `HOST_PROVIDERS` 加一行 `"fb.ebfix.konnokai.me": [facebook]`。
- 這個子網域要在 Worker 另外加 Custom Domain（dashboard：Workers → `naver-cafe-embed-fix` → Settings →
  Domains & Routes → Add → Custom Domain），DNS 記錄和憑證由 Cloudflare 自動建立。F4 做。

## 5. Fetcher 順序

1. **resolve（只有分享連結需要）**：`GET https://m.facebook.com/share/...`，ebfix UA，`redirect: "manual"`，只看第一個 `Location`。
   - `Location` 是 facebook.com 的貼文網址 → 換成 `www.facebook.com`，去掉追蹤參數，交給下一步。
   - `Location` 含 `/login`、`unsupportedbrowser`、`checkpoint` → 改用 `mbasic.facebook.com` 再試一次。
   - 轉到活動頁、Marketplace 等不支援的類型 → `not_found`，顯示「不支援的內容」狀態卡。
   - 都失敗 → `transient`，不轉址。
2. **plugin**：主要來源。`GET https://www.facebook.com/plugins/post.php?href={www 貼文網址}&locale=en_US`。
   - 用 `HTMLRewriter` 解析第 3 節的欄位。影片網址只在 script 文字裡，先用 `HTMLRewriter` 取出 script 文字，再在那段文字裡找 `hd_src` / `sd_src`。不要用一個正規表示式處理整份 HTML。
   - `no longer available` → 不能直接當成需登入，因為社團貼文和帶 slug 的網址也會這樣。回 `transient`，讓 og 那一層決定。
   - 結構認不得 → `transient`，交給下一層。
3. **og**：`GET www.facebook.com/{path}`，ebfix UA，跟隨轉址。只取 `og:title`、`og:description`、`og:image`。
   - 影片的 `og:title` 格式是 `40M views · 241K reactions | {內文}`；社團是 `{社團名} | {內文}`，要拆開。
   - 被導到 `/login` 或沒有 og 標籤 → `login_required`（提示卡跟 Threads 一樣：「需登入，也可能是私人或已刪除」）。
   - 注意：`story.php`、`permalink.php`、`photo` 的 www 頁一律導到登入頁。plugin 失敗時，這三種會顯示需登入。
4. **browser（Browser Run）**：預設關閉，見第 7 節。

## 6. 資料對應

| `NormalizedPost` | 來源 |
| --- | --- |
| `title` | 作者名稱 |
| `siteName` | `Facebook`。社團貼文的 og 沒有作者，`title` 改用社團名 |
| `author.name` / `avatar` / `url` | 作者名稱、頭像、作者連結 |
| `text` | 內文。`l.facebook.com/l.php?u=` 的外部連結要還原成原網址 |
| `media` | 有影片：一個 `video`（HD 優先，沒有就 SD）。沒有影片：圖片，最多 10 張 |
| `stats` | `likes`＝心情數、`replies`＝留言數、`shares`＝分享數 |
| `createdAt` | `abbr[data-utime]`。影片貼文沒有，設成 null |

- `post_key`：同一篇貼文可能有好幾種網址（pfbid、數字 ID、分享連結、reel ID）。
  pipeline 在抓取**之前**就要用 key 查 D1 舊版本，所以 key 只能從網址算出來：
  `posts:{pfbid 或數字}`、`video:{id}`（reel、videos、watch 共用）、`story:{story_fbid}`、`photo:{fbid}`、`group:{groupId}/{postId}`。
  分享連結用解析後的網址算。同一篇用不同網址進來，可能存成好幾筆，可以接受。
  留言按鈕連結裡的數字 ID（例如 `NASA/posts/1602283071267063`）只拿來組 `author.url` 和原文按鈕。
- D1 不用改 schema，`platform = 'facebook'`。
- 快取：公開貼文 600 秒、狀態卡 60 秒（跟 Threads 一樣）。
- 健康檢查樣本：`/reel/2300161320399228`（Zuckerberg 公開影片，有內文和 `hd_src`）。

### 媒體品質

- plugin 頁的圖片是縮圖（最大邊約 400px）。網址有簽章，改尺寸參數會失效。
- 只有一張圖時，`og:image` 也只有約 600–720px（`ctp=p600x600`、`cstp=mx720x900`），卻要多抓一次 www 頁（約 350 KB）。
  F1 決定不多抓，plugin 有內容就用 plugin 的圖。
- 影片網址不帶標頭就能下載（F0 確認），大約 5 天後過期。Discord 可以直接播放（F4 實測）。

## 7. Browser Run

研究結果（[官方文件](https://developers.cloudflare.com/browser-run/)，2026-10）：

- 名稱已經從 Browser Rendering 改成 **Browser Run**。
- 設定：`"browser": { "binding": "BROWSER" }`，套件 `@cloudflare/puppeteer`，需要 `nodejs_compat`
  （compatibility date `2026-08-04` 起預設開啟，本專案是 `2026-09-22`）。
  也可以用 `env.BROWSER.quickAction("content", { url })` 直接拿渲染後的 HTML（compat date `2026-03-24` 以上）。
- 額度：

  | | Workers Free | Workers Paid |
  | --- | --- | --- |
  | 瀏覽器時間 | 每天 10 分鐘 | 每月含 10 小時，之後每小時 $0.09 |
  | 同時瀏覽器 | 3 | 10 個以內免費，上限 200 |
  | 開新瀏覽器 | 每 20 秒 1 個 | 每秒 3 個 |

- **很可能被 Facebook 擋。** 官方文件寫明 Browser Run 的請求「一律被標成 bot」。請求來自 Cloudflare 的 IP 範圍，
  而且一定帶 `cf-brapi-devtools` 和 Web Bot Auth 簽章（`Signature-agent`、`Signature`），無法移除。
  facebed 的經驗是機房 IP 常被擋，Browser Run 的條件更差。
- 本專案是 Paid 方案，額度不是問題（每月 10 小時）。
- 結論：F0 顯示 plugin 已經涵蓋大部分公開內容。Browser Run 能補的只有社團貼文和 plugin 失敗的貼文，
  但這些在 www 頁本來就需要登入，Browser Run 沒登入也一樣看不到。所以 F3 只做實驗：
  用 F0 的樣本比較 plugin 和 Browser Run，沒有多抓到東西就不做這一層。
  要做的話，照主計畫第 8 節的規則：預設關閉、每日次數上限、同一篇只開一個瀏覽器。

## 8. 實作階段

### 階段 F0：從 Cloudflare 出口驗證（**完成，2026-10-03**）

- 作法：部署臨時 Worker `ebfix-f0-probe`（只放行 facebook.com、fb.watch、fbcdn.net），測完已刪除。
  `wrangler dev --remote` 回的是 ebfix 本身的 400 頁，原因沒查，改用臨時 Worker。
- 結果見第 3 節。plugin 從 Cloudflare 出口能拿到公開貼文的內容，分享連結改用 `m.facebook.com` 解析。
- fixture 已存到 `test/providers/facebook/fixtures/`：
  - `plugin-multi-image.html`（NASA，4 張圖）、`plugin-single-image.html`、`plugin-photo.html`、
    `plugin-story-php.html`、`plugin-styled-text.html`（Unicode 花體字）、`plugin-video.html`、`plugin-reel.html`、
    `plugin-unavailable.html`
  - `og-group.html`、`og-reel.html`、`www-login.html`：www 頁只留 `<head>`，原檔每個 350–470 KB
- 沒做到：Discord 實際播放 Facebook 影片（要貼到 Discord 才能測），移到 F4。

### 階段 F1：provider 基本版（**完成，2026-10-03**，分支 `feat/facebook-provider`）

- `src/providers/facebook/{index.ts, http.ts, plugin.ts, og.ts}`，router 加入 facebook。
- 用 fixture 寫解析測試，再寫 worker 測試（照 `test/providers/threads/` 的寫法）。
- 驗收：`npm test`、`npm run typecheck` 通過。每一種 fixture 都有測試。
- 結果：`npm test` 150 個測試通過（Facebook 48 個），`npm run typecheck` 通過。
- 還沒做：健康檢查樣本（F4 才加，不然還沒上線就會開始通知）。
- 互動數的分享數存在 `stats.shares`。Discord 底部目前只顯示心情數和留言數，跟 Threads 一樣。

### 階段 F2：分享連結與專用網域（**完成，2026-10-03**）

- `src/providers/facebook/share.ts`。分享連結的 fixture 是轉址回應，測試用 stub 產生，不用存檔。
- `HOST_PROVIDERS` 加 `fb.ebfix.konnokai.me`。
- 驗收：p/r/v/`{hash}` 分享連結都能解析到貼文，或回 `transient`。不會轉址回 Facebook。
- 結果：`npm test` 161 個測試通過，`npm run typecheck` 通過。
- 共用網域上，`/share/p/`、`/share/r/`、`/share/v/` 給 Facebook（Threads 沒有這種路徑），`/share/{hash}` 照舊給 Threads。
- 轉到活動頁、Marketplace、限時動態：`not_found`（卡片寫「不支援的內容」），不再試 mbasic。
  轉到其他認不得的網址：`transient`，可能是新的網址格式。

### 階段 F3：Browser Run 實驗（選做）

- 見第 7 節。只在本機和 `wrangler dev --remote` 測試，不上線。
- 驗收：寫一份比較表放進本文件，再決定要不要做。

### 階段 F4：上線（**要使用者同意才做**）

- Cloudflare 新增 Custom Domain `fb.ebfix.konnokai.me`。用 dashboard 加，不寫進 `wrangler.jsonc`：
  現有的兩個網域也是在 dashboard 設定的，在設定檔宣告 `routes` 可能讓部署時覆蓋掉它們（未驗證，不冒險）。
- 健康檢查加 Facebook 樣本（`/reel/2300161320399228`），失敗會走現有的 Discord webhook 通知。**完成。**
- 更新 README。**完成。**
- push 後由 Workers Builds 部署。這次不用 migration。
- 在 Discord 實測：文字、多圖、影片、reel、分享連結、需登入。
- 結果（2026-10-03）：
  - `b16462f` 部署後，`ebfix.konnokai.me` 與 `fb.ebfix.konnokai.me` 的貼文、reel、影片、社團、p/r/v/`{hash}` 分享連結都用 curl 測過。
    `fb.ebfix.konnokai.me` 不服務 Threads、Naver 網址（400）。
  - Discord 實測：reel 影片可以直接播放，多圖貼文顯示 4 張圖。
  - 線上測試找到一個問題：影片的 og:title 是「觀看數 · 心情數 | 內文 | 作者」，原本沒讀最後一段，
    網址第一段又是數字 ID 時，標題會變成那串數字。已修正：取最後一段當作者，數字 ID 不當名稱。

## 9. 待確認事項

1. ~~專用網域~~：已決定 `fb.ebfix.konnokai.me`。
2. ~~Workers 方案~~：Paid。
3. **公開社團貼文**：plugin 不支援，只拿得到 og（社團名、內文開頭、一張圖）。先用 og 支援，之後有需要再看 Browser Run。
4. ~~plugin 回 `no longer available` 時要不要再抓 www 頁~~：要（使用者 2026-10-03 決定）。F1 已照這樣做。

## 10. 參考資料

- facebed：https://github.com/facebed/facebed （沒有授權條款，只參考作法）
- Browser Run：https://developers.cloudflare.com/browser-run/
- Browser Run 額度：https://developers.cloudflare.com/browser-run/limits/ 、https://developers.cloudflare.com/browser-run/pricing/
- Browser Run 自動帶的標頭：https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/
- Facebook 嵌入貼文說明：https://www.facebook.com/help/1570724596499071
