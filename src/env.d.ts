// secret 不在 wrangler.jsonc 裡，`wrangler types` 產生不出來，所以手動宣告。
// 設成選填：本機開發和測試沒有設定時，健康檢查只寫 log。
// 全域 Env 和 Cloudflare.Env 都繼承 __BaseEnv_Env，宣告在這裡兩邊都會有。
interface __BaseEnv_Env {
  /** Discord webhook for health check failures, set with `wrangler secret put HEALTH_WEBHOOK_URL`. */
  HEALTH_WEBHOOK_URL?: string;
}
