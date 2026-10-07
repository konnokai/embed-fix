# Bilibili Embed Fix 計畫

更新日期：2026-10-07

狀態：**暫停**。B0（2026-10-07）發現 Cloudflare 出口幾乎所有 B 站 API 都回 412，見第 9 節 B0 結果。要不要用代理繼續，等使用者決定。共用架構（router、pipeline、page、D1、健康檢查）沿用
[THREADS_EMBED_FIX_PLAN.md](THREADS_EMBED_FIX_PLAN.md)。本文件只寫 Bilibili 不一樣的地方。

第 3 節的結果都是**家中網路**測的。Bilibili 會擋機房 IP（HTTP 412），跟 Meta 不一樣，**不能**比照 Instagram
跳過 Cloudflare 出口實測，見階段 B0。

## 0. 決定

### 沿用的決定

| 項目 | 決定 |
| --- | --- |
| 架構 | 新增 `src/providers/bilibili/`，一個 provider 處理所有 Bilibili 內容（理由見第 5 節） |
| 帳號 | 不登入、不帶 `SESSDATA`、不用任何 Bilibili 帳號 |
| 需登入的內容 | 顯示提示卡，不轉址回 Bilibili |
| 媒體 | 只存網址，不存 R2 |
| Browser Run | 不做。影片頁、圖文頁對非瀏覽器一律回驗證碼頁（第 3.1 節），而 API 本身就拿得到資料 |

### 使用者 2026-10-07 決定

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 匿名 `buvid3` Cookie | **用**，UA 維持 ebfix UA | 動態 API 不帶 `buvid3` 時，ebfix UA 時好時壞（第 3.3 節）。`buvid3` 是匿名裝置 ID，由 `/x/frontend/finger/spi` 免登入取得，跟帳號無關，不違反「不登入、不帶會員 Cookie」 |
| 網域 | 把 `bilibili.com` 換成 `bili.ebfix.konnokai.me`，`b23.tv`、`bili2233.cn` 換成 `b23.ebfix.konnokai.me` | 動態、直播、個人空間的路徑都是 `/{數字}`，只能靠子網域分辨，見第 4 節 |
| 番劇（`/bangumi/play/ep…`、`ss…`） | 不做 | `pgc` API 另一套，很多有地區限制 |
| B0 的實測方式 | `wrangler dev --remote` | 不用部署到正式 Worker，測完不用清 |

### 還沒決定

| 項目 | 建議 | 理由 |
| --- | --- | --- |
| 影片網址轉址端點 | 先不做，B6 再評估 | 播放網址 2 小時過期（第 7 節） |

## 1. 範圍

| 類型 | 原網址 |
| --- | --- |
| 影片 | `www.bilibili.com/video/BV…`、`/video/av…`、`m.bilibili.com/video/…`，含分 P（`?p=2`） |
| 動態（貼文） | `t.bilibili.com/{id}`、`www.bilibili.com/opus/{id}`、`m.bilibili.com/opus/{id}`、`m.bilibili.com/dynamic/{id}` |
| 直播 | `live.bilibili.com/{roomId}`、`/h5/{roomId}`、`/blanc/{roomId}` |
| 個人空間 | `space.bilibili.com/{mid}`（後面的 `/dynamic`、`/video` 等分頁都當成個人空間）、`m.bilibili.com/space/{mid}` |
| 短網址 | `b23.tv/{code}`、`bili2233.cn/{code}` |
| 會員購 | 商品：`mall.bilibili.com/…?itemsId={id}`。工房（UP 主商品）：`mall.bilibili.com/neul-next/index.html?page=mall-up_itemDetail&itemsId={id}`、`gf.bilibili.com/item/detail/{id}`。票務（漫展、演出）：`show.bilibili.com/platform/detail.html?id={id}` |

不在範圍：

- 番劇、電影、課程（`cheese`）、專欄舊網址（`/read/cv…`，新的專欄已經是 `/opus/`）、音訊、收藏夾、合集頁
- 直播的影像（只有 HLS／FLV，Discord 不能播），只顯示封面或關鍵影格
- 留言、彈幕
- 需要登入的內容：大會員限定、充電專屬、僅粉絲可見

## 2. 參考資料

