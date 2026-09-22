# Naver Cafe Embed Fix

Cloudflare Worker that proxies Naver Cafe article links into Open Graph HTML, so
chat clients can unfurl a preview from the raw response. Implementation of
`PROJECT_PLAN.md`.

## 支援的網址

```text
https://{service-domain}/f-e/cafes/{cafeId}/articles/{articleId}
https://{service-domain}/ca-fe/cafes/{cafeId}/articles/{articleId}
```

其他路徑回 HTTP 400，不請求上游。上游只會是固定的
`https://article.cafe.naver.com/gw/v4/cafes/{cafeId}/articles/{articleId}`，不帶
Cookie、憑證或使用者標頭，也不跟隨重新導向。

## 行為

- 每次請求都匿名重查上游；D1 只保存內容與存取狀態。
- 公開文章：標題、作者、Cafe 名稱、清理後正文與正文圖片；有圖才輸出 `og:image`。
- 需登入／已刪除／已遮蔽：回 HTTP 200 的提示卡片，讓 Discord 讀得到。
- 上游限流或失敗：回 HTTP 503 且 `cache-control: no-store`，避免長期快取錯誤預覽。
- 資料庫已有該文章內容時，一律回資料庫中的內容（含文章轉為需登入或刪除之後）。

## 開發

```bash
npm install
npm run types          # 產生 worker-configuration.d.ts
npm test               # Workers runtime + 本機 D1（真實 migration）
npm run typecheck
npx wrangler dev       # 本機 D1
npx wrangler d1 migrations apply naver-cafe-embed-fix --local
```

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

### Cloudflare Workers Builds（GitHub 自動部署）

在 Workers & Pages 連接 `konnokai/naver-cafe-embed-fix`，設定如下：

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

備份頻率、保存位置與保留政策尚未決定。圖片只保存 URL，Naver 刪圖後 URL 可能失效；
若要長期保存圖片檔案，需另加 R2 與來源驗證。

## 已採用的預設（PROJECT_PLAN 待確認事項）

1. 長期保存只存文字與圖片 URL，不含圖片檔案。
2. OG 主圖用第一張正文圖片；多圖不保證 Discord 相簿版型。
3. 一般訪客開啟閱讀頁後以 `meta refresh` 自動跳轉到 Naver 原文（不用 HTTP 重新導向，
   否則 Discord 等 unfurler 會跟著跳去 Naver 而抓不到預覽）；同時保留「前往 Naver
   原文」連結，供停用自動跳轉的用戶端使用。
4. 服務名稱暫用 `Naver Cafe Embed Fix`、Worker 名稱 `naver-cafe-embed-fix`，
   正式網域待定。

## 已知限制

- 服務沒有認證，任何知道網址的人都能查詢；上游只請求公開文章，不帶 Cookie、憑證或
  使用者標頭。
- 未在正式環境完整驗證：Cloudflare 出口能否匿名讀取 Naver、Discord 實際呈現（含 503
  卡片是否顯示）、上線後的限流行為。
- 非 Naver 官方服務，不保證上游格式變動後仍可用。
