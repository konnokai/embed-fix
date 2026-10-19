/**
 * Small helpers for reading upstream HTML with HTMLRewriter, which hands out
 * text and attribute values with entities still encoded.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  middot: "\u00b7",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
};

function fromCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/**
 * Decodes the entities HTMLRewriter leaves in place. Unknown names and
 * out-of-range code points are kept verbatim rather than dropped.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return fromCodePoint(code, match);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function hasClass(element: Element, className: string): boolean {
  const value = element.getAttribute("class");
  return value !== null && value.split(/\s+/).includes(className);
}

/** Counts how deeply the parser currently sits inside matching elements. */
export function track(element: Element, counter: { depth: number }): void {
  counter.depth += 1;
  element.onEndTag(() => {
    counter.depth -= 1;
  });
}

/**
 * Reads `og:*` and `twitter:*` meta tags and the canonical link from a page
 * head. `extra` adds handlers that run in the same pass over the page.
 */
export async function readMeta(
  response: Response,
  extra?: (rewriter: HTMLRewriter) => HTMLRewriter,
): Promise<Map<string, string>> {
  const meta = new Map<string, string>();
  const base = new HTMLRewriter()
    .on("meta", {
      element(element) {
        const name = element.getAttribute("property") ?? element.getAttribute("name");
        const content = element.getAttribute("content");
        if (name && /^(?:og|twitter):/.test(name) && content !== null && !meta.has(name)) {
          // HTMLRewriter 不像瀏覽器會把 CRLF 正規化，內文的換行要自己統一成 \n。
          meta.set(name, decodeEntities(content).replace(/\r\n?/g, "\n"));
        }
      },
    })
    .on("link[rel=canonical]", {
      element(element) {
        const href = element.getAttribute("href");
        if (href !== null && !meta.has("canonical")) {
          meta.set("canonical", decodeEntities(href));
        }
      },
    });
  const rewriter = extra ? extra(base) : base;
  await rewriter.transform(response).arrayBuffer();
  return meta;
}