- [rinnein/bilibili-API-collect](https://github.com/rinnein/bilibili-API-collect)：
  [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 的 fork，原專案已封存。
  文件的欄位說明可信，但**風控行為以實測為準**（文件寫 `view` 要 Cookie，實測不用）。
- [seriaati/fxBilibili](https://github.com/seriaati/fxBilibili)（Python，Embed Fixer 用的）：只做影片。
  可以參考的地方：`platform=html5` 取 MP4、有 `PROXY_URL` 設定（暗示伺服器 IP 會被擋）、
  程式註解寫 `/x/web-interface/view` 對非瀏覽器回 412、改用 `wbi/view`。
- 本專案只參考作法，程式碼自己寫。

## 3. 實測結果（家中網路，2026-10-07）

UA 是 `ebfix/1.0 (+https://ebfix.konnokai.me)`，除非另外註明，都沒有 Cookie。

### 3.1 共通

| 項目 | 結果 |
| --- | --- |
| HTML 頁面 | `www.bilibili.com/video/…`、`/opus/…` 都回 200，但內容是「验证码_哔哩哔哩」，沒有 og 標籤。**不能用 og 當備援** |
| WBI 簽名 | 不需要。下面選的端點都不用簽；有簽名的 `wbi/playurl` 不簽會回 `v_voucher` |
| 錯誤格式 | 幾乎都是 HTTP 200，看 JSON 的 `code`。`-352` 風控、`-412` IP 被擋、`-799` 太頻繁。412 時是 HTTP 412 加 HTML |
| 圖片（`i*.hdslb.com`） | 沒有 Referer 或 Discordbot UA：200。**Referer 是別的網域：403**。頁面要加 `<meta name="referrer" content="no-referrer">`，不然一般訪客看不到圖 |
| 圖片網址 | API 常給 `http://` 或 `//` 開頭，要補成 `https://` |

### 3.2 影片

樣本：`BV1z6pw6AEBD`（明日方舟终末地 官方帳號，132 秒，3840×2160，cid `42511107325`）。

| 抓法 | 結果 |
| --- | --- |
| `GET api.bilibili.com/x/web-interface/view?bvid=` | `code 0`。有標題、`desc`、`pic`、`pubdate`（秒）、`owner`（`mid`、`name`、`face`）、`stat`（播放、彈幕、讚、投幣、收藏、分享、留言）、`dimension`、`pages`（分 P 與 cid） |
| 同上，不帶 UA | 一樣 `code 0` |
| 不存在的 BV | `62002 稿件不可見`。`-404` 也出現過（`BV1GJ411x7h7`，被刪的影片） |
| `GET /x/player/playurl?bvid&cid&platform=html5&fnval=1&qn=64&high_quality=1`（舊端點，不用 WBI） | `code 0`，720P MP4（`durl[0].url`，132 秒約 22 MB）。`accept_quality` 只有 64、16 |
| MP4 網址（`upos-*.bilivideo.com`） | Discordbot UA：206 `video/mp4`。**不帶 UA：403**。Referer 是別的網域：206（`platform=html5` 沒有防盜鏈） |
| MP4 網址的期限 | `deadline` 約 2 小時後。網址帶 `oi`（請求方 IP），**換 IP 能不能播還沒驗證**，B0 一起測 |

文件列的其他狀態碼：`-403` 權限不足、`62004` 審核中、`62012` 僅 UP 主可見。

### 3.3 動態

端點：`GET api.bilibili.com/x/polymer/web-dynamic/v1/detail?id={id}&features=itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,commentsNewVersion`

| 條件 | 結果 |
| --- | --- |
| ebfix UA，有 `features` | 第一次 `code 0`，之後連續 3 次 `-352` |
| ebfix UA，沒有 `features` | `-352` |
| 瀏覽器 UA，沒有 Cookie | 連續 3 次 `code 0`（`desktop/v1/detail`、`opus/detail` 也可以） |
| ebfix UA ＋ `buvid3`、`buvid4`（從 `/x/frontend/finger/spi` 拿） | 連續 3 次 `code 0` |
| ebfix UA，`opus/detail`、`desktop/v1/detail` | `-352` |

各類型樣本（都是 ebfix UA ＋ `buvid3`）：

| ID | `type` | 結果 |
| --- | --- | --- |
| `967717348014293017` | `DYNAMIC_TYPE_DRAW` | `major.opus`：`summary.text`、`pics[]`（`url`、`width`、`height`）、`title` 是 null |
| `718377531474968613` | `DYNAMIC_TYPE_WORD` | `major.opus`，`pics` 是空的 |
| `718372214316990512` | `DYNAMIC_TYPE_ARTICLE` | `major.opus`，有 `title`，1 張圖 |
| `716526237365829703` | `DYNAMIC_TYPE_AV` | `major.archive`：`bvid`、`title`、`cover` |
| `866756840240709701` | `DYNAMIC_TYPE_FORWARD` | 自己的文字在 `module_dynamic.desc.text`，被轉發的在 `orig`（結構相同） |
| `716510857084796964` | — | `code 4101152 动态不可见` |
| `1` | — | `code 4101105 请求数据发生错误` |

共同欄位：`modules.module_author`（`name`、`mid`、`face`、`pub_ts` 秒、`official_verify`）、`modules.module_stat`（`like`、`comment`、`forward` 的 `count`）。

使用者提供的樣本（2026-10-07，同一個作者「花生酱键盘」，ebfix UA ＋ `buvid3`，每個連續 2 次都是 `code 0`）：

| ID | `type` | 內容 |
| --- | --- | --- |
| `1253923222570663945` | `DYNAMIC_TYPE_DRAW` | 純文字（`opus.pics` 是空的，`type` 仍是 DRAW）。附加 `additional.type = ADDITIONAL_TYPE_RESERVE`：`reserve.title`「视频预约：国庆大礼包」、`desc1.text`「预计10-01 10:00发布」、`desc2.text`「1166人预约」 |
| `1252082777581420547` | `DYNAMIC_TYPE_FORWARD` | 轉發自己的舊動態。`desc.text` 是轉發時的文字；`orig`（`1247669801756655624`）是 DRAW，有 `opus.title`、4 張圖（`http://` 開頭，PNG）。**`orig` 沒有 `module_stat`，`module_author.pub_time` 是空字串**（`pub_ts` 有值） |
| `1254051547614019681` | `DYNAMIC_TYPE_AV` | `desc.text` 是動態文字，`major.archive` 有 `bvid`、`title`、`desc`、`cover`、`duration_text`（`01:03:18`）、`stat.play`（`8.6万`，已經是縮寫文字）、`stat.danmaku` |

- `type` 只能當參考：沒有圖的 DRAW 和 WORD 一樣是 `major.opus`。解析時看 `major.type`，不要看 `type`。
- 這三個的 `rich_text_nodes` 都只有 `RICH_TEXT_NODE_TYPE_TEXT`。

富文本節點的樣本（使用者 2026-10-07 提供）：

| ID | 內容 | 節點 |
| --- | --- | --- |
| `1256157782414983170` | 甜夕sweet，3 張圖 | `EMOJI`（5 個）、`AT`、`TEXT` |
| `1256056816316448768` | 明日方舟终末地官方，抽獎動態，1 張圖，附遊戲卡片 | `LOTTERY`、`TOPIC`（2 個）、`BV`、`AT`、`TEXT` |

| 節點 | `text` | `orig_text` | 其他 |
| --- | --- | --- | --- |
| `EMOJI` | `[恶欲之花动态表情包_得意]` | 同左 | `emoji.icon_url`（PNG）、`gif_url`、`webp_url`、`jump_title`（「得意」）、`package_id` |
| `AT` | `@最爱夕宝の六月猪 ` | 同左 | `rid`（被 @ 的 mid） |
| `TOPIC` | `#明日方舟终末地#` | 同左 | `jump_url`（站內搜尋） |
| `BV` | 影片標題（`《明日方舟：终末地》核心章节「丹青渡」版本PV`） | 影片網址 | `rid`（BV 號）、`jump_url` |
| `LOTTERY` | `互动抽奖` | 同左 | `rid`（抽獎 ID） |

- **`summary.text` 等於所有節點 `orig_text` 接起來**（兩個樣本都驗證過）；用 `text` 接起來的話，`BV` 節點會變成影片標題、網址不見。
  所以直接用 `summary.text`（和 `desc.text`）就好，不用自己組節點：影片網址保留，Discord 會自動變成連結。
- 表情是 `[{表情包名稱}_{名稱}]` 這種文字。Discord 不能顯示 B 站表情圖片，照原文字保留，不去猜要不要縮短。
- `module_author.official_verify.type`：`-1` 沒有認證（Session小胡）、`0` 個人認證（甜夕sweet、花生酱键盘）、`1` 機構認證（明日方舟终末地）。
  `0`、`1` 都當成 `verified`。`desc` 在這次的樣本裡都是空字串，不能拿來判斷。
- `1256056816316448768` 附 `additional.type = ADDITIONAL_TYPE_COMMON`：`common.head_text`「相关游戏」、`title`「明日方舟：终末地」、`desc2`。

### 3.4 直播

| 抓法 | 結果 |
| --- | --- |
| `GET api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?room_ids={id}&req_biz=web_room_componet` | `code 0`。短號（`6`）也能查，回真正的 `room_id`（`7734200`）。有 `uname`、`title`、`cover`、`live_status`、`online`、`area_name`、`parent_area_name`、`live_time`、`tags`、`lock_status`、`hidden_status`、`is_encrypted`。**沒有頭像** |
| `GET /room/v1/Room/get_info?room_id=` | `code 0`，另外有 `keyframe`（直播中的畫面）、`user_cover` |
| `GET /live_user/v1/UserInfo/get_anchor_in_room?roomid=` | `code 0`，有 `face`、`official_verify` |
| 不存在的房間 | `get_info` 回 `code 1 未找到该房间` |

`live_status`：`0` 未開播（房間 `21452505`）、`1` 直播中（房間 `6`）、`2` 輪播（房間 `1`）。

### 3.5 個人空間

| 抓法 | 結果 |
| --- | --- |
| `GET api.bilibili.com/x/web-interface/card?mid={mid}&photo=true` | `code 0`（ebfix UA、瀏覽器 UA 都可以）。有 `name`、`face`、`sign`、`fans`、`attention`、`level_info`、`Official`、`vip`、`archive_count`、`like_num`、`space.l_img`（頭圖） |
| 不存在的 mid | `-404` |
| `/x/space/wbi/acc/info`（瀏覽器 UA、沒簽名） | `-352` |
| `/x/space/acc/info`（舊端點） | `-799 请求过于频繁` |
| `/x/polymer/web-dynamic/v1/feed/space` | HTTP 412（ebfix UA、瀏覽器 UA 都是）。**這次不需要**，只是記錄 |

### 3.6 短網址

| 網址 | 結果 |
| --- | --- |
| `b23.tv/BV1z6pw6AEBD` | 302 → `https://www.bilibili.com/video/BV1z6pw6AEBD` |
| `b23.tv/av117393368024264` | 302 → `/video/av117393368024264` |
| `bili2233.cn/BV1z6pw6AEBD` | 跟 `b23.tv` 一樣 |
| `HEAD` | 一樣回 302 和 `Location` |
| `b23.tv/pigt3PQ`（文件的範例，已過期）、假代碼 | 200，沒有轉址 |

App 分享的 7 碼短網址（使用者 2026-10-07 提供，iOS 和 Android 都有），全部 302，`Location` 如下（只列路徑和重要參數）：

| 代碼 | 類型 | `Location` |
| --- | --- | --- |
| `uktqtZS` | 影片（Android） | `https://www.bilibili.com/video/BV1mhHa6oE2y?…&p=1&…` |
| `TDTz3gK` | 影片（iOS） | `https://www.bilibili.com/video/BV1sdRuBMEci?…&p=1&…` |
| `d0hAOPB` | 影片（iOS） | `https://www.bilibili.com/video/BV1w9am6sEKP?…&p=1&…` |
| `4uA1Ioz` | 個人空間 | `https://m.bilibili.com/space/287490521?…` |
| `xROzD8H` | 個人空間 | `https://m.bilibili.com/space/194240114?…` |
| `nM1r26M` | 會員購 | `https://mall.bilibili.com/neul-next/index.html?…&itemsId=1108437011&page=mall-up_itemDetail&…` |
| `M6p76JL` | 會員購 | `https://mall.bilibili.com/neul-next/index.html?…&itemsId=1109536086&page=mall-up_itemDetail&…` |
| `EJcjzB8` | 直播 | `https://live.bilibili.com/21428918?broadcast_type=0&is_room_feed=1&…` |
| `p6urBBY` | 直播 | `https://live.bilibili.com/3605765?…` |

- 轉址後的網址帶很多追蹤參數：`buvid`（分享者的裝置 ID）、`mid`（加密過的分享者 ID）、`share_session_id`、`timestamp`、`unique_k`、`up_id`、`spmid` 等。
  **全部丟掉**，不能出現在 `og:url`、原文連結或 D1 的 `source_url`。
- 影片網址都帶 `p=1`，等同沒有分 P。
- 個人空間是 `m.bilibili.com/space/{mid}`，不是 `space.bilibili.com`。
- 會員購兩個都是 `page=mall-up_itemDetail`，也就是**工房**商品（第 3.7 節），不是一般會員購商品。
- 解析出來的內容都用第 3.2–3.7 節的 API 測過，全部拿得到：三支影片、兩個個人空間、兩個直播間（都在直播中）、兩個工房商品。
- 個人空間 `287490521`（孤之界）的 `fans`、`archive_count` 都是 0，不確定是真的 0 還是被隱藏；0 時不顯示。
- 動態在 App 裡沒有「分享連結」的選項（使用者 2026-10-07 確認），所以不會有動態的短網址。

### 3.7 會員購

參考專案沒有會員購。用內建瀏覽器開商品頁，看實際呼叫的 API。

商品（樣本 `13657913`，歪瓜出品 罗小黑tv 干发帽）：

| 抓法 | 結果 |
| --- | --- |
| `GET mall.bilibili.com/mall-search-items/items/merchant/info?itemsId={id}` | `success: true`。有 `name`、`brief`、`img[]`（`//` 開頭）、`price`、`maxPrice`（字串，人民幣）、`brandName`、`ipRightName`、`saleStatus`、`shopInfoVO.shopName`、`itemsLikeVO.count`（想要人數） |
| 不存在的商品 | `code 81100001 商品不存在或被删除` |
| `mall-c/items/info`（舊端點） | HTTP 404 |
| `mall-c-search/items/info/live` | `-101 账号未登录` |

票務（樣本 `98594`，南京 BanG Dream 同人 Only 展）：

| 抓法 | 結果 |
| --- | --- |
| `GET show.bilibili.com/api/ticket/project/getV2?id={id}` | `success: true`。有 `name`、`cover`、`start_time`、`end_time`（秒）、`venue_info.name`、`price_low`、`price_high`（**單位是分**）、`sale_flag`（例如「已结束」） |
| 不存在的 ID | `code 81100020 获取项目详情失败` |

使用者提供的樣本（2026-10-07）：

| 項目 | `1005507` | `1006027` |
| --- | --- | --- |
| 原網址 | `/platform/detail.html?id=1005507` | `/platform/detail.html?id=1006027&from=pc_ticketlist` |
| `name` | 上海·《魔法少女小圆》15周年纪念特展 | 上海·原神同人Only · 至冬/ 挪德卡莱主题同人展 |
| `project_type` | `2`（展覽，開 40 天） | `1`（同人展，2 天） |
| `project_label` | `2026.09.23-11.01（以现场为准）` | `2026.10.06-10.07（以现场为准）` |
| `sale_flag` | 预售中 | 预售中 |
| `price_low`–`price_high` | `9800`–`9800` | `22800`–`39800` |
| 場地 | `venue_info.name` 上海新世界城，`city_name` 上海 | 虹桥品汇，`city_name` 上海，`district_name` 闵行 |
| `screen_list` | 3 個場次，各有 `sale_flag.display_name` 和 `ticket_list[].desc`／`price` | 3 個場次（單日、聯票），其中「已停售」「已售罄」各一 |
| `guests` | 空 | 有（Coser 名稱、說明、頭像） |

- `project_label` 是現成的日期文字，比自己格式化 `start_time`／`end_time` 好。
- **`price_low` 不一定是最低票價**：`1006027` 有 128 元的單日票，但已停售或售罄，`price_low` 是 228。
  表示「目前買得到的價格」，照用即可，不從 `screen_list` 重算。
- `cover` 是直式海報（`//` 開頭），`banner` 是橫圖（`https://` 開頭）。Discord 預覽用 `banner` 比較好看，沒有時用 `cover`。
- `from=pc_ticketlist` 是來源追蹤，丟掉。

一般商品，使用者提供的樣本（2026-10-07，都是首頁推薦連結）：

| 項目 | `13625699` | `11126670` |
| --- | --- | --- |
| `name` | bilibiliGoods 哔哩哔哩拜年纪 Horse降临系列 桌垫 | 哔哩哔哩 2233 共舞弥新 乙巳蛇年拜年纪限定ver. 1/7 比例手办 |
| `price` | `"69"` | `"1988"` |
| `brandName` | BILIBILIGOODS | 哔哩哔哩 |
| `brief` | 空 | 有（「周年庆限时返场！…」） |
| `img` | 5 張 | 6 張 |
| `itemsLikeVO.count` | 1650 | 5589 |
| 定金 | 無 | `itemsDepositVO`：`depositPrice` `"298.2"`（定金預購） |

原網址長這樣（只列結構）：

```text
/neul-next/detailuniversal/detail.html?page=detailuniversal_detail&itemsId=13625699&loadingShow=1#noReffer=true&is_ad=0&track_id=…&msource=mallhome_pc
```

- `page`、`loadingShow` 是頁面參數，丟掉；只留 `itemsId`。
- `#` 後面（`track_id`、`msource` 等）是 fragment，瀏覽器和 Discord 都**不會**送到伺服器，Worker 看不到，不用處理。
  首頁的轉換框要在瀏覽器端把 fragment 一起丟掉，免得使用者以為追蹤參數會被帶著走。

工房（UP 主賣的商品，樣本 `1108437011`、`1109536086`，從使用者提供的短網址解析出來）：

`mall.bilibili.com/neul-next/index.html?page=mall-up_itemDetail&itemsId=…` 在瀏覽器裡會轉到 `gf.bilibili.com/item/detail/{id}`（哔哩哔哩工房），
跟一般會員購商品是**不同的系統**。一般商品的 `merchant/info` 查工房的 ID 會回 `81100001 商品不存在`。

| 抓法 | 結果 |
| --- | --- |
| `GET mall.bilibili.com/mall-up-search/items/info?itemsId={id}`（有沒有 `itemsPreviewId=0` 都可以） | `success: true`，約 5 KB。有 `name`、`description`（全文）、`mainImgList[]`（`//` 開頭）、`price`（**單位是分**，`100` 頁面顯示 ￥1）、`itemsDiscountPriceVO.discountPrice`（粉絲專享價，也是分）、`saleNum`（「已售310」這種文字）、`shopInfo.shopUserNickName`、`shopInfo.shopUserFace`、`shopInfo.shopUserMid`、`headVideo.video[].aid`／`cid`（商品介紹影片） |
| 不存在的 ID | `code 81102094 查询的作品不存在` |
| `gf.bilibili.com/item/detail/{id}` 頁面 | 200，約 1.8 KB 的 SPA 空殼，沒有資料 |

一般商品網址有好幾種，id 都在 query string：`/neul-next/detailuniversal/detail.html?itemsId=`（首頁推薦連結用這個）、
`/detail.html?itemsId=`。**`page=` 不是 `mall-up_itemDetail` 的 `/neul-next/index.html` 網址沒有樣本**。

## 4. 網域與路由

### 網域

動態（`t.`）、直播（`live.`）、個人空間（`space.`）的路徑都是 `/{數字}`，而且位數會重疊
（mid 已經到 16 位，舊的動態 ID 是 18 位），只看路徑分不出來。規則改成**把 `bilibili.com` 換成 `bili.ebfix.konnokai.me`**：

| 原網域 | ebfix 網域 |
| --- | --- |
| `www.bilibili.com`、`m.bilibili.com`、`bilibili.com` | `bili.ebfix.konnokai.me`（也接受 `www.bili.`、`m.bili.`） |
| `t.bilibili.com` | `t.bili.ebfix.konnokai.me` |
| `live.bilibili.com` | `live.bili.ebfix.konnokai.me` |
| `space.bilibili.com` | `space.bili.ebfix.konnokai.me` |
| `mall.bilibili.com` | `mall.bili.ebfix.konnokai.me` |
| `show.bilibili.com` | `show.bili.ebfix.konnokai.me` |
| `gf.bilibili.com` | `gf.bili.ebfix.konnokai.me` |
| `b23.tv`、`bili2233.cn` | `b23.ebfix.konnokai.me` |

- 每個網域都是一個 Custom Domain，各自有憑證（不用買萬用字元憑證）。在 dashboard 加，不寫進 `wrangler.jsonc`（理由同 Facebook F4）。
- 共用網域 `ebfix.konnokai.me` 只接 `/video/…`、`/opus/…`：這兩個不跟其他平台衝突。其他類型的路徑都是 `/{數字}`，不放共用網域。
- `HOST_PROVIDERS` 加上表的網域，都對應 `[bilibili]`。
- 首頁的轉換框照上表換網域。

### 路徑與 `post_key`

| 類型 | 路徑（在對應網域上） | `post_key` |
| --- | --- | --- |
| 影片 | `/video/{BV號}`、`/video/av{aid}`，可選 `?p={n}` | `video:{BV號}`，`p` 大於 1 時 `video:{BV號}:p{n}` |
| 動態 | `t.`：`/{id}`；`bili.`：`/opus/{id}`、`/dynamic/{id}` | `dynamic:{id}` |
| 直播 | `/{roomId}`、`/h5/{roomId}`、`/blanc/{roomId}` | `live:{真正的 room_id}`（短號解析後改成長號） |
| 個人空間 | `space.`：`/{mid}`、`/{mid}/{任何分頁}`；`bili.`：`/space/{mid}` | `space:{mid}` |
| 商品 | `/neul-next/detailuniversal/detail.html`、`/detail.html`，都要有 `itemsId` | `mall:{itemsId}` |
| 工房 | `mall.`：`/neul-next/index.html?page=mall-up_itemDetail&itemsId=`；`gf.`：`/item/detail/{id}` | `gf:{itemsId}` |
| 票務 | `/platform/detail.html?id=` | `show:{id}` |
| 短網址 | `/BV…`、`/av…`、`/{代碼}` | 解析前 `b23:{代碼}`，解析後換成上面的 key |

- `av` 號在本機換成 BV 號（演算法見參考專案 `docs/misc/bvid_desc.md`），同一支影片不論從哪個網址進來都是同一個 key。
- query string 只保留 `p`、`itemsId`、`id`、`page`（只用來分辨工房），其他（`spm_id_from`、`vd_source`、`share_source`、`t`，
  還有短網址帶的 `buvid`、`mid`、`share_session_id` 等）全部丟掉。`p=1` 等同沒有 `p`。
- `/neul-next/index.html` 的 `page` 不是 `mall-up_itemDetail` 時：沒有樣本，先回 400。
- `BV` 號是 `BV1` 加 9 個 base58 字元。不符合格式的直接回 400，不請求上游。

## 5. Provider 設計

**一個 provider（`bilibili`），用 `ref.params.kind` 分辨類型。** 理由：短網址解析後可能是任何類型，
而 `resolve` 只能回傳同一個 provider 的 ref。分成多個 provider 的話，短網址就要另外做跨 provider 的轉交。

```text
src/providers/bilibili/
  index.ts     provider 定義；match 看 hostname + 路徑，決定 kind
  http.ts      共用請求：UA、buvid3、狀態碼分類、圖片網址補 https
  bvid.ts      av ↔ BV 轉換
  short.ts     b23.tv 解析（resolve）
  video.ts     view + playurl
  dynamic.ts   動態詳情
  live.ts      getRoomBaseInfo + get_anchor_in_room
  space.ts     card
  mall.ts      商品、工房、票務
```

`fetchers` 只有一個 `api`，裡面依 `kind` 呼叫對應的模組。每種類型只有一個來源，沒有備援層（HTML 是驗證碼頁）。

### 要改的共用程式

| 改動 | 原因 |
| --- | --- |
| `NormalizedPost.stats` 加 `views`，`page.ts` 顯示 `▶️` | 影片播放數、直播觀看數是最重要的數字。`hashPost` 本來就不含 `stats`，不會多出版本 |
| `Provider.cacheTtl`、`serveStoredWhenUnavailable` 可以是 `(ref) => …` | 直播狀態一直在變，要用比較短的快取；直播和個人空間不需要「刪除後回舊版本」 |
| `Provider` 加 `store?: (ref) => boolean`，`false` 時不寫 `post_versions`（`posts` 照寫） | 直播的關鍵影格、標題常常換，每次都會算出新 hash，`post_versions` 會一直長 |
| 頁面加 `<meta name="referrer" content="no-referrer">` | 第 3.1 節：`hdslb.com` 圖片看到外站 Referer 回 403 |
| 健康檢查：`healthCheckPath` 可以是完整網址 | 現在用假的 `health-check.invalid` 網域，bilibili 的 `match` 要看網域。樣本用影片的話路徑在任何網域都對得上，這項可以先不改 |

## 6. 各類型的資料對應

### 影片

1. `view?bvid=`（`av` 號已先換成 BV）。
2. `playurl?bvid&cid&platform=html5&fnval=1&qn=64&high_quality=1`，`cid` 用 `pages[p-1].cid`。失敗不影響貼文，只是沒有影片。
   `is_upower_exclusive`（充電專屬）時不呼叫，只放封面。

| `NormalizedPost` | 來源 |
| --- | --- |
| `title` | `title`；分 P 時加 ` P{n} {pages[n-1].part}` |
| `author` | `owner.name`、`owner.face`、`https://space.bilibili.com/{mid}` |
| `text` | `desc` |
| `media` | 有 MP4：`video`（`width`、`height` 用 `dimension`，`rotate` 是 1 時對調）。沒有：`pic` 當 `image` |
| `stats` | `views`＝`stat.view`、`likes`＝`stat.like`、`replies`＝`stat.reply`、`shares`＝`stat.share`。數字轉成「8.5萬」的格式（跟 B 站顯示一樣） |
| `createdAt` | `pubdate` |

`code` 對應：`0` → public；`-404`、`62002` → `not_found`；`62004`、`62012` → `restricted`；`-403` → `login_required`；
`-352`、`-412`、`-799`、HTTP 412、其他 → `transient`。

### 動態

| `NormalizedPost` | 來源 |
| --- | --- |
| `title` | 有 `opus.title` 用它，否則 `{作者} 的動態` |
| `author` | `module_author`：`name`、`face`、`https://space.bilibili.com/{mid}`；`official_verify.type` 是 `0` 或 `1` 時 `verified` |
| `text` | 依 `major.type`：`MAJOR_TYPE_OPUS` 用 `opus.summary.text`；`MAJOR_TYPE_ARCHIVE` 用 `desc.text`，再加一行「▶️ {archive.title}（{duration_text}，播放 {stat.play}）」；轉發（沒有 `major`）用 `desc.text`。有 `ADDITIONAL_TYPE_RESERVE` 時最後加一行「📅 {reserve.title}・{desc1.text}・{desc2.text}」；有 `ADDITIONAL_TYPE_COMMON` 時加一行「{head_text}：{title}」。富文本一律用 `summary.text`／`desc.text`，不自己組節點（第 3.3 節） |
| `media` | `opus.pics[]`（最多 10 張）；影片動態用 `archive.cover`，不另外抓 MP4 |
| `quoted` | 轉發：`orig` 的作者和文字、圖片（`orig` 沒有互動數和 `pub_time`，不顯示） |
| `stats` | `likes`、`replies`＝`comment`、`reposts`＝`forward` |
| `createdAt` | `pub_ts`（`pub_time` 可能是空字串，不用） |

`code` 對應：`4101152`（不可見）→ `login_required`（可能是僅粉絲可見或已刪除，卡片要寫明）；`4101105` → `not_found`；`-352` → `transient`。
`buvid3` 每個 isolate 抓一次，放在記憶體；收到 `-352` 時換一個新的重試一次。

### 直播

先 `getRoomBaseInfo`（短號換長號），再 `get_anchor_in_room` 拿頭像（失敗就不放頭像）。

| `NormalizedPost` | 來源 |
| --- | --- |
| `title` | `title` |
| `author` | `uname`、`face`、空間網址 |
| `topic` | `{parent_area_name} › {area_name}` |
| `text` | 狀態一行（`🔴 直播中，從 {live_time} 開始`／`未開播`／`輪播中`），加上 `description` |
| `media` | 直播中用 `keyframe`，否則 `cover` |
| `stats` | `views`＝`online` |

`lock_status`、`is_encrypted`、`hidden_status` 不是 0 → `restricted`。快取 60 秒，不存版本（`store: false`），不回舊版本。

### 個人空間

| `NormalizedPost` | 來源 |
| --- | --- |
| `title` | `name` |
| `author` | `name`、`face`、`Official.title` 有值時 `verified` |
| `text` | `sign`，加一行 `Lv{level}・粉絲 {fans}・投稿 {archive_count}` |
| `media` | `space.l_img`（頭圖）；沒有就不放 |

快取 600 秒，不存版本。

### 會員購

| `NormalizedPost` | 商品 | 工房 | 票務 |
| --- | --- | --- | --- |
| `title` | `name` | `name` | `name` |
| `siteName` | `bilibili 會員購` | `bilibili 工房` | `bilibili 會員購` |
| `author` | `shopInfoVO.shopName` | `shopInfo.shopUserNickName`、`shopUserFace`、空間網址（`shopUserMid`） | 不放 |
| `text` | `¥{price}`（`maxPrice` 不同時 `¥{price}–{maxPrice}`；有 `itemsDepositVO` 時加「定金 ¥{depositPrice}」）、`brandName`、`ipRightName`、`brief` | `¥{price/100}`（有 `discountPrice` 時加「粉絲價 ¥{discountPrice/100}」）、`saleNum`、`description` | `project_label`、`{city_name}・{venue_info.name}`、`¥{price_low/100}`（`price_high` 不同時加 `–{price_high/100}`）、`sale_flag` |
| `media` | `img[]` 前 4 張 | `mainImgList[]` 前 4 張 | `banner`，沒有時 `cover` |
| `stats` | `likes`＝`itemsLikeVO.count`（想要） | 不放 | 不放 |

- 金額單位：一般商品是元（字串），工房和票務是**分**（數字）。
- 工房的 `headVideo` 有商品介紹影片的 `aid`／`cid`，可以用影片的 `playurl` 拿 MP4。B4 先不做，只放圖。

`81100001`、`81102094`、`81100020` → `not_found`。會員購的請求沒有看到風控，但量少，先不特別處理。

### 短網址

`resolve`：`GET https://b23.tv/{代碼}`，`redirect: "manual"`，只看 `Location`。

- `Location` 是 `bilibili.com` 的網址：用同一個 `match` 解析成上面的類型，丟掉追蹤參數。
- 是 `bilibili.com` 但不在支援的類型（番劇、合集等）：回「不支援的內容」卡片（`not_found`，`errorCode: unsupported_target`，跟 Facebook 一樣）。
- 200 沒有轉址、或轉到其他網域：`transient`（`share_unresolved`）。分不出過期和格式改變。
- `/BV…`、`/av…` 不用請求，直接當成影片。

## 7. 媒體

- 圖片：`http://`、`//` 一律補成 `https://`。只接受 `*.hdslb.com`。大圖可以加 `@1280w.jpg` 之類的後綴縮小（B 站 CDN 支援），
  4K 封面原圖有好幾 MB，Discord 不需要。實作時確認後綴格式。
- 影片：只有 `platform=html5` 的 MP4，720P（未登入最高）。長影片（例如 73 分鐘的前瞻節目）MP4 有好幾百 MB，
  Discord 能不能處理要實測；超過某個長度可能只放封面。
- 影片網址約 2 小時過期，而且帶 `oi`（請求方 IP）。快取 600 秒沒問題；D1 舊版本的影片網址一定過期，
  沿用「簽章過期就算了」。如果 Discord 播放常失敗，B6 再考慮做轉址端點：`og:video` 指向
  `bili.ebfix.konnokai.me/_video/{BV}/{cid}`，每次請求時重抓 `playurl` 再 302 到新的 MP4 網址。

## 8. 快取與 D1

| 類型 | 公開 | 狀態卡 | 存版本 | 刪除後回舊版本 |
| --- | --- | --- | --- | --- |
| 影片 | 600 秒 | 60 秒 | 是 | 是 |
| 動態 | 600 秒 | 60 秒 | 是 | 是 |
| 直播 | 60 秒 | 60 秒 | 否 | 否 |
| 個人空間 | 600 秒 | 60 秒 | 否 | 否 |
| 會員購 | 600 秒 | 60 秒 | 是 | 是 |

D1 不用改 schema，`platform = 'bilibili'`，`post_key` 帶類型前綴（第 4 節）。

## 9. 實作階段

### 階段 B0：Cloudflare 出口實測（**先做**；方式由使用者 2026-10-07 決定）

Bilibili 會擋機房 IP，這是整個計畫最大的風險。用 `wrangler dev --remote` 測：

- 臨時腳本和它自己的 `wrangler.jsonc` 放在 repo 外（session 的 scratchpad），不 commit，不碰正式 Worker 和 D1。
  `--remote` 會把 preview Worker 上傳到 Cloudflare 執行，所以請求是從 Cloudflare 出口送出的。需要先 `wrangler login`。
- 腳本只打固定的端點清單，回傳每個請求的 HTTP 狀態、JSON `code` 和回應開頭，不接受任意網址。

要測的：

- 第 3 節每一個端點：`view`、`playurl`、`finger/spi`、動態詳情（帶／不帶 `buvid3`，各連續 5 次）、`getRoomBaseInfo`、
  `get_anchor_in_room`、`card`、一般商品 `merchant/info`、工房 `mall-up-search/items/info`、票務 `getV2`、`b23.tv` 轉址。
- 從家裡用 curl 抓 Worker 拿到的 MP4 網址，帶 Discordbot UA（驗證 `oi` 是 Cloudflare IP 時，別的 IP 能不能播）。
- 同一批再從家裡打一次對照，記下時間，區分「Cloudflare 被擋」和「當下 B 站本來就不穩」。

結果決定後面怎麼做：

- 都正常 → 照計畫。
- 部分 412 → 那幾種類型不做，或改用其他端點再測。
- 全部 412 → 整個平台暫停，回報使用者。不做代理（不在範圍）。

#### B0 結果（2026-10-07，**幾乎全部 412，整個平台暫停**）

跑了兩輪 `wrangler dev --remote`。出口是 `2a06:98c0:3600::103`（Cloudflare Workers 共用的 IPv6 出口），`colo=SJC`。

第一輪（04:09Z，ebfix UA）：

| 端點 | 結果 |
| --- | --- |
| `view`（3 支影片）、`playurl`、`finger/spi`、動態（不帶 `buvid3` 5 次）、`card`（2 個）、`getRoomBaseInfo`、`get_info`、`get_anchor_in_room`、`merchant/info`、`mall-up-search/items/info`、`getV2` | **全部 HTTP 412**（B 站的 HTML 攔截頁） |
| 動態帶 `buvid3`（5 次） | 412。`finger/spi` 本身就 412，拿不到真的 `buvid3`，所以這 5 次其實沒帶 Cookie |
| `wbi/view` | 200，`code 0` |
| `b23.tv`（`/BV…` 和 4 個分享短網址） | 全部 302，`Location` 正常 |

第二輪（04:10Z），13 個端點，每個各用 4 組標頭：ebfix UA、瀏覽器 UA、瀏覽器 UA 加 `referer`／`origin: https://www.bilibili.com`、ebfix UA 加同樣的 `referer`／`origin`：

- 52 個請求只有 **1 個** 成功（`merchant/info`，ebfix UA），其他全是 412。第一輪成功的 `wbi/view` 這輪也 412。
- 換 UA、加 Referer 都沒有差別，**不是看標頭，是 IP 被擋**。偶爾成功一次不能拿來用。
- `playurl` 拿不到，所以「MP4 換 IP 能不能播」沒測到。

家中網路對照（04:10:47Z，跑完第二輪 13 秒後）：`view`、`wbi/view`、`playurl`、`finger/spi`、`card`、`getRoomBaseInfo`、
`mall-up-search/items/info`、`getV2` **全部 200、`code 0`**。B 站當時沒有問題，被擋的是 Cloudflare 出口。

其他：

- 只有短網址能用，但只解析短網址沒有意義（解析完還是要打 API）。
- Workers 沒辦法換出口 IP；Containers、Browser Run 一樣從 Cloudflare 的 IP 出去，預期結果相同（沒測）。
- 跟 fxBilibili 有 `PROXY_URL` 設定的情況一致：B 站擋機房 IP。
- `wrangler dev --remote` 的 preview 會被 preview 工具定期送 `HEAD /` 觸發，整套探測多跑了幾次。下次要讓腳本只回應 `GET`，或用 curl 直接跑 `wrangler dev`。

依原本的規則，**整個平台暫停**。要繼續的話只剩「從不是機房的 IP 發請求」這條路，也就是代理。
代理原本不在範圍，要不要做、怎麼做由使用者決定（第 10 節第 1 項）。

### 階段 B1：影片 ＋ 共用改動

- 第 5 節的共用改動（`stats.views`、per-ref 設定、`store`、`no-referrer`）。
- `bilibili` provider：`match`（看 hostname）、`bvid.ts`、`video.ts`。
- fixture：`view`、`playurl` 的 JSON（成功、`62002`、`-404`、`-352`、分 P、充電專屬）。JSON 不大，整份存。
- router：`HOST_PROVIDERS` 加 `bili.ebfix.konnokai.me`，共用網域接 `/video/`。
- 驗收：`npm test`、`npm run typecheck`；`wrangler dev --local` 打真的影片。

### 階段 B2：動態

- `dynamic.ts`、`buvid3` 管理。fixture 用第 3.3 節的樣本，至少涵蓋：有圖的 DRAW、沒圖的 DRAW（附預約）、WORD、ARTICLE、
  AV、FORWARD、有表情和 @ 的、有話題／BV／抽獎節點的、`4101152`、`4101105`、`-352`。
- 驗收同上，加 `t.bili.` 網域。

### 階段 B3：直播、個人空間

- `live.ts`、`space.ts`。fixture：直播中、未開播、輪播、短號、不存在；個人空間正常、不存在。

### 階段 B4：會員購

- `mall.ts`：一般商品、工房、票務。fixture：第 3.7 節的樣本和不存在的 ID。
- 加 `mall.bili.`、`gf.bili.`、`show.bili.` 網域。

### 階段 B5：短網址、上線

- `short.ts`。轉址回應用 stub 產生，`Location` 用第 3.6 節的真實樣本（含追蹤參數，測試要確認都被丟掉）。
- 一般商品、票務的短網址沒有樣本。先假設 `b23.tv` 一律 302 到原網址（使用者 2026-10-07 決定），轉到的網址交給同一個 `match`；比對不到就回「不支援的內容」卡片。
- Custom Domain（使用者在 dashboard 操作）、首頁轉換框、健康檢查樣本（`/video/BV1z6pw6AEBD`）、README。
- 上線後用 curl 測一次，再請使用者在 Discord 實測：影片能不能播、多圖、轉發、直播、會員購。

### 階段 B6：視情況

- 影片轉址端點（第 7 節）。
- 健康檢查改成每種類型一個樣本（動態最容易被風控，只測影片可能漏掉）。

## 10. 待確認事項

1. **Cloudflare 出口會不會被 412**：**會**（B0，2026-10-07），幾乎所有 API 都 412，只有 `b23.tv` 正常。要繼續就要代理，由使用者決定：
   - 自己的 VPS 或家裡的機器跑一個只轉發固定 B 站端點的小服務，Worker 經由它請求（例如 Cloudflare Tunnel 接到家裡，或有固定 IP 的 VPS）。要先驗證那個 IP 不會被擋。
   - 不做，Bilibili 暫停。
2. **MP4 換 IP 能不能播**（`oi` 參數）：B0 拿不到 `playurl`，沒測到。有代理的話，代理的 IP 和 Discord 的 IP 一樣不同，還是要測。
3. **動態的 `-352` 頻率**：家中網路 ebfix UA 不帶 Cookie 時 4 次只成功 1 次；帶 `buvid3` 3 次都成功。量大時會不會也被擋還不知道。
4. ~~樣本~~：使用者 2026-10-07 提供了短網址（影片、個人空間、工房、直播，第 3.6 節）、動態（第 3.3 節）、
   一般商品和票務（第 3.7 節）的樣本。一般商品、票務的 App 分享短網址沒有樣本，先假設一律 302（使用者 2026-10-07 決定）；動態在 App 裡不能分享連結。動態的表情、@、話題、BV、抽獎節點已有樣本（第 3.3 節）。
5. **Discord 能不能播大 MP4**：長影片要實測。
6. **僅粉絲可見、充電專屬的動態與影片**：沒有樣本，推測分別是 `4101152` 和 `is_upower_exclusive`。

## 11. 參考資料

- bilibili-API-collect（fork）：https://github.com/rinnein/bilibili-API-collect
  - 影片：`docs/video/info.md`、`docs/video/videostream_url.md`（`platform=html5` 沒有防盜鏈）
  - 動態：`docs/dynamic/detail.md`、`docs/dynamic/dynamic_enum.md`
  - 直播：`docs/live/info.md`
  - 使用者：`docs/user/info.md`（`/x/web-interface/card`）
  - 短網址：`docs/misc/b23tv.md`；av／BV：`docs/misc/bvid_desc.md`
  - 錯誤碼：`docs/misc/errcode.md`；`buvid3`：`docs/misc/buvid3_4.md`
- fxBilibili：https://github.com/seriaati/fxBilibili
