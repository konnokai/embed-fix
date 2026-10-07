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

/**
 * Discord's limit for the serialized payload, in UTF-8 bytes; escape sequences
 * such as `<` count at their full length.
 */
export const PAYLOAD_LIMIT = 3000;

/** Discord rejects media URLs longer than this. */
const MEDIA_URL_LIMIT = 2048;

/** Gallery items, the avatar and the profile button give way before the text drops below this many characters. */
const MIN_TEXT_LENGTH = 200;

interface LinkButton {
  label: string;
  url: string;
}

export function serializeComponentEmbed(embed: object): string {
  return JSON.stringify(embed).replace(/</g, "\\u003c");
}

function payloadBytes(embed: object): number {
  return new TextEncoder().encode(serializeComponentEmbed(embed)).length;
}

/** `content` cut to `length` characters with an ellipsis, without leaving a dangling escape or half a surrogate pair. */
function cutContent(content: string, length: number): string {
  if (length >= content.length) {
    return content;
  }
  let cut = content.slice(0, length).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  if (cut.endsWith("\\")) cut = cut.slice(0, -1);
  return `${cut}…`;
}

interface EmbedParts {
  thumbnail?: string;
  media: MediaItem[];
  footer?: string;
  buttons: LinkButton[];
}

function assembleComponentEmbed(content: string, parts: EmbedParts): object {
  const textDisplay = { type: 10, content };
  const components: object[] = [
    parts.thumbnail
      ? { type: 9, components: [textDisplay], accessory: { type: 11, media: { url: parts.thumbnail } } }
      : textDisplay,
  ];

  if (parts.media.length > 0) {
    components.push({ type: 12, items: parts.media.map((item) => ({ media: { url: item.url } })) });
  }
  if (parts.footer) {
    components.push({ type: 14, divider: true, spacing: 1 }, { type: 10, content: parts.footer });
  }
  if (parts.buttons.length > 0) {
    components.push({
      type: 1,
      components: parts.buttons.map((button) => ({ type: 2, style: 5, label: button.label, url: button.url })),
    });
  }

  return { component: { type: 17, components } };
}

/** The longest cut of `content` whose payload fits `PAYLOAD_LIMIT`, and how many characters it kept. */
function fitContent(content: string, parts: EmbedParts): { embed: object; kept: number } {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (payloadBytes(assembleComponentEmbed(cutContent(content, mid), parts)) <= PAYLOAD_LIMIT) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { embed: assembleComponentEmbed(cutContent(content, low), parts), kept: low };
}

/** Drops the least important part that still remains; false when nothing is left to drop. */
function dropOnePart(parts: EmbedParts): boolean {
  if (parts.media.length > 1) {
    parts.media = parts.media.slice(0, -1);
  } else if (parts.thumbnail) {
    parts.thumbnail = undefined;
  } else if (parts.buttons.length > 1) {
    parts.buttons = parts.buttons.slice(0, 1);
  } else if (parts.media.length > 0) {
    parts.media = [];
  } else {
    return false;
  }
  return true;
}

/**
 * Builds Discord's single-container link preview:
 *
 * - header and text, in a Section with the author's avatar as thumbnail when there is one;
 * - a Media Gallery (at most 10 items);
 * - a divider and a footer line (counters, time) when there is one;
 * - link buttons (original post, author profile).
 *
 * The payload must fit `PAYLOAD_LIMIT`, which signed CDN URLs (500–1000 bytes
 * each) and CJK text (3 bytes a character) reach quickly. The text is cut
 * first; once less than `MIN_TEXT_LENGTH` characters of it would remain,
 * gallery items from the end, the avatar, the profile button and the last
 * gallery item go one at a time instead.
 */
