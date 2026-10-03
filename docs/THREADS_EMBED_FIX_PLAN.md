# ebfix 多平台 Embed Fix 專案計畫

更新日期：2026-10-03

狀態：階段 1、2、3、6 已實作（分支 `feat/multi-platform`，未部署，remote migration 未套用）；
階段 4、5、7 需要線上環境或使用者同意。進度見第 11 節開頭。

本文件給之後實作的 session 使用。每個階段開始前，先讀完本文件、現有程式碼與測試，
並重新核對 Cloudflare 官方文件；文件中的上游行為是某一天的實測結果，不保證仍然成立。

## 0. 已確定的決定

| 項目 | 決定 |
| --- | --- |
| 架構 | 一個 Worker，每個平台一個 provider |
| Repo | `konnokai/embed-fix`（2026-10-03 已從 `naver-cafe-embed-fix` 改名） |
| 主網域 | `ebfix.konnokai.me` |
| 舊網域 | `naver.konnokai.me` 保留，只服務 Naver，舊連結不能壞 |
| 網址規則 | 路徑與原平台一模一樣，使用者只換網域 |
| 需登入的內容 | 不登入、不帶 Cookie、不使用任何平台帳號；只顯示「需登入」提示卡 |
| Browser Run | 只當所有平台共用的最後一層備援，預設關閉 |

## 1. 目標與範圍

讓 Discord 等聊天軟體能從伺服器直接回傳的 HTML 讀到預覽（OG metadata 與 Discord
Components V2）。第一批平台：

1. Naver Cafe（已完成，要搬進新架構，行為不變）。
2. Threads（新增）。

之後新增平台時，只新增一個 provider 資料夾與測試，不改共用流程。

### 不在範圍

- 登入任何平台、保存會員 Cookie、使用平台帳號或 token 繞過權限。
  （參考專案 fixthreads 的 `igLogin.ts` 用 IG 帳號登入，本專案不採用。）
- Discord bot、自動改寫頻道訊息。
- 任意 URL 代理。
- 留言擷取、看板／個人頁掃描、搜尋。

## 2. 路由設計

### 網域與路徑

主網域 `ebfix.konnokai.me` 依路徑判斷平台。目前各平台路徑不衝突：

| 平台 | 支援路徑（與原網址相同） | 原網域 |
| --- | --- | --- |
| Naver Cafe | `/f-e/cafes/{cafeId}/articles/{articleId}`、`/ca-fe/cafes/{cafeId}/articles/{articleId}` | `cafe.naver.com` |
| Threads | `/@{username}/post/{code}`、`/t/{code}`、`/share/{shareCode}` | `www.threads.com`、`threads.net` |

- Router 先看 hostname 決定「可用的 provider 清單」，再依序用各 provider 的路徑規則比對。
  - `ebfix.konnokai.me`：所有 provider。
  - `naver.konnokai.me`：只有 Naver。
- 路徑比對不到任何 provider：回 HTTP 400，不請求任何上游（沿用現有行為）。
- 原網址的 query string（例如 Threads 的 `?xmt=...`）一律丟掉，不轉送上游。
- 之後若新平台的路徑和現有平台衝突，該平台改用子網域 `{platform}.ebfix.konnokai.me`。
  Workers Custom Domain 會自動發 Advanced Certificate，支援多層子網域
  （[官方文件](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)）。

### wrangler 設定（預計）

```jsonc
"routes": [
  { "pattern": "ebfix.konnokai.me", "custom_domain": true },
  { "pattern": "naver.konnokai.me", "custom_domain": true }
]
```

實作時要先確認 `naver.konnokai.me` 目前在 Cloudflare 上的設定方式（Custom Domain 或
Route），避免切換時中斷。

## 3. 程式結構

