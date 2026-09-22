# Naver Cafe Embed Fix 專案計畫

更新日期：2026-09-22

狀態：規劃中。此文件不代表已實作、建立雲端資源或完成部署。

## 1. 目標與範圍

建立可部署於 Cloudflare Workers 的 Naver Cafe 文章預覽代理。使用者分享代理網址後，Discord 可從伺服器直接回傳的 HTML 讀取 Open Graph metadata。

- 僅根據文章網址取得內容，不從看板清單、搜尋結果或會員登入取得資料。
- 可匿名閱讀的文章：顯示標題、作者、正文文字及正文圖片。
- 正文不包含貼圖；沒有圖片時，不輸出圖片 metadata，也不以頭像或 Cafe 圖示充當文章圖片。
- 需要登入或會員閱讀權限的文章：OG 顯示「需登入的文章」，不使用清單預覽補資料。
- 加入長期保存資料的資料庫。
- 本階段只建立計畫，不實作、不安裝套件、不部署。

### 不在初版範圍

- Discord bot、自動改寫頻道訊息。
- 登入 Naver、保存或使用會員 Cookie、繞過文章權限。
- 看板掃描、清單預覽、搜尋索引。
- 影片播放代理、貼圖預覽、留言擷取。
- 後台管理介面或完整 Naver 網站鏡像。

## 2. 已驗證的上游行為

以下結果來自無痕 Chrome Network、DOM 與不帶 Cookie 的 HTTP 請求，不代表所有文章或 Cloudflare 出口都已驗證。

### 公開文章樣本

原始網址：

```text
https://cafe.naver.com/f-e/cafes/29424353/articles/528107
```

實際載入流程：

```text
/f-e/cafes/{cafeId}/articles/{articleId}
  -> iframe#cafe_main
  -> /ca-fe/cafes/{cafeId}/articles/{articleId}?fromNext=true
  -> article API
  -> 正文 HTML 與圖片
```

目前網站的文章 API：

```text
https://article.cafe.naver.com/gw/v4/cafes/{cafeId}/articles/{articleId}
```

瀏覽器請求另帶 `query=&useCafeId=true&requestFrom=A`；公開前端程式碼設定 `X-Cafe-Product: pc`。上述樣本在不帶 query、自訂標頭或 Cookie 時也能回傳 HTTP 200。

必要資料：

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

本篇匿名回應中，`isLogin=false`、`isCafeMember=false`、`isReadable=true`、`isBlind=false`。

正文圖片位於 `contentHtml`，不能只讀 `attaches`：樣本的 `attaches=[]`，但正文有圖片。

- 正文圖片：`img.se-image-resource`。
- 貼圖：`img.se-sticker-image`，其容器可能是 `.se-sticker`。
- 匿名 API 回傳的正文圖曾使用 `?type=w800`；瀏覽器使用 `?type=w1600`。
- 樣本 `w800` 圖片不帶 Cookie、Referer 仍回傳 HTTP 200、`image/jpeg`。
- 不需要先引入完整瀏覽器來取得此樣本的資料。

### 受限文章樣本

```text
https://cafe.naver.com/f-e/cafes/29424353/articles/1083231
```

匿名正文 API 回傳 HTTP 401：

```json
{
  "result": {
    "errorCode": "0004",
    "reason": "로그인하지 않았습니다.",
    "message": "errorCode: 0004, message: 로그인 하지 않음"
  }
}
```

此樣本的看板清單雖然公開標題及代表圖，但本專案依使用者決定，不使用該資料來源。

### 已知限制

- API 是網站內部介面，不是有穩定相容承諾的官方讀取 API。
- 不可把所有 400、403、429、5xx 或解析失敗一律判成需登入。
- 刪文、會員等級不足、成人驗證、遮蔽及其他拒絕原因仍需取得樣本驗證。
- Cloudflare 出口是否被上游阻擋、Discord 的實際呈現仍未測試。

## 3. 分享網址與請求流程

初版支援含數字 Cafe ID 與文章 ID 的已知路徑：

```text
https://{service-domain}/f-e/cafes/{cafeId}/articles/{articleId}
https://{service-domain}/ca-fe/cafes/{cafeId}/articles/{articleId}
```

使用者只需將原網址的 `cafe.naver.com` 換成服務網域。原文章 query string 不直接轉送至上游；Cafe ID 與文章 ID 經格式驗證後，由服務組合固定 API 網址。

不先承諾支援 `cafe.naver.com/{cafeAlias}/{articleId}` 等需要額外解析 Cafe ID 的格式。

預定流程：

1. 驗證路徑，取得 Cafe ID、文章 ID。
2. 不帶使用者憑證，請求固定 Naver 文章 API。
3. 依 HTTP 狀態、錯誤內容、文章可讀狀態及回應結構分類。
4. 公開文章解析成標題、作者、純文字正文及圖片清單。
5. 更新目前存取狀態，保存公開內容與必要抓取資訊。
6. 回傳包含 OG 的完整 HTML，不依賴客戶端 JavaScript 補 metadata。

