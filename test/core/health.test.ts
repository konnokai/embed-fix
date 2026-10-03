import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealthChecks } from "../../src/core/health";
import worker from "../../src/index";
import { PROVIDERS } from "../../src/router";
import { resetDatabase } from "../helpers";
import text from "../providers/threads/fixtures/text.html?raw";
import unavailable from "../providers/threads/fixtures/unavailable.html?raw";
import { html, stubFetch } from "../providers/threads/stub";
import facebookVideo from "../providers/facebook/fixtures/plugin-video.html?raw";

const NAVER_BODY = JSON.stringify({
  result: {
    article: { subject: "제목", contentHtml: "<p>본문</p>", writer: { nick: "작성자" } },
    cafe: { name: "카페" },
  },
});

// 通知邏輯的測試只看 Naver 和 Threads 兩個平台，Facebook 只在前兩個測試確認有被檢查。
const TWO_PLATFORMS = PROVIDERS.filter((provider) => provider.id !== "facebook");

function healthyFacebook(url: string): Response | null {
  return url.includes("facebook.com") ? html(facebookVideo) : null;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("health check", () => {
  it("checks one fixed sample per platform and logs nothing when all are public", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stubFetch(
      (url) => healthyFacebook(url) ?? (url.includes("naver.com") ? new Response(NAVER_BODY) : html(text)),
    );

    const results = await runHealthChecks(PROVIDERS, env);

    expect(results).toEqual([
      { platform: "naver", status: "public", fetcher: "api" },
      { platform: "threads", status: "public", fetcher: "embed" },
      { platform: "facebook", status: "public", fetcher: "plugin" },
    ]);
    expect(calls.map((call) => call.url).sort()).toEqual([
      "https://article.cafe.naver.com/gw/v4/cafes/29424353/articles/528107",
      "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2300161320399228&locale=en_US",
      "https://www.threads.com/t/C-srcchPpp7/embed",
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs a structured error for a platform that is not public, without writing D1", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => {
      if (url.includes("naver.com")) {
        return new Response(NAVER_BODY);
      }
      return healthyFacebook(url) ?? (url.endsWith("/embed") ? html(unavailable) : html("", 500));
    });

    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toEqual({
      event: "health_check_failed",
      platform: "threads",
      fetcher: "embed",
      status: "login_required",
      httpStatus: 200,
      errorCode: "thread_not_available",
    });
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("posts all failures of one run to the Discord webhook in one message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stubFetch((url) => {
      if (url.startsWith("https://discord.example/")) {
        return new Response(null, { status: 204 });
      }
      return url.includes("naver.com") ? new Response("", { status: 500 }) : html(unavailable);
    });

    await runHealthChecks(TWO_PLATFORMS, { ...env, HEALTH_WEBHOOK_URL: "https://discord.example/webhook" });

    const posts = calls.filter((call) => call.url === "https://discord.example/webhook");
    expect(posts).toHaveLength(1);
    expect(posts[0].init?.method).toBe("POST");
    const body = JSON.parse(String(posts[0].init?.body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain("ebfix 健康檢查失敗");
    expect(body.content).toContain("**naver**：transient");
    expect(body.content).toContain("**threads**：login_required（fetcher embed，HTTP 200，thread_not_available）");
  });

  it("does not post when everything is public or no webhook is set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = stubFetch((url) => (url.includes("naver.com") ? new Response(NAVER_BODY) : html(text)));
    await runHealthChecks(TWO_PLATFORMS, { ...env, HEALTH_WEBHOOK_URL: "https://discord.example/webhook" });
    expect(healthy.some((call) => call.url.startsWith("https://discord.example/"))).toBe(false);

    const failing = stubFetch(() => html(unavailable));
    await runHealthChecks(TWO_PLATFORMS, env);
    expect(failing.some((call) => call.init?.method === "POST")).toBe(false);
  });

  it("announces a platform once per outage and stays quiet when it recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooked = { ...env, HEALTH_WEBHOOK_URL: "https://discord.example/webhook" };
    let naverUp = true;
    let threadsUp = false;
    const calls = stubFetch((url) => {
      if (url.startsWith("https://discord.example/")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("naver.com")) {
        return naverUp ? new Response(NAVER_BODY) : new Response("", { status: 500 });
      }
      return html(threadsUp ? text : unavailable);
    });
    const posted = () =>
      calls.filter((call) => call.url.startsWith("https://discord.example/")).map((call) => JSON.parse(String(call.init?.body)).content as string);

    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toContain("**threads**");

    // 還沒修好：不再通知。
    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posted()).toHaveLength(1);

    // 修好了：只改回 ok，不送訊息。
    threadsUp = true;
    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posted()).toHaveLength(1);
    const state = await env.DB.prepare("SELECT key, value FROM health_state ORDER BY key").all();
    expect(state.results).toEqual([
      { key: "platform:naver", value: "ok" },
      { key: "platform:threads", value: "ok" },
    ]);

    // 兩個一起壞：合成一則。
    naverUp = false;
    threadsUp = false;
    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posted()).toHaveLength(2);
    expect(posted()[1]).toContain("**naver**");
    expect(posted()[1]).toContain("**threads**");

    // 只有 threads 恢復後又壞：訊息只列 threads。
    threadsUp = true;
    await runHealthChecks(TWO_PLATFORMS, hooked);
    threadsUp = false;
    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posted()).toHaveLength(3);
    expect(posted()[2]).toContain("**threads**");
    expect(posted()[2]).not.toContain("**naver**");
  });

  it("retries next run when the webhook could not be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooked = { ...env, HEALTH_WEBHOOK_URL: "https://discord.example/webhook" };
    let webhookStatus = 500;
    const calls = stubFetch((url) =>
      url.startsWith("https://discord.example/") ? new Response(null, { status: webhookStatus }) : html(unavailable),
    );
    const posts = () => calls.filter((call) => call.url.startsWith("https://discord.example/")).length;

    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posts()).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM health_state WHERE value = 'failing'").first("count")).toBe(0);

    webhookStatus = 204;
    await runHealthChecks(TWO_PLATFORMS, hooked);
    await runHealthChecks(TWO_PLATFORMS, hooked);
    expect(posts()).toBe(2);
  });

  it("logs a failed webhook without the URL and without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => (url.startsWith("https://discord.example/") ? new Response("", { status: 404 }) : html(unavailable)));

    await expect(
      runHealthChecks(TWO_PLATFORMS, { ...env, HEALTH_WEBHOOK_URL: "https://discord.example/secret-token" }),
    ).resolves.toHaveLength(2);

    const logs = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logs).toContain(JSON.stringify({ event: "health_webhook_failed", httpStatus: 404 }));
    expect(logs.join("\n")).not.toContain("secret-token");
  });
});
