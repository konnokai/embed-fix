/**
 * Creation time from a Threads post code.
 *
 * A post code is the Instagram media ID in URL-safe base64, and the media ID
 * carries its creation time in milliseconds since the Instagram epoch in the
 * bits above bit 23. Checked 2026-10-03 against six embed pages: every decoded
 * time matched the displayed one to the minute (the embed shows US Pacific
 * time). The embed page itself only has localized text, so this is the only
 * machine-readable time available without logging in.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 2011-08-24T21:07:01.721Z */
const INSTAGRAM_EPOCH_MS = 1314220021721;

/** Threads launched on 2023-07-05; anything earlier means the code is not a post code. */
const EARLIEST_MS = Date.UTC(2023, 6, 1);

export function createdAtFromCode(code: string, now: number = Date.now()): string | null {
  if (!code || code.length > 16) {
    return null;
  }
  let id = 0n;
  for (const char of code) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) {
      return null;
    }
    id = id * 64n + BigInt(value);
  }
  const ms = Number(id >> 23n) + INSTAGRAM_EPOCH_MS;
  // 解出來的時間不合理（測試用的假代碼、格式改變）就當作不知道，不顯示錯的日期。
  if (ms < EARLIEST_MS || ms > now + 24 * 60 * 60 * 1000) {
    return null;
  }
  return new Date(ms).toISOString();
}
