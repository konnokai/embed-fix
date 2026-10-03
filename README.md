# ebfix

Cloudflare Worker that turns post links from several platforms into Open Graph
HTML plus a Discord Components V2 payload, so chat clients can unfurl a preview
from the raw response. Design and roadmap: `docs/THREADS_EMBED_FIX_PLAN.md`.

## 支援的網址

路徑和原平台一樣，只換網域。

| 平台 | 路徑 |
| --- | --- |
| Naver Cafe | `/f-e/cafes/{cafeId}/articles/{articleId}`、`/ca-fe/cafes/{cafeId}/articles/{articleId}` |
| Threads | `/@{username}/post/{code}`、`/t/{code}`、`/share/{shareCode}` |

- `ebfix.konnokai.me`：所有平台。
- `cafe.konnokai.me`：舊網域，只有 Naver，舊連結行為不變。
- 其他路徑回 HTTP 400，不請求上游。query string（例如 Threads 的 `?xmt=`）一律丟掉。

## 行為

- 依序執行各平台的 fetcher；只有 `transient` 會換下一層。fetcher 丟例外時記錄
  `fetcher_failed` 並當成 `transient`。
- 公開貼文：標題、作者、內文、圖片／影片；有圖才輸出 `og:image`，有影片輸出
  `og:video` 系列標籤。
- 需登入／已刪除／已遮蔽：回 HTTP 200 的提示卡片，讓 Discord 讀得到。
- 上游限流或失敗：回 HTTP 503 且 `cache-control: no-store`。
- 抓不到內容時**絕不**用 HTTP 轉址回原平台（原平台只回空殼給 unfurler）。
- 一般訪客用 `meta refresh` 跳回原文。

### Naver Cafe

- 每次請求都匿名重查文章 API；不快取。
- 資料庫已有該文章內容時，文章轉為需登入或刪除後仍回資料庫中的內容。

### Threads

- 不登入、不帶 Cookie。所有請求都帶 `User-Agent: ebfix/1.0 (+https://ebfix.konnokai.me)`：
  不帶 UA 會被導到 `facebook.com/unsupportedbrowser`，瀏覽器 UA 只拿到沒內容的 SPA 頁
  （2026-10-03 實測）。
- 順序：share 轉址解析 → `/t/{code}/embed` 頁 → 貼文頁 og 標籤。
- embed 頁顯示 `Thread not available` 時回「需登入的貼文」卡片。未登入時分不出需登入、
  私人帳號或已刪除，卡片文字會寫明。
- Discord 預覽：頭像縮圖、作者連結、主題標籤（`Threads › 主題`）、互動數（照 Threads 顯示的
  縮寫，例如 `5.9K`）、發文時間（Discord 時間戳，依觀看者時區顯示）、原貼文與作者頁按鈕。
- 發文時間由貼文代碼算出：代碼是 Instagram media ID，高位元是建立時間。embed 頁只有在地化文字。
- 引用貼文的內文由 script 填入，只顯示被引用的帳號。
- Cache API：公開貼文 600 秒、狀態卡 60 秒、503 不快取。只在 Custom Domain 上有效。
- 和 Naver 一樣保存到 D1；貼文轉為需登入或刪除後仍回資料庫中的內容。存的圖片／影片網址有簽章，
  可能已過期。

### 健康檢查

`wrangler.jsonc` 的 cron 每小時跑一次：每個平台抓一篇固定公開樣本（只跑 fetcher，
不寫 D1）。不是 `public` 時在 Workers Logs 留一筆 `health_check_failed`。
有設定 secret `HEALTH_WEBHOOK_URL` 時，平台從正常變成失敗才送一則 Discord 訊息，同一次的新失敗合成一則。
一直失敗不會重送；恢復時只把狀態改回 `ok`，不送訊息。狀態存在 D1 的 `health_state`（`0003`）。

部署通知：新版本第一次執行時（第一個請求或下一次 cron）送一則「已部署」訊息，用
`version_metadata` binding 的版本 ID 判斷，每個版本只送一次。

```bash
npx wrangler secret put HEALTH_WEBHOOK_URL
```