```text
src/
  index.ts              入口：fetch handler、scheduled handler
  router.ts             hostname → provider 清單；路徑比對
  core/
    types.ts            NormalizedPost、UpstreamResult、Provider 介面
    pipeline.ts         依序執行 fetcher、決定最終結果、D1 回退
    page.ts             通用 HTML：OG、Components V2、狀態卡（由現有 page.ts 改）
    db.ts               通用 D1 讀寫（由現有 db.ts 改）
    cache.ts            Cache API 包裝
    media.ts            媒體代理（簽章 + host 白名單）
    browser.ts          Browser Run fetcher（共用）
    health.ts           排程健康檢查
  providers/
    naver/
      index.ts          Provider 定義
      api.ts            現有 naver.ts
      content.ts        現有 content.ts
    threads/
      index.ts
      share.ts          share 連結解析
      embed.ts          /embed 頁解析
      og.ts             og meta 解析
      graphql.ts        GraphQL（選用）
migrations/
  0001_init.sql         現有，不改
  0002_multi_platform.sql
test/
  core/…
  providers/naver/…     現有測試搬過來
  providers/threads/…   含 HTML fixture
```

### Provider 介面（概念）

```ts
interface Provider {
  id: "naver" | "threads";
  siteName: string;               // 預設 og:site_name
  lang: string;                   // <html lang>，Naver 是 "ko"
  match(url: URL): PostRef | null;           // 取出 post key；比對不到回 null
  resolve?(ref: PostRef): Promise<PostRef | UpstreamResult>; // 例如 Threads share 轉址
  fetchers: Fetcher[];            // 依序嘗試
  originalUrl(ref: PostRef): string;
  statusText: Partial<Record<AccessStatus, { title: string; description: string }>>;
  cacheTtlSeconds: number;        // 0 = 不快取
  serveStoredWhenUnavailable: boolean;
}

type Fetcher = (ref: PostRef, env: Env) => Promise<UpstreamResult>;
```

`UpstreamResult` 沿用現有 5 種狀態：
`public | login_required | not_found | restricted | transient`，
`public` 時帶 `NormalizedPost`。

### Pipeline 規則

1. 依序執行 `fetchers`。
2. 結果是 `public`、`login_required`、`not_found`、`restricted` → 停止，用這個結果。
3. 結果是 `transient` → 試下一個 fetcher。
4. 每個 fetcher 都不能 throw；例外一律轉成 `transient`，並記錄 fetcher 名稱與原因。
5. 全部都 `transient`，或結果不是 `public`：
   - `serveStoredWhenUnavailable` 為 true 且 D1 有舊版本 → 回舊版本。
   - 否則回狀態卡。
6. 重點：**抓不到資料時絕對不做 HTTP 轉址回原平台。** 原平台對 unfurler 只回空殼，
   Discord 會只顯示平台名稱（這就是 fixthreads「裝死」的原因，見第 6 節）。

### NormalizedPost

```ts
interface NormalizedPost {
  title: string;
  siteName: string;
  author: { name: string; handle?: string; avatar?: string; verified?: boolean };
  text: string;
  media: { kind: "image" | "video"; url: string; width?: number; height?: number }[];
  stats?: { likes?: number; replies?: number };
  createdAt?: string | null;   // ISO 8601；拿不到就 null，不要猜
  replyTo?: { handle: string; text: string };
  quoted?: { handle: string; text: string; media: NormalizedPost["media"] };
}
```

Naver 的 `cafeName` 對應 `siteName`，`writtenAt` 對應 `createdAt`。

## 4. 輸出（page.ts 通用化）

沿用現有 `page.ts` 的做法，改成吃 `NormalizedPost`：

- OG 標籤、`twitter:card`、`<script id="discord:component-embed">`（Components V2）。
- 一般訪客用 `meta refresh` 跳回原文，不用 HTTP 轉址（原因見現有 page.ts 註解）。
- `<html lang>`、站名、「前往原文」按鈕文字改由 provider 決定。
- 有影片時輸出 `og:video`、`og:video:type`、`twitter:player:stream` 等標籤。
  fixthreads 的 `src/utils/renderSeo.ts` 可參考標籤組合。Discord 的實際呈現要實測。
- Components V2 的 Media Gallery 最多 10 個項目（現有程式已限制）。
- 文字一律 escape；Discord markdown 字元一律跳脫（現有 `renderComponentEmbed` 已處理）。
- 服務名稱改成 `ebfix`（目前是 `Naver Cafe Embed Fix`）。

### 狀態卡文字