一般訪客開啟分享網址時，先取得完整 OG 回應，再由頁面內的 `meta refresh` 自動跳轉到 Naver 原文；不以 HTTP 重新導向回應，否則 unfurler 會跟隨重新導向而取不到預覽。無法自動跳轉時仍有「前往 Naver 原文」連結。

## 4. OG 與內容規則

### 公開文章

| 項目 | 預定內容 |
| --- | --- |
| `og:title` | 文章標題 |
| `og:description` | 作者名稱與清理後的正文文字 |
| `og:site_name` | Cafe 名稱或服務名稱 |
| `og:type` | `article` |
| `og:url` | 正規化的代理分享網址 |
| `og:image` | 有正文圖片才輸出 |
| `twitter:card` | 有圖時使用 `summary_large_image`，無圖時使用 `summary` |

一般 `author` metadata 可補充作者，但不假設 Discord 會用它產生獨立作者欄位；將作者寫入描述，確保可見。

正文處理：

- 使用 HTML 解析器或 Workers 原生 HTML 解析能力，不以單一正規表示式處理整份 HTML。
- 去除貼圖容器及其替代文字，不把貼圖轉成正文。
- 去除 script、style 等非文章文字，解碼 HTML entities，保留合理段落與換行。
- 不擷取留言、側欄、廣告或推薦文章。
- 對輸出的 HTML 屬性及可見文字做 escaping，不直接渲染上游原始 HTML。
- D1 保存完整清理後正文；Discord 可能截斷顯示，不承諾 OG 能完整呈現任意長度文章。
- 不先自行指定正文截斷長度；若實測需要限制，記錄平台依據與取捨。

圖片處理：

- 僅取正文圖片，排除貼圖、頭像與介面圖片。
- 無圖片時完全省略圖片相關標籤。
- 保存正文圖片 URL 清單，維持原文順序並去重。
- 初步以首張正文圖片作為 OG 主圖；多圖是否能在 Discord 同時呈現需實測，不能以重複 `og:image` 保證相簿效果。
- 先使用上游匿名可存取的圖片 URL，不預先加入圖片代理。
- 若需代理圖片，必須另處理來源白名單、重新導向與內容類型，不能形成任意 URL 代理。

### 受限與錯誤狀態

| 狀態 | 預覽行為 |
| --- | --- |
| 明確需要登入或會員權限 | 標題「需登入的文章」，描述提醒前往 Naver 登入並確認閱讀權限 |
| 已刪除或不存在 | 顯示文章不存在或已刪除，不假稱需登入 |
| 已遮蔽或限制公開 | 顯示文章無法公開預覽，不輸出舊內容 |
| 上游限流、失敗或未知結構 | 顯示暫時無法取得預覽，與閱讀權限錯誤分開 |
| 無效路徑或 ID | 回傳明確的用戶端錯誤，不請求上游 |

已知受限文章的 HTML 預計回 HTTP 200，使 Discord 能讀取提示卡片。暫時性錯誤的 HTTP 狀態與卡片可見性需實測後決定，避免長期快取錯誤預覽。
但若資料庫已有該 ID 的相關資料則一律回應資料庫中的內容

## 5. Cloudflare 架構

```text
Discord／一般瀏覽器
        |
        v
Cloudflare Worker
   |          |
   |          +--> D1：文章資料、版本與存取狀態
   |
   +--> Naver 匿名文章 API

Discord 圖片抓取器 --> Naver 公開圖片 URL
```

- Workers：路徑驗證、匿名擷取、正文解析、OG HTML。
- D1：長期保存結構化內容與抓取結果。
- 不先加入 KV、Durable Objects、排程、Queue 或 Browser Rendering。
- 是否需要 R2 取決於「長期保存」是否包含圖片檔案本身，見待決事項。
- 不在本計畫內建立 Cloudflare 資源或讀取部署憑證。

## 6. 長期保存設計

長期保存與公開展示分開處理。保存資料不等於允許永久公開。

### 建議資料模型

`articles`：每篇文章目前狀態，以 `(cafe_id, article_id)` 為唯一識別。

- 原文網址。
- 首次發現與最後檢查時間。
- 最近一次抓取的開始時間，用於避免較早發出的請求晚完成時覆寫新結果。
- 最近存取狀態：公開、需登入、不可用、暫時失敗。
- 最近 HTTP 狀態、上游錯誤碼，不保存 Cookie 或完整錯誤頁。
- 最近公開內容版本的識別。

`article_versions`：保存已匿名取得的公開內容版本。

