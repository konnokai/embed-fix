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
