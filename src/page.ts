/**
 * Builds the single HTML document served for both Discord's link unfurler and
 * regular visitors: Open Graph metadata in the raw HTML plus a plain reading
 * page. All upstream values are escaped here; no upstream markup is rendered.
 */

import type { StoredContent } from "./db";

export interface PageOptions {
  canonicalUrl: string;
  originalUrl: string | null;
  siteName: string;
  title: string;
  description: string;
  author?: string;
  image?: string;
  body: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `body{margin:0 auto;padding:1.5rem;max-width:44rem;font:16px/1.7 system-ui,sans-serif;color:#222}
h1{font-size:1.4rem;line-height:1.35}
.meta{color:#666;font-size:.9rem}
img{max-width:100%;height:auto;display:block;margin:0 0 1rem}`;

function renderDocument(options: PageOptions): string {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(options.title)}">`,
    `<meta property="og:description" content="${escapeHtml(options.description)}">`,
    `<meta property="og:site_name" content="${escapeHtml(options.siteName)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escapeHtml(options.canonicalUrl)}">`,
    options.image ? `<meta property="og:image" content="${escapeHtml(options.image)}">` : "",
    `<meta name="twitter:card" content="${options.image ? "summary_large_image" : "summary"}">`,
    options.author ? `<meta name="author" content="${escapeHtml(options.author)}">` : "",
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${tags.join("\n")}
<style>${STYLE}</style>
</head>
<body>
${options.body}
</body>
</html>`;
}

/** Description format shared by every article page: author first, then text. */
export function articleDescription(content: StoredContent): string {
  const parts = [content.author, content.cafeName].filter(Boolean);
  const prefix = parts.length > 0 ? `${parts.join(" · ")} — ` : "";
  return `${prefix}${content.text}`;
}

function renderText(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function renderArticlePage(options: {
  canonicalUrl: string;
  originalUrl: string | null;
  content: StoredContent;
}): string {
  const { content } = options;
  const metaLine = [content.author, content.cafeName, content.writtenAt?.slice(0, 10)]
    .filter(Boolean)
    .map((value) => escapeHtml(String(value)))
    .join(" · ");
  const images = content.images
    .map((src) => `<img src="${escapeHtml(src)}" alt="">`)
    .join("\n");
  const original = options.originalUrl
    ? `<p><a href="${escapeHtml(options.originalUrl)}">前往 Naver 原文</a></p>`
    : "";

  const body = `<h1>${escapeHtml(content.title)}</h1>
${metaLine ? `<p class="meta">${metaLine}</p>` : ""}
${renderText(content.text)}
${images}
${original}`;

  return renderDocument({
    canonicalUrl: options.canonicalUrl,
    originalUrl: options.originalUrl,
    siteName: content.cafeName || "Naver Cafe",
    title: content.title,
    description: articleDescription(content),
    author: content.author || undefined,
    image: content.images[0],
    body,
  });
}

export function renderStatusPage(options: {
  canonicalUrl: string;
  originalUrl: string | null;
  siteName: string;
  title: string;
  description: string;
}): string {
  const original = options.originalUrl
    ? `<p><a href="${escapeHtml(options.originalUrl)}">前往 Naver 原文</a></p>`
    : "";
  const body = `<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.description)}</p>
${original}`;

  return renderDocument({
    ...options,
    body,
  });
}
