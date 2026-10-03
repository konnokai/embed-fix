/**
 * Main Facebook fetcher: the embedded post plugin
 * `/plugins/post.php?href={post URL}&locale=en_US`, which answers without a
 * login from Cloudflare's network (checked 2026-10-03, colo SIN).
 *
 * Structure observed in the F0 fixtures (class names vary between post kinds,
 * so stable attributes are used where they exist):
 *
 * - The author's avatar is the first `img` with an `aria-label`; the label is
 *   the author's name. `[aria-label="Verified profile"]` marks a verified page.
 * - The comment button `a._29bd` links to the post on www.facebook.com
 *   (`/{user}/posts/{id}`, `/{user}/videos/{id}`); its first path segment is
 *   the author's profile.
 * - Text is `[data-testid="post_message"]` with one `<p>` per paragraph. The
 *   collapsed part is already in the HTML (`.text_exposed_show`); the
 *   `.text_exposed_hide` parts only hold "..." and the "See more" link.
 *   Outbound links go through `l.facebook.com/l.php?u=`.
 * - `abbr[data-utime]` is the creation time in Unix seconds; video posts have none.
 * - Counters are the text of `div[title="Like" | "Comment" | "Share"]`.
 * - Images are the remaining `img` elements on fbcdn content hosts. They are
 *   signed thumbnails (about 400px), so their size parameters cannot be changed.
 * - Video URLs exist only in script text, as JSON strings `"hd_src"` / `"sd_src"`.
 * - Removed, private and group posts (and URLs with a slug) all show
 *   "This Facebook post is no longer available".
 */

import { decodeEntities, hasClass } from "../../core/html";
import type { Fetcher, MediaItem, NormalizedPost, UpstreamResult } from "../../core/types";
import { FACEBOOK_ORIGIN, facebookGet, isFacebookUrl, isTransientStatus, parseUrl, postUrl } from "./http";

/** Discord shows at most 10 gallery items. */
const MAX_IMAGES = 10;

const UNAVAILABLE_TEXT = "This Facebook post is no longer available";

const CONTENT_HOST = /^(?:scontent|external)[a-z0-9.-]*\.fbcdn\.net$/;

const VIDEO_SOURCE = /"(hd_src|sd_src)":"((?:[^"\\]|\\.)*)"/g;

const STAT_TITLES: Record<string, keyof NonNullable<NormalizedPost["stats"]>> = {
  Like: "likes",
  Comment: "replies",
  Share: "shares",
};

/** First-segment names that are not profiles (`/watch/…`, `/story.php`, …). */
const NOT_PROFILES = new Set(["watch", "reel", "photo", "photo.php", "story.php", "permalink.php", "groups", "sharer"]);

export interface PluginPage {
  unavailable: boolean;
  author: string;
  avatar?: string;
  verified: boolean;
  /** www.facebook.com URL from the comment button. */
  postLink?: string;
  text: string;
  createdAt: string | null;
  images: string[];
  video?: string;
  stats: NonNullable<NormalizedPost["stats"]>;
}

function contentUrl(value: string | null): string | null {
  const url = value ? parseUrl(decodeEntities(value)) : null;
  return url && url.protocol === "https:" && CONTENT_HOST.test(url.hostname) ? url.href : null;
}

/** `l.facebook.com/l.php?u=…` → the target without Facebook's `fbclid`; null for other links. */
function outboundTarget(href: string): string | null {
  const url = parseUrl(decodeEntities(href));
  if (!url || url.hostname !== "l.facebook.com" || url.pathname !== "/l.php") {
    return null;
  }
  const target = parseUrl(url.searchParams.get("u") ?? "");
  if (!target || (target.protocol !== "https:" && target.protocol !== "http:")) {
    return null;
  }
  target.searchParams.delete("fbclid");
  return target.href;
}