| 狀態 | Naver（現有） | Threads |
| --- | --- | --- |
| `login_required` | 需登入的文章 | 標題「需登入的貼文」；描述「這篇貼文需要登入 Threads 才能查看，也可能是私人帳號或已刪除。」 |
| `not_found` | 文章不存在或已刪除 | 貼文不存在或已刪除 |
| `restricted` | 文章無法公開預覽 | 貼文無法公開預覽 |
| `transient` | 暫時無法取得預覽（HTTP 503、`no-store`） | 同左 |

Threads 在未登入狀態下，**分不出「需登入」和「已刪除」**（兩者 embed 頁都顯示
`Thread not available`），所以描述要寫「也可能已刪除」，不能假裝確定。

## 5. 資料庫（D1）

### 新 schema（`0002_multi_platform.sql`）

```sql
CREATE TABLE posts (
  platform TEXT NOT NULL,
  post_key TEXT NOT NULL,           -- naver: "{cafeId}/{articleId}"；threads: post code
  source_url TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  last_fetch_started_at INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  last_http_status INTEGER,
  last_error_code TEXT,
  last_fetcher TEXT,                -- 哪一層 fetcher 給出最終結果，方便除錯
  latest_version_hash TEXT,
  PRIMARY KEY (platform, post_key)
);

CREATE TABLE post_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  post_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,       -- NormalizedPost
  first_fetched_at INTEGER NOT NULL,
  UNIQUE (platform, post_key, content_hash)
);
```

- 同一個 migration 用 `INSERT ... SELECT` 把 `articles`、`article_versions` 搬到新表，
  `platform = 'naver'`，`content_json` 由舊欄位組成。
- 舊表先保留，確認線上正常後再用另一個 migration 刪除（`0003`）。
- **套用時機**：`0002` 只在套用當下複製一次。套用後到新程式部署前，舊程式還會寫舊表，
  這段期間的寫入不會進新表。所以 remote migration 要緊接著部署做。`0003` 刪舊表前，先用
  下面的 SQL 補一次差異（舊表比較新的才覆蓋，版本只補缺的）：

  ```sql
  INSERT INTO posts (platform, post_key, source_url, first_seen_at, last_checked_at,
    last_fetch_started_at, last_status, last_http_status, last_error_code, last_fetcher, latest_version_hash)
  SELECT 'naver', cafe_id || '/' || article_id, source_url, first_seen_at, last_checked_at,
    last_fetch_started_at, last_status, last_http_status, last_error_code, NULL, latest_version_hash
  FROM articles WHERE true
  ON CONFLICT (platform, post_key) DO UPDATE SET
    source_url = excluded.source_url, last_checked_at = excluded.last_checked_at,
    last_fetch_started_at = excluded.last_fetch_started_at, last_status = excluded.last_status,
    last_http_status = excluded.last_http_status, last_error_code = excluded.last_error_code,
    latest_version_hash = COALESCE(excluded.latest_version_hash, posts.latest_version_hash)
  WHERE excluded.last_fetch_started_at > posts.last_fetch_started_at;
  -- post_versions 用 0002 同一段 SELECT，改成 INSERT OR IGNORE。
  ```
- 回退：D1 Time Travel 可以還原到套用前的時間點；舊程式只讀舊表，所以新表留著不影響舊程式。
- 實作時的 hash 規則：不含頭像、徽章、互動數，媒體只比對網址路徑（Threads 的簽章與 CDN host 每次都不同）。
  內容沒變時只把 `content_json` 更新成最新網址。
- 舊資料的 `content_hash` 直接沿用。新程式改用 `NormalizedPost` 算 hash，所以每篇 Naver
  文章第一次重新抓取時會多一筆版本。可以接受，不另外處理。
- 現有的「較早開始的請求不能覆寫較新結果」（`WHERE excluded.last_fetch_started_at >= ...`）
  與 `COALESCE(latest_version_hash)` 邏輯要保留。
- `wrangler deploy` 不會套用 migration；Workers Builds 的 token 沒有 D1 權限。
  migration 要在本機手動對 remote 執行（見 README）。

### 保存政策

- Naver：沿用使用者已決定的政策——資料庫有內容時，文章轉成需登入或刪除後仍回資料庫內容。
- Threads：預設沿用同一政策（`serveStoredWhenUnavailable: true`）。這點列在第 11 節待確認。

## 6. Threads provider

