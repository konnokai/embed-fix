/**
 * Builds the single HTML document served for both Discord's link unfurler and
 * regular visitors: Open Graph metadata in the raw HTML plus a plain reading
 * page. All upstream values are escaped here; no upstream markup is rendered.
 * Discord also reads a Components V2 payload from a JSON script tag; OG tags
 * remain available to other link-preview clients.
 *
 * Visitors are sent on to the original post with a `meta refresh`, not an HTTP
 * redirect: unfurlers follow HTTP redirects and would end up fetching the
 * platform itself, which is the request the preview exists to replace. The
 * refresh is a client-side hint that unfurlers ignore, so the metadata stays
 * reachable and the in-page link remains for clients that disable it.
 */

import type { MediaItem, NormalizedPost, Provider } from "./types";

export const SERVICE_NAME = "ebfix";

/** Discord shows at most this much of a reply's parent post. */
const REPLY_EXCERPT_LENGTH = 200;

interface DocumentOptions {
  lang: string;
  canonicalUrl: string;
  originalUrl: string | null;
  siteName: string;
  title: string;
  description: string;
  author?: string;
  image?: string;
  video?: string;
  body: string;
  componentEmbed: object;
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

/** Upstream text is plain text, not Discord markdown; keep it from creating formatting, links or mentions. */
function plain(value: string): string {
  return value.replace(/([\\*_~`|>#[\]@])/g, "\\$1");
}

/** Builds Discord's single-container link preview, including the original-post link when available. */
function renderComponentEmbed(options: {
  title: string;
  details?: string;
  /** Lines placed before the text, already in Discord markdown. */
  lead?: string;
  text: string;
  /** Lines placed after the text, already in Discord markdown. */
  trail?: string;
  media?: MediaItem[];
  originalUrl: string | null;
}): object {
  const heading = `## ${plain(options.title)}`;
  const details = options.details ? `\n-# ${plain(options.details)}` : "";
  const lead = options.lead ? `\n\n${options.lead}` : "";
  const trail = options.trail ? `\n\n${options.trail}` : "";
  const content = `${heading}${details}${lead}\n\n${plain(options.text)}${trail}`;
  // Discord limits the combined Text Display content to 4000 characters.
  const trimmed = content.slice(0, 4000);
  const safeText = trimmed.endsWith("\\") ? trimmed.slice(0, -1) : trimmed;
  const components: object[] = [{ type: 10, content: safeText }];

  if (options.media?.length) {
    components.push({
      type: 12,
      items: options.media.slice(0, 10).map((item) => ({ media: { url: item.url } })),
    });
  }
  if (options.originalUrl) {
    components.push({
      type: 1,
      components: [{ type: 2, style: 5, label: "原貼文", url: options.originalUrl }],
    });
  }

  return { component: { type: 17, components } };
}

function renderDocument(options: DocumentOptions): string {
  // Threads serves MP4 without a type attribute; the tag set follows fixthreads' renderSeo.
  const videoTags = options.video
    ? [
        `<meta property="og:video" content="${escapeHtml(options.video)}">`,
        `<meta property="og:video:secure_url" content="${escapeHtml(options.video)}">`,
        `<meta property="og:video:type" content="video/mp4">`,
        `<meta name="twitter:player:stream" content="${escapeHtml(options.video)}">`,
        `<meta name="twitter:player:stream:content_type" content="video/mp4">`,
      ]
    : [];
  const twitterCard = options.video ? "player" : options.image ? "summary_large_image" : "summary";
  const tags = [
    `<meta property="og:title" content="${escapeHtml(options.title)}">`,
    `<meta property="og:description" content="${escapeHtml(options.description)}">`,
    `<meta property="og:site_name" content="${escapeHtml(options.siteName)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escapeHtml(options.canonicalUrl)}">`,
    options.image ? `<meta property="og:image" content="${escapeHtml(options.image)}">` : "",
    ...videoTags,
    `<meta name="twitter:card" content="${twitterCard}">`,
    options.author ? `<meta name="author" content="${escapeHtml(options.author)}">` : "",
    options.originalUrl
      ? `<meta http-equiv="refresh" content="0; url=${escapeHtml(options.originalUrl)}">`
      : "",
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(options.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${tags.join("\n")}
<script id="discord:component-embed" type="application/json">${JSON.stringify(options.componentEmbed).replace(/</g, "\\u003c")}</script>
<style>${STYLE}</style>
</head>
<body>
${options.body}
</body>
</html>`;
}

/** "Name (@handle)", "@handle" or "Name", whichever the post carries. */
export function authorLabel(author: NormalizedPost["author"]): string {
  if (author.handle) {
    return author.name && author.name !== author.handle ? `${author.name} (@${author.handle})` : `@${author.handle}`;
  }
  return author.name;
}

/** Description format shared by every post page: author first, then text. */
export function postDescription(post: NormalizedPost): string {
  const parts = [authorLabel(post.author), post.siteName].filter(Boolean);
  const prefix = parts.length > 0 ? `${parts.join(" · ")} — ` : "";
  return `${prefix}${post.text}`;
}

/**
 * Author, site and date under the title. A value equal to the title is left
 * out, since providers without a post title use the author as the title.
 */
function detailParts(post: NormalizedPost): string[] {
  return [authorLabel(post.author), post.siteName, post.createdAt?.slice(0, 10)].filter(
    (value): value is string => Boolean(value) && value !== post.title,
  );
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

function renderMedia(media: MediaItem[]): string {
  return media
    .map((item) =>
      item.kind === "video"
        ? `<video src="${escapeHtml(item.url)}" controls></video>`
        : `<img src="${escapeHtml(item.url)}" alt="">`,
    )
    .join("\n");
}

function excerpt(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}\u2026` : text;
}

export function renderPostPage(options: {
  provider: Provider;
  canonicalUrl: string;
  originalUrl: string | null;
  post: NormalizedPost;
}): string {
  const { post, provider } = options;
  const details = detailParts(post);
  const metaLine = details.map(escapeHtml).join(" · ");
  const original = options.originalUrl
    ? `<p><a href="${escapeHtml(options.originalUrl)}">${escapeHtml(provider.originalLinkText)}</a></p>`
    : "";
  const replyHtml = post.replyTo
    ? `<blockquote><p class="meta">回覆 @${escapeHtml(post.replyTo.handle)}</p>${renderText(excerpt(post.replyTo.text, REPLY_EXCERPT_LENGTH))}</blockquote>`
    : "";
  const quotedHtml = post.quoted
    ? `<blockquote><p class="meta">引用 @${escapeHtml(post.quoted.handle)} 的貼文</p>${renderText(post.quoted.text)}${renderMedia(post.quoted.media)}</blockquote>`
    : "";

  const body = [
    `<h1>${escapeHtml(post.title)}</h1>`,
    metaLine ? `<p class="meta">${metaLine}</p>` : "",
    ...(replyHtml ? [replyHtml] : []),
    renderText(post.text),
    renderMedia(post.media),
    ...(quotedHtml ? [quotedHtml] : []),
    original,
  ].join("\n");

  const lead = post.replyTo
    ? [`-# 回覆 \\@${plain(post.replyTo.handle)}`, ...excerpt(post.replyTo.text, REPLY_EXCERPT_LENGTH).split("\n").map((line) => `> ${plain(line)}`)].join("\n")
    : undefined;
  const trail = post.quoted
    ? [`-# 引用 \\@${plain(post.quoted.handle)} 的貼文`, ...(post.quoted.text ? post.quoted.text.split("\n").map((line) => `> ${plain(line)}`) : [])].join("\n")
    : undefined;

  return renderDocument({
    lang: provider.lang,
    canonicalUrl: options.canonicalUrl,
    originalUrl: options.originalUrl,
    siteName: post.siteName || provider.siteName,
    title: post.title,
    description: postDescription(post),
    author: authorLabel(post.author) || undefined,
    image: post.media.find((item) => item.kind === "image")?.url,
    video: post.media.find((item) => item.kind === "video")?.url,
    body,
    componentEmbed: renderComponentEmbed({
      title: post.title,
      details: details.join(" · "),
      lead,
      text: post.text,
      trail,
      media: post.media,
      originalUrl: options.originalUrl,
    }),
  });
}

export function renderStatusPage(options: {
  provider: Provider;
  canonicalUrl: string;
  originalUrl: string | null;
  title: string;
  description: string;
}): string {
  const original = options.originalUrl
    ? `<p><a href="${escapeHtml(options.originalUrl)}">${escapeHtml(options.provider.originalLinkText)}</a></p>`
    : "";
  const body = `<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.description)}</p>
${original}`;

  return renderDocument({
    lang: options.provider.lang,
    canonicalUrl: options.canonicalUrl,
    originalUrl: options.originalUrl,
    siteName: SERVICE_NAME,
    title: options.title,
    description: options.description,
    body,
    componentEmbed: renderComponentEmbed({
      title: options.title,
      text: options.description,
      originalUrl: options.originalUrl,
    }),
  });
}