function cleanText(chunks: string[]): string {
  return decodeEntities(chunks.join(""))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Counts how deeply the parser currently sits inside matching elements. */
function track(element: Element, counter: { depth: number }): void {
  counter.depth += 1;
  element.onEndTag(() => {
    counter.depth -= 1;
  });
}

/** Video URL from script text; HD first, as long as it is a plain https fbcdn URL. */
function videoFrom(script: string): string | undefined {
  const found: Record<string, string> = {};
  for (const match of script.matchAll(VIDEO_SOURCE)) {
    if (found[match[1]]) {
      continue;
    }
    try {
      const url = parseUrl(JSON.parse(`"${match[2]}"`) as string);
      if (url && url.protocol === "https:" && url.hostname.endsWith(".fbcdn.net")) {
        found[match[1]] = url.href;
      }
    } catch {
      // 跳脫字元不合法就當作沒有這個網址。
    }
  }
  return found.hd_src ?? found.sd_src;
}

export async function parsePluginPage(response: Response): Promise<PluginPage> {
  const page: PluginPage = { unavailable: false, author: "", verified: false, text: "", createdAt: null, images: [], stats: {} };
  const textChunks: string[] = [];
  const message = { depth: 0 };
  const hidden = { depth: 0 };
  const raw = { depth: 0 };
  let stat: { key: keyof PluginPage["stats"]; chunks: string[] } | null = null;
  let link: { target: string; chunks: string[] } | null = null;
  let script = "";
  let allText = "";

  const rewriter = new HTMLRewriter()
    .on("script", {
      text(chunk) {
        script += chunk.text;
        if (chunk.lastInTextNode) {
          page.video ??= script.includes("_src") ? videoFrom(script) : undefined;
          script = "";
        }
      },
    })
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (tag === "script" || tag === "style") {
          track(element, raw);
          return;
        }
        const label = element.getAttribute("aria-label");

        if (label === "Verified profile") {
          page.verified = true;
          return;
        }
        if (tag === "img") {
          const src = contentUrl(element.getAttribute("src"));
          if (!src) {
            return;
          }
          if (label !== null) {
            // 第一個有 aria-label 的內容圖是作者頭像，後面的（例如分享貼文的原作者）不算。
            if (!page.author) {
              page.author = decodeEntities(label).trim();
              page.avatar = src;
            }
          } else if (!page.images.includes(src)) {
            page.images.push(src);
          }
          return;
        }
        if (tag === "abbr" && page.createdAt === null) {
          const seconds = Number(element.getAttribute("data-utime"));
          if (Number.isInteger(seconds) && seconds > 0) {
            page.createdAt = new Date(seconds * 1000).toISOString();
          }
          return;
        }
        if (tag === "div" && stat === null) {
          const key = STAT_TITLES[element.getAttribute("title") ?? ""];
          if (key) {
            const current = { key, chunks: [] as string[] };
            stat = current;
            element.onEndTag(() => {
              const value = cleanText(current.chunks);
              if (value) {
                page.stats[current.key] = value;
              }
              stat = null;
            });
            return;
          }
        }
        if (tag === "a" && hasClass(element, "_29bd") && !page.postLink) {
          const href = parseUrl(decodeEntities(element.getAttribute("href") ?? ""), FACEBOOK_ORIGIN);
          if (href && isFacebookUrl(href) && !href.pathname.startsWith("/sharer")) {
            page.postLink = href.href;
          }
          return;
        }
        if (element.getAttribute("data-testid") === "post_message") {
          track(element, message);
          return;
        }
        if (message.depth === 0) {
          return;
        }
        if (hasClass(element, "text_exposed_hide")) {
          track(element, hidden);
          return;
        }
        if (hidden.depth > 0) {
          return;
        }
        if (tag === "p") {
          textChunks.push("\n\n");
        } else if (tag === "br") {
          textChunks.push("\n");
        } else if (tag === "a" && link === null) {
          const target = outboundTarget(element.getAttribute("href") ?? "");
          if (target) {
            const current = { target, chunks: [] as string[] };
            link = current;
            element.onEndTag(() => {
              // 連結文字本身是網址時（Facebook 會截短），換成真正的目的地；一般文字就照留。
              const shown = decodeEntities(current.chunks.join("")).trim();
              textChunks.push(/^https?:\/\//.test(shown) ? current.target : current.chunks.join(""));
              link = null;
            });
          }
        }
      },
      text(chunk) {
        if (raw.depth > 0) {
          return;
        }
        allText += chunk.text;
        if (stat !== null) {
          stat.chunks.push(chunk.text);
        } else if (message.depth > 0 && hidden.depth === 0) {
          (link ? link.chunks : textChunks).push(chunk.text);
        }
      },
    });

  await rewriter.transform(response).arrayBuffer();

  page.unavailable = allText.includes(UNAVAILABLE_TEXT);
  page.text = cleanText(textChunks);
  return page;
}

/** `https://www.facebook.com/NASA/posts/…` → `https://www.facebook.com/NASA`. */
function profileUrl(postLink: string | undefined): string | undefined {
  const url = postLink ? parseUrl(postLink) : null;
  const first = url?.pathname.split("/")[1] ?? "";
  if (!first || NOT_PROFILES.has(first) || first.includes(".php")) {
    return undefined;
  }
  return `${FACEBOOK_ORIGIN}/${first}`;
}

function toPost(page: PluginPage): NormalizedPost {
  const media: MediaItem[] = page.video
    ? [{ kind: "video", url: page.video }]
    : page.images.slice(0, MAX_IMAGES).map((url) => ({ kind: "image", url }));
  const url = profileUrl(page.postLink);
  const post: NormalizedPost = {
    title: page.author,
    siteName: "Facebook",
    author: {
      name: page.author,
      verified: page.verified,
      ...(page.avatar ? { avatar: page.avatar } : {}),
      ...(url ? { url } : {}),
    },
    text: page.text,
    media,
    createdAt: page.createdAt,
  };
  if (Object.keys(page.stats).length > 0) {
    post.stats = page.stats;
  }
  return post;
}

export const pluginFetcher: Fetcher = {
  name: "plugin",
  async run(ref): Promise<UpstreamResult> {
    const href = encodeURIComponent(postUrl(ref));
    const response = await facebookGet(`${FACEBOOK_ORIGIN}/plugins/post.php?href=${href}&locale=en_US`);
    const status = response.status;
    if (status !== 200) {
      await response.body?.cancel();
      return {
        kind: "transient",
        httpStatus: status,
        errorCode: status >= 300 && status < 400 ? "redirect" : isTransientStatus(status) ? null : "unexpected_status",
      };
    }

    const page = await parsePluginPage(response);
    // 社團貼文、網址帶 slug 的貼文也會顯示 "no longer available"，不能直接當成需登入，交給 og 那一層判斷。
    if (page.unavailable) {
      return { kind: "transient", httpStatus: status, errorCode: "plugin_unavailable" };
    }
    if (!page.author) {
      return { kind: "transient", httpStatus: status, errorCode: "plugin_unparsed" };
    }
    return { kind: "public", httpStatus: status, post: toPost(page) };
  },
};