### 參考專案的問題（seriaati/fixthreads，MIT License）

讀過 `src/utils/fetch/findPost.ts`、`resolveShare.ts`、`src/controllers/posts.ts`：

1. GraphQL 回 `edges: []`（沒有錯誤訊息）時，程式仍讀 `edges[0].node`，丟出例外，
   被 catch 後 HTTP 轉址回 threads.com。Discord 跟著轉址，只拿到空殼，預覽只剩「Threads」。
2. GraphQL 被限流時回 HTML，`.json()` 失敗，結果同上。
3. `doc_id`（`7448594591874178`）、`lsd`、`X-Ig-App-Id` 寫死；Meta 換值就全部失效。
4. 失敗後改用 IG 帳號登入重試。本專案不採用。

### 實測結果（2026-10-03，從使用者家中網路測試，**不是** Cloudflare 出口）

| 抓法 | 公開貼文（`@zuck/post/C-srcchPpp7`） | 需登入貼文（share `BAZqSEo-Yl`） |
| --- | --- | --- |
| `GET https://www.threads.com/share/{code}/`，不帶 UA、不跟隨轉址 | — | HTTP 302，`Location` 為 `/@{user}/post/{code}?xmt=...` |
| GraphQL（fixthreads 的參數） | 回 HTML（被擋） | 第一次回 `{"data":{"data":{"edges":[]...}}}`，之後回 HTML |
| `GET /@{user}/post/{code}/embed` | HTTP 200，有完整內容 | HTTP 200，含 `<span class="ErrorText">Thread not available</span>` |
| `GET /@{user}/post/{code}`，UA = Discordbot | 有 `og:title`（`Mark Zuckerberg (@zuck) on Threads`）、`og:image` | 沒有 `og:title`；`og:url` 帳號名稱是空的（`/@/post/{code}`） |

### embed 頁結構（公開貼文樣本）

| 資料 | 位置 |
| --- | --- |
| 帳號 | `.HeaderContainer .AuthorIdentity a.HeaderLink > span` |
| 認證徽章 | `.VerifiedBadge` 是否存在 |
| 頭像 | `.AvatarContainer img[src]` |
| 內文 | `.BodyTextContainer`（內含巢狀 `span`） |
| 時間 | `.PostDateContainer .Timestamp`，是**在地化文字**（例如 `9:58 AM · Aug 15, 2024`），樣本中沒找到 ISO 時間 |
| 互動數 | `.ActionBarContainer`（未解析過） |
| 不可用 | `.ErrorText`，文字 `Thread not available` |

尚未取得樣本、要在階段 2 補驗證的：單圖、多圖、影片、引用貼文、回覆串、連結預覽、
embed 頁的媒體結構。時間若只拿得到在地化文字，`createdAt` 設 null，不要自己猜時區。

解析用 `HTMLRewriter`（Workers 原生），不要用單一正規表示式處理整份 HTML（沿用現有規則）。

### Fetcher 順序

1. **resolve（只有 `/share/` 需要）**：`redirect: "manual"`，不帶 UA，跟隨最多 5 次，
   只接受 threads.com／threads.net 的 Location，從中取出 username 與 code。
   失敗才用瀏覽器 UA 抓頁面找 `og:url`／canonical（沿用 fixthreads `resolveShare.ts` 的兩段式）。
2. **embed**：主要來源。`Thread not available` → `login_required`。
3. **og**：Discordbot UA 抓貼文頁。有 `og:title` → `public`（只有標題、圖片、描述）；
   `og:url` 帳號名稱空白 → `login_required`。
4. **graphql**：選用，預設關閉（環境變數開啟）。`doc_id` 等參數放設定，不寫死在程式。
   `edges` 空陣列或回 HTML → `transient`，不能 throw。
5. **browser**：共用 Browser Run fetcher（第 8 節）。

`/t/{code}` 沒有 username：embed／og 都需要 username 時，先用 `https://www.threads.com/t/{code}`
的轉址取得 username（要實測這個轉址是否存在）。

### 媒體

- Threads 圖片、影片在 `*.fbcdn.net`、`*.cdninstagram.com`，網址有簽章、會過期。
- 先測 Discord 能否直接讀取原始網址。不行才走媒體代理（第 7 節）。
- fixthreads 的 `worker.js` 用 `referer: https://threads.com` 抓影片，可以參考。