## 程式結構

```text
src/index.ts          fetch / scheduled handler、快取
src/router.ts         hostname → provider 清單；路徑比對
src/core/             共用流程：pipeline、page、db、cache、health
src/providers/naver/  Naver Cafe
src/providers/threads/ Threads（share、embed、og）
test/providers/threads/fixtures/  2026-10-03 擷取的真實 embed／貼文頁（已去掉 script）
```

新增平台：在 `src/providers/` 加一個 provider，並加進 `src/router.ts` 的 `PROVIDERS`。

## 開發

```bash
npm install
npm run types          # 產生 worker-configuration.d.ts
npm test               # Workers runtime + 本機 D1（真實 migration）
npm run typecheck
npx wrangler d1 migrations apply naver-cafe-embed-fix --local
npx wrangler dev --test-scheduled   # /__scheduled 可手動觸發健康檢查
```

## 資料庫

- `posts`：回應過公開內容的貼文目前的存取狀態（從沒公開過的不存），主鍵 `(platform, post_key)`。`last_fetcher` 記錄是哪一層
  fetcher 給出結果。
- `post_versions`：每個不同的公開內容版本，`content_json` 是 `NormalizedPost`。
- 版本 hash 不含頭像、徽章、互動數，媒體只比對網址路徑；內容沒變時只更新 JSON（換成最新的簽章網址）。
- `articles`／`article_versions` 是 `0001` 的舊表，`0002` 已把資料搬到新表，新程式不再讀寫。
  確認線上正常後由 `0004` 刪除。

## 部署

D1 要先存在，`database_id` 已固定在 `wrangler.jsonc`。`wrangler deploy` 不會套用
migration，建庫後要另外跑一次：

```bash
npx wrangler login
npx wrangler d1 create naver-cafe-embed-fix   # 取得 database_id 後填入 wrangler.jsonc
npx wrangler d1 migrations apply naver-cafe-embed-fix --remote
npx wrangler deploy --dry-run
npx wrangler deploy
```

Worker 名稱維持 `naver-cafe-embed-fix`：改名會變成另一個 Worker，Custom Domain、
Workers Builds 連結、observability 都要重設。

### Cloudflare Workers Builds（GitHub 自動部署）

在 Workers & Pages 連接 `konnokai/embed-fix`（原 `konnokai/naver-cafe-embed-fix`），設定如下：

- 專案名稱 `naver-cafe-embed-fix`，需與 `wrangler.jsonc` 的 `name` 相同。
- 組建命令留空：Wrangler 自行打包 TypeScript，Workers Builds 會依 `package-lock.json`
  安裝相依套件。
- 部屬命令 `npx wrangler deploy`（預設值）。
- 非生產分支的組建不需要；本專案只從 `main` 部署。
- 不要啟用 Cloudflare Access：Discord 的 unfurler 無法登入，開了就取不到預覽。

Workers Builds 自動產生的 API token 沒有 D1 權限，所以建庫與 migration 只能在本機
執行，不會隨 CI 部署自動套用。

## 備份與還原

D1 的持久儲存不是獨立備份。匯出與還原使用官方指令：

```bash
npx wrangler d1 export naver-cafe-embed-fix --remote --output backup.sql
npx wrangler d1 export naver-cafe-embed-fix --remote --output schema.sql --no-data
npx wrangler d1 execute naver-cafe-embed-fix --remote --file backup.sql
```

備份頻率、保存位置與保留政策尚未決定。圖片只保存 URL，上游刪圖後 URL 可能失效。

## 已知限制

- 服務沒有認證，任何知道網址的人都能查詢；上游只請求公開內容，不帶 Cookie、憑證或
  使用者標頭。
- Threads 的上游行為只從本機網路驗證過，**沒有**從 Cloudflare 出口驗證；Meta 可能
  擋 Cloudflare IP。
- Threads 圖片、影片網址有簽章、會過期；Discord 能否直接讀取尚未實測。
- Discord 實際呈現（影片、503 卡片）尚未實測。
- 非各平台官方服務，不保證上游格式變動後仍可用。