function renderComponentEmbed(options: {
  /** First line, already in Discord markdown. */
  heading: string;
  details?: string;
  /** Lines placed before the text, already in Discord markdown. */
  lead?: string;
  text: string;
  /** Lines placed after the text, already in Discord markdown. */
  trail?: string;
  thumbnail?: string;
  media?: MediaItem[];
  /** Already in Discord markdown. */
  footer?: string;
  buttons: LinkButton[];
}): object {
  const details = options.details ? `\n-# ${plain(options.details)}` : "";
  const lead = options.lead ? `\n\n${options.lead}` : "";
  const trail = options.trail ? `\n\n${options.trail}` : "";
  const head = `${options.heading}${details}`;
  const content = `${head}${lead}\n\n${plain(options.text)}${trail}`;
  const usable = (url: string) => url.length <= MEDIA_URL_LIMIT;
  const parts: EmbedParts = {
    thumbnail: options.thumbnail && usable(options.thumbnail) ? options.thumbnail : undefined,
    media: (options.media ?? []).filter((item) => usable(item.url)).slice(0, 10),
    footer: options.footer,
    buttons: options.buttons.slice(0, 5).map((button) => ({ label: button.label.slice(0, 80), url: button.url })),
  };
  const enough = Math.min(content.length, head.length + MIN_TEXT_LENGTH);

  for (;;) {
    const fitted = fitContent(content, parts);
    if (fitted.kept >= enough || !dropOnePart(parts)) {
      return fitted.embed;
    }
  }
}

function originalButtons(originalUrl: string | null): LinkButton[] {
  return originalUrl ? [{ label: "原貼文", url: originalUrl }] : [];
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
<script id="discord:component-embed" type="application/json">${serializeComponentEmbed(options.componentEmbed)}</script>
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

/** "Threads › 明日方舟": the site, followed by the post's topic tag when it has one. */
function siteLabel(post: NormalizedPost): string {
  return [post.siteName, post.topic].filter(Boolean).join(" › ");
}

/** Description format shared by every post page: author first, then text. */
export function postDescription(post: NormalizedPost): string {
  const parts = [authorLabel(post.author), siteLabel(post)].filter(Boolean);
  const prefix = parts.length > 0 ? `${parts.join(" · ")} — ` : "";
  return `${prefix}${post.text}`;
}

/**
 * Author, site and (optionally) date under the title. A value equal to the
 * title is left out, since providers without a post title use the author as
 * the title.
 */
function detailParts(post: NormalizedPost, withDate: boolean): string[] {
  return [authorLabel(post.author), siteLabel(post), withDate ? post.createdAt?.slice(0, 10) : undefined].filter(
    (value): value is string => Boolean(value) && value !== post.title,
  );
}

/** Counters and the creation time as a Discord timestamp, which every viewer sees in their own time zone. */
function footerLine(post: NormalizedPost): string | undefined {
  const parts: string[] = [];
  if (post.stats?.likes) parts.push(`❤️ ${plain(post.stats.likes)}`);
  if (post.stats?.replies) parts.push(`💬 ${plain(post.stats.replies)}`);
  if (post.stats?.reposts) parts.push(`🔁 ${plain(post.stats.reposts)}`);
  const time = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
  if (Number.isFinite(time)) {
    parts.push(`<t:${Math.floor(time / 1000)}:f>`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The title as a heading. It is never a masked link: Discord shows backslash
 * escapes literally inside link text (`\@a\_b`), and unescaped handles can turn
 * into italics. The author profile has its own button instead.
 */
function postHeading(post: NormalizedPost): string {
  return `## ${plain(post.title)}`;
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
  const metaLine = detailParts(post, true).map(escapeHtml).join(" · ");
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
      heading: postHeading(post),
      // 時間放在底部的 Discord 時間戳，這裡就不重複日期。
      details: detailParts(post, !footerLine(post)?.includes("<t:")).join(" · "),
      lead,
      text: post.text,
      trail,
      thumbnail: post.author.avatar,
      media: post.media,
      footer: footerLine(post),
      buttons: [
        ...originalButtons(options.originalUrl),
        ...(post.author.url && post.author.handle ? [{ label: `@${post.author.handle}`, url: post.author.url }] : []),
      ],
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
      heading: `## ${plain(options.title)}`,
      text: options.description,
      buttons: originalButtons(options.originalUrl),
    }),
  });
}