## 7. 媒體代理（需要時才做）

- 路徑：`/media/{sig}/{base64url(原始網址)}`。
- `sig` = HMAC-SHA256(secret, 原始網址)，secret 放 Worker secret。只有本服務產生的網址能用。
- 只放行 host 白名單：`*.fbcdn.net`、`*.cdninstagram.com`（以後依平台增加）。
- 不跟隨轉址到白名單以外的 host；只放行 `image/*`、`video/*`。
- 支援 `Range` 標頭（影片需要）。

## 8. Browser Run（共用最後一層）

- binding：`"browser": { "binding": "BROWSER" }`；套件 `@cloudflare/puppeteer`；
  需要 `nodejs_compat` 類的相容性旗標。實作時依
  [官方 Wrangler 文件](https://developers.cloudflare.com/browser-run/reference/wrangler/)核對。
- 開關：`BROWSER_RUN_ENABLED` 環境變數，預設關閉。
- 每日次數上限：D1 表記錄當日使用次數，超過就跳過這一層（回 `transient`）。
- 同一篇內容同時被要求多次時，只開一個瀏覽器（D1 鎖或 Cache API 擋重複）。
- 只抓 provider 指定的 URL，不接受使用者給的 URL。
- 額度（2026-10 文件）：
  - Free：每天 10 分鐘、同時 3 個瀏覽器、每 20 秒最多開 1 個新瀏覽器。
  - Paid：每月含 10 小時，超過每小時 $0.09；同時瀏覽器平均 10 個以上要另外計費。
  - 瀏覽器預設 60 秒沒動作就關閉。
- **風險**：[官方 FAQ](https://developers.cloudflare.com/browser-run/faq/) 寫明 Browser Run 的請求
  一律被標成 bot，並帶 `cf-biso-request-id` 等標頭，IP 是 Cloudflare 的範圍。Meta 可能直接擋。
  階段 5 先實測，被擋就不上線這一層。

## 9. 快取

- 用 Cache API，key = 正規化後的服務網址（不含 query）。
- 由 provider 決定 TTL：
  - Naver：0（沿用「每次重新查上游」的設計）。
  - Threads 公開貼文：600 秒；狀態卡：60 秒；`transient`：不快取（`no-store`）。
- Cache API 在 Custom Domain 上才有效，`workers.dev` 預覽環境沒有效果；
  快取只存在單一資料中心（[官方文件](https://developers.cloudflare.com/workers/runtime-apis/cache/)）。

## 10. 排程健康檢查

- `wrangler.jsonc` 加 `"triggers": { "crons": ["0 * * * *"] }`，`index.ts` 加 `scheduled` handler。
- 每小時抓每個平台一篇固定公開樣本，只走 fetcher，不寫 D1：
  - Naver：`cafes/29424353/articles/528107`
  - Threads：`@zuck/post/C-srcchPpp7`
- 結果不是 `public` → `console.error` 一筆 JSON（`event: "health_check_failed"`、平台、fetcher、狀態）。
  `observability` 已開啟，可在 Workers Logs 查。告警通知方式待定。

## 11. 實作階段與驗收

### 進度（2026-10-03）

| 階段 | 狀態 |
| --- | --- |
| 1 重構 | 完成。11 種 Naver 情境的狀態碼、標頭、內容與重構前逐字相同（暫時快照測試比對後刪除）。 |
| 2 Threads 基本版 | 完成。fixture 在 `test/providers/threads/fixtures/`。GraphQL fetcher 沒做（選用，且實測已被擋）。 |
| 3 D1 通用化 | 完成（本機）。`0002` 用線上資料的匯出副本實測過：5 篇、3 個版本全部對得上。remote 尚未套用（見第 5 節「套用時機」）。 |
| 4 媒體 | 未開始：要先在 Discord 實測 fbcdn 網址。 |
| 5 Browser Run | 未開始：要部署測試 Worker 實測。 |
| 6 健康檢查與快取 | 完成。cron 已寫進 `wrangler.jsonc`。 |
| 7 上線 | 未開始：要使用者同意。 |

和第 6 節不同的實測結果（2026-10-03，本機網路）：

- 不帶 User-Agent 時，share、embed、`/t/` 都回 302 到 `facebook.com/unsupportedbrowser`。
  桌面瀏覽器 UA 拿到的是沒有內容的 SPA 頁（share 頁也沒有 `og:url`）。
  所以全部請求都帶 `ebfix/1.0 (+https://ebfix.konnokai.me)`；這個 UA 和 Discordbot UA 結果相同。
- `/t/{code}/embed` 不需要 username，也能直接用；`/t/{code}` 回 301 到 `/@{user}/post/{code}`。
- embed 頁沒有 `og:description`；貼文頁目前也沒有 `og:description`，og fetcher 只有標題和卡片圖。
- 不存在的 share code 回 200 的空殼頁，和格式改變分不出來，所以判成 `transient`。
- 不存在的貼文代碼的 embed 頁也是 `Thread not available`，和需登入一樣。
- 引用貼文的內文由 script 填入，HTML 只有帳號。


每個階段：先讀程式碼與測試 → 實作 → 自己跑 `npm test`、`npm run typecheck` → 貼出真實輸出。

### 階段 1：重構（行為不變）

- 建立 `router.ts`、`core/`、`providers/naver/`，把現有程式搬進去。
- 先不動 D1 schema（`core/db.ts` 暫時接舊表）。
- 驗收：現有所有測試搬到新位置後全部通過；Naver 的 HTTP 回應內容與重構前相同。

### 階段 2：Threads 基本版

- share 解析、embed fetcher、og fetcher、狀態卡。
- 先補齊第 6 節列出的樣本（單圖、多圖、影片、引用、回覆），存成 HTML fixture。
- 驗收：fixture 測試涵蓋公開、需登入、embed 結構改變（解析不到 → `transient`）、
  share 轉址失敗、上游 429／5xx。

### 階段 3：D1 通用化

- `0002_multi_platform.sql`，搬移舊資料，Threads 開始保存版本。
- 驗收：本機 D1 跑真實 migration；舊 Naver 資料在新表讀得到；併發寫入不會讓舊結果覆寫新結果。
- **此階段動到 schema，實作前先出計畫給使用者確認。**

### 階段 4：媒體

- 先測 Discord 直接讀 fbcdn 網址；不行再做第 7 節的代理。
- 驗收：簽章錯誤、白名單外 host、非媒體 content-type 都被拒絕。

### 階段 5：Browser Run

- 先寫一個最小測試 Worker，確認 Browser Run 能不能開啟 Threads 貼文頁。被擋就停止這個階段並回報。
- 驗收：開關關閉時完全不呼叫；超過每日上限時跳過。

### 階段 6：健康檢查與快取

- Cron、Cache API。

### 階段 7：上線與改名

- 新增 `ebfix.konnokai.me` Custom Domain，確認 `naver.konnokai.me` 舊連結仍正常。
- GitHub repo 改名。
- Worker `name` 若要改，會變成另一個 Worker：Custom Domain、Workers Builds 連結、
  observability 都要重新設定。可以只改 repo 名稱、不改 Worker 名稱。
- 部署、套用 remote migration、在 Discord 實測，都要先經使用者同意。

## 12. 待確認事項

1. Threads 貼文變成需登入或刪除後，是否也回資料庫中的舊內容？目前預設「是」（與 Naver 相同）。
2. Worker 名稱是否跟著改？（建議不改，見階段 7。）
3. 健康檢查失敗時用什麼方式通知？
4. 第三個平台是哪個？會影響路徑是否衝突。

## 13. 參考資料

- fixthreads：https://github.com/seriaati/fixthreads
- Browser Run：https://developers.cloudflare.com/browser-run/
- Browser Run 價格：https://developers.cloudflare.com/browser-run/pricing/
- Browser Run 限制：https://developers.cloudflare.com/browser-run/limits/
- Browser Run FAQ：https://developers.cloudflare.com/browser-run/faq/
- Browser Run Wrangler：https://developers.cloudflare.com/browser-run/reference/wrangler/
- Workers Custom Domains：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Workers Cache API：https://developers.cloudflare.com/workers/runtime-apis/cache/

---

## 附錄 A：Naver Cafe（已實作）

以下保留原計畫中已驗證的上游行為與規則，重構時不能改變。

### A.1 範圍

- 只根據文章網址取得內容，不從看板清單、搜尋結果或會員登入取得資料。
- 可匿名閱讀的文章：顯示標題、作者、正文文字及正文圖片。
- 正文不包含貼圖；沒有圖片時，不輸出圖片 metadata，也不以頭像或 Cafe 圖示充當文章圖片。
- 需要登入或會員閱讀權限的文章：顯示「需登入的文章」，不使用清單預覽補資料。
- 不支援 `cafe.naver.com/{cafeAlias}/{articleId}` 等需要額外解析 Cafe ID 的格式。

### A.2 已驗證的上游行為

以下結果來自無痕 Chrome Network、DOM 與不帶 Cookie 的 HTTP 請求，不代表所有文章或 Cloudflare 出口都已驗證。

公開文章樣本：`https://cafe.naver.com/f-e/cafes/29424353/articles/528107`

```text
/f-e/cafes/{cafeId}/articles/{articleId}
  -> iframe#cafe_main
  -> /ca-fe/cafes/{cafeId}/articles/{articleId}?fromNext=true
  -> article API
  -> 正文 HTML 與圖片
```

文章 API：`https://article.cafe.naver.com/gw/v4/cafes/{cafeId}/articles/{articleId}`

瀏覽器請求另帶 `query=&useCafeId=true&requestFrom=A`；公開前端程式碼設定 `X-Cafe-Product: pc`。上述樣本在不帶 query、自訂標頭或 Cookie 時也能回傳 HTTP 200。

| 用途 | 回應欄位 |
| --- | --- |
| 標題 | `result.article.subject` |
| 作者 | `result.article.writer.nick` |
| Cafe 名稱 | `result.cafe.name` |
| 正文 HTML | `result.article.contentHtml` |
| 發文時間 | `result.article.writeDate` |
| 是否可讀 | `result.article.isReadable` |
| 是否遭遮蔽 | `result.article.isBlind` |
| 公開相關旗標 | `result.article.isOpen`、`result.article.isSearchOpen` |
| 請求者登入狀態 | `result.user.isLogin`、`result.user.isCafeMember` |

正文圖片位於 `contentHtml`，不能只讀 `attaches`：樣本的 `attaches=[]`，但正文有圖片。

- 正文圖片：`img.se-image-resource`。
- 貼圖：`img.se-sticker-image`，其容器可能是 `.se-sticker`。
- 匿名 API 回傳的正文圖曾使用 `?type=w800`；瀏覽器使用 `?type=w1600`。
- 樣本 `w800` 圖片不帶 Cookie、Referer 仍回傳 HTTP 200、`image/jpeg`。

受限文章樣本：`https://cafe.naver.com/f-e/cafes/29424353/articles/1083231`，匿名正文 API 回傳 HTTP 401：

```json
{
  "result": {
    "errorCode": "0004",
    "reason": "로그인하지 않았습니다.",
    "message": "errorCode: 0004, message: 로그인 하지 않음"
  }
}
```

### A.3 已知限制

- API 是網站內部介面，不是有穩定相容承諾的官方讀取 API。
- 不可把所有 400、403、429、5xx 或解析失敗一律判成需登入。
- 刪文、會員等級不足、成人驗證、遮蔽及其他拒絕原因仍需取得樣本驗證。

### A.4 內容規則

- 用 HTML 解析器處理正文，不以單一正規表示式處理整份 HTML。
- 去除貼圖容器及其替代文字；去除 script、style；解碼 HTML entities；保留段落與換行。
- 不擷取留言、側欄、廣告或推薦文章。
- D1 保存完整清理後正文；不自行指定截斷長度。
- 圖片只取正文圖片，維持原文順序並去重；首張作為 OG 主圖。

### A.5 安全

- 固定上游 hostname 與 API 路徑，只接受有效數字 ID。
- 不轉送用戶端 Cookie、Authorization 或任意請求標頭；不跟隨上游重新導向。
- 所有 SQL 使用參數綁定；上游資料須通過結構與型別驗證，未知錯誤不能誤判為公開。
- D1 寫入失敗要記錄（`d1_write_failed`），但仍回傳當次預覽。
