import { describe, expect, it } from "vitest";
import { PAYLOAD_LIMIT, renderPostPage } from "../../src/core/page";
import type { NormalizedPost, Provider } from "../../src/core/types";

const provider = { id: "test", siteName: "Test", lang: "zh-Hant", originalLinkText: "前往原文" } as Provider;

/** A signed CDN URL about as long as the ones Facebook and Instagram return. */
function cdnUrl(index: number, length = 600): string {
  const prefix = `https://cdn.example/${index}_n.jpg?sig=`;
  return prefix + "x".repeat(length - prefix.length);
}

function post(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    title: "標題",
    siteName: "Test",
    author: { name: "作者", handle: "author", avatar: cdnUrl(99), url: "https://example.com/author" },
    text: "短內文",
    media: [],
    createdAt: "2026-10-01T00:00:00Z",
    stats: { likes: "1.2K" },
    ...overrides,
  };
}

function render(value: NormalizedPost): { bytes: number; components: Array<Record<string, any>> } {
  const html = renderPostPage({ provider, canonicalUrl: "https://proxy.example/p/1", originalUrl: "https://example.com/p/1", post: value });
  const script = html.match(/<script id="discord:component-embed" type="application\/json">([^<]*)<\/script>/)![1];
  return { bytes: new TextEncoder().encode(script).length, components: JSON.parse(script).component.components };
}

function textOf(components: Array<Record<string, any>>): string {
  const first = components[0];
  return first.type === 9 ? first.components[0].content : first.content;
}

describe("component embed size", () => {
  it("leaves a payload under the limit untouched", () => {
    const { bytes, components } = render(post({ media: [{ kind: "image", url: cdnUrl(1) }] }));

    expect(bytes).toBeLessThanOrEqual(PAYLOAD_LIMIT);
    expect(components[0].type).toBe(9);
    expect(textOf(components)).toBe("## 標題\n-# 作者 (\\@author) · Test\n\n短內文");
    expect(components[1].items).toHaveLength(1);
    expect(components.at(-1)?.components).toHaveLength(2);
  });

  it("cuts long CJK text by bytes and ends it with an ellipsis", () => {
    const { bytes, components } = render(post({ text: "測".repeat(3000) }));
    const text = textOf(components);

    expect(bytes).toBeLessThanOrEqual(PAYLOAD_LIMIT);
    expect(bytes).toBeGreaterThan(PAYLOAD_LIMIT - 10);
    expect(text.endsWith("測…")).toBe(true);
  });

  it("drops gallery items from the end before the text gets too short", () => {
    const media = Array.from({ length: 10 }, (_, i) => ({ kind: "image" as const, url: cdnUrl(i) }));
    const { bytes, components } = render(post({ text: "測".repeat(1000), media }));
    const gallery = components.find((part) => part.type === 12);

    expect(bytes).toBeLessThanOrEqual(PAYLOAD_LIMIT);
    expect(gallery?.items.length).toBeGreaterThanOrEqual(1);
    expect(gallery?.items.length).toBeLessThan(10);
    expect(gallery?.items[0].media.url).toBe(cdnUrl(0));
    expect(textOf(components).length).toBeGreaterThanOrEqual(200);
  });

  it("keeps a short text whole and drops the avatar once one gallery item is left", () => {
    const media = [{ kind: "image" as const, url: cdnUrl(1, 2000) }];
    const { bytes, components } = render(post({ media, author: { name: "作者", handle: "author", avatar: cdnUrl(2, 1000) } }));

    expect(bytes).toBeLessThanOrEqual(PAYLOAD_LIMIT);
    expect(components[0].type).toBe(10);
    expect(textOf(components).endsWith("短內文")).toBe(true);
    expect(components.find((part) => part.type === 12)?.items).toHaveLength(1);
  });

  it("leaves out media URLs longer than Discord accepts", () => {
    const { components } = render(post({
      media: [{ kind: "image", url: cdnUrl(1, 2049) }, { kind: "image", url: cdnUrl(2) }],
      author: { name: "作者", avatar: cdnUrl(3, 2049) },
    }));

    expect(components[0].type).toBe(10);
    expect(components.find((part) => part.type === 12)?.items).toEqual([{ media: { url: cdnUrl(2) } }]);
  });
});