- Cafe ID、文章 ID、內容雜湊。
- 標題、作者顯示名稱、Cafe 名稱。
- 完整清理後正文、圖片 URL 清單、原文發文時間。
- 首次取得該版本的時間。
- 以文章識別與內容雜湊去重，不因每次 Discord 抓取就重複保存同一份內容。
- 不保存留言、使用者 member key 或整份上游回應，避免保存不必要資料。

資料寫入應具備原子性，並以 migration 管理 schema。

### 存取與快取原則

- 初步以每次請求重新匿名檢查上游為基準，D1 是保存用途，不是繞過權限檢查的來源。
- 若文章後來需要登入、遭遮蔽或刪除，則直接回傳資料庫中的歷史內容。
- 歷史版本不提供公開查詢端點。
- 保留已轉私密或已刪除文章的歷史版本。
- 不先設定沒有依據的保存期限、快取 TTL 或定時清理規則。

### 備份與圖片保存

- D1 持久儲存不等於獨立備份，實作時提供官方支援的匯出與還原流程。
- 備份頻率、保存位置與保留政策待確認，不先建立排程。
- 圖片 URL 存在 D1，不表示圖片檔案已備份；Naver 刪圖或變更存取政策時，URL 可能失效。
- 若要求圖片檔案也長期保存，另規劃 R2、內容雜湊去重、來源驗證與受限後的公開存取控制。

## 7. 安全與維運

- 固定上游 hostname 與 API 路徑，只接受有效數字 ID，不允許任意 URL 抓取。
- 不轉送用戶端 Cookie、Authorization 或任意請求標頭；不建立 Naver 登入 session。
- 不跟隨上游導向未知來源的重新導向。
- 所有 SQL 使用參數綁定。
- 上游資料須通過結構與型別驗證，未知錯誤不能誤判公開。
- 記錄錯誤類別、文章識別與 HTTP 狀態，不記錄會員憑證或完整正文。
- D1 保存失敗不能被默默忽略；需決定是否仍回傳當次預覽並記錄可追查的錯誤。
- 公開服務的限流、請求大小與逾時等設定，依平台限制及實測訂定，不在計畫中任意填值。

## 8. 實作階段與驗收

### 階段 A：確定保存契約

確認圖片是否備份、文章轉私密後的歷史版本政策、多圖需求與部署網域。實作前重新取得 Cloudflare 官方文件，核對 Workers、D1、Wrangler 設定及型別。

### 階段 B：匿名擷取與解析

驗證公開樣本 `528107` 可取得正確標題、作者、正文與圖片；受限樣本 `1083231` 只產生需登入提示。

使用固定測試資料涵蓋：無圖、圖片與貼圖混合、HTML entities、特殊字元、空正文、未知 API 結構及惡意 HTML。

### 階段 C：OG 與資料保存

確認原始 HTTP HTML 已包含 metadata，無需 JavaScript；無圖時沒有圖片標籤，作者可見，正文不含貼圖。

驗證 migration、版本去重、完整正文保存、權限變更後不洩漏舊資料，以及併發寫入不讓舊狀態覆寫較新結果。

### 階段 D：本機與部署驗證

- 使用本機 Workers runtime 與 D1，而不只 mock 資料庫。
- 驗證無效路徑、方法、上游限流與失敗的行為。
- 產生部署包並 dry-run，不因此自動上線。
- 確認授權後才建立遠端 D1、套用 migration 與部署 Worker。
- 上線後確認 Cloudflare 出口可匿名讀取 Naver。
- 經授權在 Discord 測試公開、需登入、無圖、多圖及長文；不擅自向頻道發送訊息。
- 驗證資料匯出與還原方式。

## 9. 待確認事項

以下事項會影響保存範圍、成本或使用者體驗，實作前應確認：

1. 長期保存是否包含圖片檔案，或只需文字與圖片 URL？
2. 多圖文章是否要求 Discord 同時顯示全部圖片，或首張主圖即可？一般 OG 不保證多圖版型。
3. 一般訪客開啟代理網址時，要看到閱讀頁，還是自動前往原文？已決定：自動前往原文（`meta refresh`），閱讀頁僅作為跳轉前與跳轉失敗時的備援。
4. 專案正式目錄、服務名稱、Cloudflare 帳號與網域為何？目前文件放在本次工作目錄。

## 10. 參考資料

- 公開樣本：https://cafe.naver.com/f-e/cafes/29424353/articles/528107
- 已驗證匿名 API：https://article.cafe.naver.com/gw/v4/cafes/29424353/articles/528107
- 受限樣本：https://cafe.naver.com/f-e/cafes/29424353/articles/1083231
- Workers 文件：https://developers.cloudflare.com/workers/
- D1 文件：https://developers.cloudflare.com/d1/
- Wrangler 文件：https://developers.cloudflare.com/workers/wrangler/

Cloudflare 文件列為後續實作的核對來源；本階段尚未完成最新文件核對或部署相容性驗證。
