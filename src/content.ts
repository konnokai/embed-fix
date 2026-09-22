/**
 * Turns Naver's `contentHtml` into the plain text and image list the service
 * stores and renders. The upstream HTML is never passed through: only text
 * nodes and image `src` values are read.
 */

export interface ParsedContent {
  text: string;
  images: string[];
}

/** Elements that end a visual line or paragraph in Naver's editor output. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "blockquote",
  "pre",
  "br",
  "hr",
]);

/** Elements whose subtree never becomes article text. */
const VOID_TAGS = new Set(["img", "br", "hr", "meta", "link", "input", "source", "col", "wbr"]);

const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;
const INLINE_SPACE = /[ \t\f\v]+/g;
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

function hasClass(element: Element, className: string): boolean {
  const value = element.getAttribute("class");
  return value !== null && value.split(/\s+/).includes(className);
}

function fromCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/**
 * Decodes the entities HTMLRewriter leaves in place. Unknown names and
 * out-of-range code points are kept verbatim rather than dropped.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return fromCodePoint(code, match);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function cleanText(raw: string): string {
  return decodeEntities(raw)
    .replace(ZERO_WIDTH, "")
    .replace(/\u00a0/g, " ")
    .replace(INLINE_SPACE, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts text and content images in document order.
 *
 * Stickers (`.se-sticker`, `img.se-sticker-image`) and script/style subtrees
 * are removed and their text is skipped through `depth`, because
 * `element.remove()` alone still lets the removed subtree's text callbacks
 * fire. Only `img.se-image-resource` counts as a content image, so sticker or
 * interface images never reach the output.
 */
export async function parseContentHtml(html: string): Promise<ParsedContent> {
  const chunks: string[] = [];
  const images: string[] = [];
  const removed: string[] = [];

  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName;
      if (tag === "script" || tag === "style" || hasClass(element, "se-sticker")) {
        if (!VOID_TAGS.has(tag)) {
          removed.push(tag);
          element.onEndTag(() => {
            removed.pop();
          });
        }
        element.remove();
        return;
      }
      if (tag === "img") {
        if (hasClass(element, "se-sticker-image")) {
          element.remove();
          return;
        }
        const src = element.getAttribute("src");
        if (src && /^https?:\/\//.test(src) && hasClass(element, "se-image-resource")) {
          images.push(decodeEntities(src));
        }
        return;
      }
      if (tag === "br") {
        chunks.push("\n");
        return;
      }
      if (BLOCK_TAGS.has(tag)) {
        element.onEndTag(() => {
          chunks.push("\n\n");
        });
      }
    },
    text(chunk) {
      if (removed.length === 0) {
        chunks.push(chunk.text);
      }
    },
  });

  await rewriter.transform(new Response(html)).text();

  return { text: cleanText(chunks.join("")), images: [...new Set(images)] };
}
