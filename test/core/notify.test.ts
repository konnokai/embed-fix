import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announceDeploy } from "../../src/core/notify";
import { resetDatabase } from "../helpers";
import { stubFetch } from "../providers/threads/stub";

function deployed(id: string): Env {
  return {
    ...env,
    HEALTH_WEBHOOK_URL: "https://discord.example/webhook",
    CF_VERSION_METADATA: { id, tag: "", timestamp: "2026-10-03T14:00:00.000Z" },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("deploy announcement", () => {
  it("announces each version once, even when isolates start together", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await Promise.all([announceDeploy(deployed("aaaaaaaa-1111")), announceDeploy(deployed("aaaaaaaa-1111"))]);
    await announceDeploy(deployed("aaaaaaaa-1111"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init?.body)).content).toBe(
      "✅ ebfix 已部署 `aaaaaaaa`\n版本建立於 <t:1791036000:f>",
    );

    await announceDeploy(deployed("bbbbbbbb-2222"));
    expect(calls).toHaveLength(2);
  });

  it("does nothing without a webhook, and does not use up the version", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await announceDeploy({ ...deployed("cccccccc-3333"), HEALTH_WEBHOOK_URL: undefined });
    expect(calls).toHaveLength(0);

    await announceDeploy(deployed("cccccccc-3333"));
    expect(calls).toHaveLength(1);
  });

  it("does not throw when the webhook fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("network down");
    });

    await expect(announceDeploy(deployed("dddddddd-4444"))).resolves.toBeUndefined();
  });
});
