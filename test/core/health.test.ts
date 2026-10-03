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

const NAVER_BODY = JSON.stringify({
  result: {
    article: { subject: "제목", contentHtml: "<p>본문</p>", writer: { nick: "작성자" } },
    cafe: { name: "카페" },
  },
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("health check", () => {
  it("checks one fixed sample per platform and logs nothing when all are public", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stubFetch((url) => (url.includes("naver.com") ? new Response(NAVER_BODY) : html(text)));

    const results = await runHealthChecks(PROVIDERS, env);

    expect(results).toEqual([
      { platform: "naver", status: "public", fetcher: "api" },
      { platform: "threads", status: "public", fetcher: "embed" },
    ]);
    expect(calls.map((call) => call.url).sort()).toEqual([
      "https://article.cafe.naver.com/gw/v4/cafes/29424353/articles/528107",
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
      return url.endsWith("/embed") ? html(unavailable) : html("", 500);
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
});
