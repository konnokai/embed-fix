/**
 * Discord webhook notifications (health check failures and deploys), plus the
 * `health_state` table that remembers what was already announced.
 */

/**
 * Posts one message to the `HEALTH_WEBHOOK_URL` webhook. Returns false when no
 * webhook is set or the post failed.
 *
 * 通知失敗只記 log，不往外丟：不能因為 Discord 掛了讓排程或請求變成失敗。
 * log 裡不放 webhook 網址，因為網址本身就是憑證。
 */
export async function sendWebhook(env: Env, content: string): Promise<boolean> {
  if (!env.HEALTH_WEBHOOK_URL) {
    return false;
  }
  try {
    const response = await fetch(env.HEALTH_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ebfix", content, allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) {
      console.error(JSON.stringify({ event: "health_webhook_failed", httpStatus: response.status }));
      return false;
    }
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: "health_webhook_failed", error: String(error) }));
    return false;
  }
}

export async function readState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM health_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Sets a state value; returns true only when the stored value actually changed. */
export async function writeState(db: D1Database, key: string, value: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO health_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE health_state.value != excluded.value`,
    )
    .bind(key, value, Date.now())
    .run();
  return result.meta.changes > 0;
}

/**
 * Announces a new Worker version once. Workers have no startup event, so this
 * runs on the first request of each isolate and on every cron run.
 *
 * 先用 writeState 搶下這個版本：同時啟動的多個 isolate 只有一個會改到資料，
 * 所以只送一次。送出失敗也不重送，這則只是部署確認，不值得重試。
 */
export async function announceDeploy(env: Env): Promise<void> {
  const version = env.CF_VERSION_METADATA;
  if (!version?.id || !env.HEALTH_WEBHOOK_URL) {
    return;
  }
  try {
    if (!(await writeState(env.DB, "deploy", version.id))) {
      return;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "deploy_state_failed", error: String(error) }));
    return;
  }
  const created = Date.parse(version.timestamp);
  const lines = [`✅ ebfix 已部署 \`${version.id.slice(0, 8)}\``];
  if (Number.isFinite(created)) {
    lines.push(`版本建立於 <t:${Math.floor(created / 1000)}:f>`);
  }
  await sendWebhook(env, lines.join("\n"));
}
