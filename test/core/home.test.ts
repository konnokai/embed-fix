import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealthChecks } from "../../src/core/health";
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

const TWO_PLATFORMS = PROVIDERS.filter((provider) => provider.id === "naver" || provider.id === "threads");

function get(host: string, path = "/", init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://${host}${path}`, init);
}

/** The status list rendered as "Platform: state" lines. */
function statusLines(page: string): string[] {
  const list = page.match(/<ul class="status">([\s\S]*?)<\/ul>/);
  expect(list).not.toBeNull();
  return [...list![1].matchAll(/<li><span>([^<]+)<\/span><span>(.*?)<\/span><\/li>/g)].map(
    ([, name, state]) => `${name}: ${state.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}`,
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("home page", () => {
  it("is served at / on every ebfix domain without calling upstream", async () => {
    const calls = stubFetch(() => html(""));

    for (const host of ["ebfix.konnokai.me", "fb.ebfix.konnokai.me", "ig.ebfix.konnokai.me"]) {
      const response = await get(host, "/?utm_source=x");
      const page = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      const csp = response.headers.get("content-security-policy");
      expect(csp).toContain("default-src 'none'");
      // Cloudflare 在代理的網域上自動插入的 Web Analytics 和 Zaraz。
      expect(csp).toContain("script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com");
      expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com");
      expect(page).toContain('<meta property="og:site_name" content="ebfix">');
      expect(page).toContain(`<meta property="og:url" content="https://${host}/">`);
      expect(page).toContain('id="source"');
      expect(page).not.toContain("http-equiv=\"refresh\"");
    }
    expect(calls).toHaveLength(0);
  });

  it("tells mobile Discord users to update the app", async () => {
    const page = await (await get("ebfix.konnokai.me")).text();

    expect(page).toContain('id="app-update"');
    expect(page).toContain("手機版 Discord");
    expect(page).toContain("更新");
  });

  it("keeps / on the legacy Naver domain a 400", async () => {
    const response = await get("cafe.konnokai.me");

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('href="https://ebfix.konnokai.me/"');
  });

  it("answers HEAD without a body", async () => {
    const response = await get("ebfix.konnokai.me", "/", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("shows every platform as not checked yet before the first health check", async () => {
    const page = await (await get("ebfix.konnokai.me")).text();

    expect(statusLines(page)).toEqual([
      "Threads: 尚未檢查",
      "Facebook: 尚未檢查",
      "Instagram: 尚未檢查",
      "Naver Cafe: 尚未檢查",
    ]);
    expect(page).toContain("還沒有檢查紀錄。");
  });

  it("shows the result of the last health check, even when no webhook was notified", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) => (url.includes("naver.com") ? new Response(NAVER_BODY) : html(unavailable)));
    await runHealthChecks(TWO_PLATFORMS, env);

    const page = await (await get("ebfix.konnokai.me")).text();
    const lines = statusLines(page);

    expect(lines[0]).toMatch(/^Threads: ● 異常 （\d{2}\/\d{2} \d{2}:\d{2} 起）$/);
    expect(lines.slice(1)).toEqual(["Facebook: 尚未檢查", "Instagram: 尚未檢查", "Naver Cafe: ● 正常"]);
    expect(page).toMatch(/最後檢查：<time datetime="[^"]+">\d{2}\/\d{2} \d{2}:\d{2}<\/time>。</);
    expect(page).not.toContain("狀態可能不準");

    // 恢復後顯示正常。
    stubFetch((url) => (url.includes("naver.com") ? new Response(NAVER_BODY) : html(text)));
    await runHealthChecks(TWO_PLATFORMS, env);
    expect(statusLines(await (await get("ebfix.konnokai.me")).text())[0]).toBe("Threads: ● 正常");
  });

  it("warns when the last check is more than two hours old", async () => {
    await env.DB.prepare("INSERT INTO health_state (key, value, updated_at) VALUES ('check:last', '0', ?)")
      .bind(Date.now() - 3 * 60 * 60 * 1000)
      .run();

    expect(await (await get("ebfix.konnokai.me")).text()).toContain("已超過兩小時沒有檢查，狀態可能不準。");
  });
});

describe("unsupported paths", () => {
  it("answer 400 with a link to the home page", async () => {
    const response = await get("ebfix.konnokai.me", "/nothing/here");
    const page = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(page).toContain("<h1>不支援的網址格式</h1>");
    expect(page).toContain('href="https://ebfix.konnokai.me/"');
  });
});
