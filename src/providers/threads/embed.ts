/**
 * Main Threads fetcher: the public embed page `/t/{code}/embed`.
 *
 * Structure observed 2026-10-03 (class names, not tag paths, are relied on):
 *
 * - Each post is a `div.OuterContainer` with `.AvatarContainer img`, a
 *   `.HeaderLink` whose href is the author's profile, an optional
 *   `.VerifiedBadge`, `.BodyTextContainer` for text, and media in
 *   `.SoloMediaContainer` or `.MediaScrollContainer` (`img` or
 *   `video > source`).
 * - A reply shows its parent first; the parent's body is
 *   `.BodyContainerParent`, and the requested post is the last top-level block.
 * - A quoted post is an `OuterContainer` inside `.QuotePostContainer`; its text
 *   is filled in by script, so only the handle (and any media) is in the HTML.
 * - `.TopicTagWrapper` after the author holds the topic or community tag;
 *   its link is also a `.HeaderLink`, so it must not be read as the author.
 *   Long tag text is cut by bytes, leaving U+FFFD and "..."
 *   (observed 2026-10-04), so the name comes from the link's `q` instead.
 * - `.ActionBarIcon` entries are likes, replies, reposts and shares in that
 *   order; `.ActionBarCount` is missing when the count is zero.
 * - `.Timestamp` is localized display text, so the time comes from the post
 *   code instead (see `code.ts`).
 * - Login-only, private and deleted posts all render
 *   `.ErrorText` "Thread not available"; they cannot be told apart anonymously.
 *
 * Anything that does not match this shape is reported as `transient`, never
 * as public with missing fields.
 */

import { decodeEntities, hasClass } from "../../core/html";
import type { Fetcher, MediaItem, NormalizedPost, UpstreamResult } from "../../core/types";
import { createdAtFromCode } from "./code";
import { isThreadsUrl, isTransientStatus, parseUrl, THREADS_ORIGIN, threadsGet } from "./http";

interface Block {
  handle: string;
  avatar?: string;
  verified: boolean;
  isParent: boolean;
  textChunks: string[];
  topicChunks: string[];
  /** Full tag name from the tag link's search query. */
  topicQuery?: string;
  /** Action bar counts by icon position; see the module comment for the order. */
  counts: string[];
  media: MediaItem[];
  quote?: Block;
}

const STAT_KEYS = ["likes", "replies", "reposts", "shares"] as const;

/** U+FFFC, an object placeholder Threads leaves inside post text. */
const OBJECT_PLACEHOLDER = String.fromCharCode(0xfffc);

export interface EmbedPage {
  unavailable: boolean;
  main: Block | null;
  parent: Block | null;
}

function newBlock(): Block {
  return { handle: "", verified: false, isParent: false, textChunks: [], topicChunks: [], counts: [], media: [] };
}

/** `https://www.threads.com/@zuck?xmt=…` → "zuck". */
function handleFromProfileUrl(href: string): string {
  const url = parseUrl(decodeEntities(href));
  if (!url || !isThreadsUrl(url)) {
    return "";
  }
  const match = /^\/(?:@|%40)([A-Za-z0-9._]+)\/?$/.exec(url.pathname);
  return match ? match[1] : "";
}

/** `https://www.threads.com/search?q=明日方舟&serp_type=tags…` → "明日方舟". */
function tagFromSearchUrl(href: string): string {
  const url = parseUrl(decodeEntities(href));
  if (!url || !isThreadsUrl(url) || url.pathname !== "/search") {
    return "";
  }
  return url.searchParams.get("q")?.trim() ?? "";
}

function httpsUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const url = parseUrl(decodeEntities(value));
  return url && url.protocol === "https:" ? url.href : null;
}

function cleanText(chunks: string[]): string {
  return decodeEntities(chunks.join(""))
    .replaceAll(OBJECT_PLACEHOLDER, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Counts how deeply the parser currently sits inside elements with a class. */
function track(element: Element, counter: { depth: number }): void {
  counter.depth += 1;
  element.onEndTag(() => {
    counter.depth -= 1;
  });
}

export async function parseEmbedPage(response: Response): Promise<EmbedPage> {
  const blocks: Block[] = [];
  const stack: Block[] = [];
  const quote = { depth: 0 };
  const media = { depth: 0 };
  const text = { depth: 0 };
  const avatar = { depth: 0 };
  const topic = { depth: 0 };
  const count = { depth: 0 };
  let unavailable = false;

  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const current = stack[stack.length - 1];

      if (hasClass(element, "ErrorText")) {
        unavailable = true;
        return;
      }
      if (hasClass(element, "OuterContainer")) {
        const block = newBlock();
        if (quote.depth > 0 && current) {
          current.quote = block;
        } else {
          blocks.push(block);
        }
        stack.push(block);
        element.onEndTag(() => {
          stack.pop();
        });
        return;
      }
      if (hasClass(element, "QuotePostContainer")) {
        track(element, quote);
        return;
      }
      if (!current) {
        return;
      }
      if (hasClass(element, "SoloMediaContainer") || hasClass(element, "MediaScrollContainer")) {
        track(element, media);
        return;
      }
      if (hasClass(element, "AvatarContainer")) {
        track(element, avatar);
        return;
      }
      if (hasClass(element, "TopicTagWrapper")) {
        track(element, topic);
        return;
      }
      if (hasClass(element, "ActionBarIcon")) {
        current.counts.push("");
        return;
      }
      if (hasClass(element, "ActionBarCount")) {
        track(element, count);
        return;
      }
      if (hasClass(element, "BodyTextContainer")) {
        track(element, text);
        return;
      }
      if (hasClass(element, "BodyContainerParent")) {
        current.isParent = true;
        return;
      }
      if (hasClass(element, "VerifiedBadge")) {
        current.verified = true;
        return;
      }

      const tag = element.tagName;
      if (tag === "a" && topic.depth > 0) {
        current.topicQuery ||= tagFromSearchUrl(element.getAttribute("href") ?? "");
        return;
      }
      if (tag === "a" && hasClass(element, "HeaderLink") && topic.depth === 0 && !current.handle) {
        current.handle = handleFromProfileUrl(element.getAttribute("href") ?? "");
        return;
      }
      if (tag === "br" && text.depth > 0) {
        current.textChunks.push("\n");
        return;
      }
      if (tag === "img" && avatar.depth > 0) {
        current.avatar ??= httpsUrl(element.getAttribute("src")) ?? undefined;
        return;
      }
      if (media.depth > 0 && (tag === "img" || tag === "source")) {
        const src = httpsUrl(element.getAttribute("src"));
        if (src) {
          current.media.push({ kind: tag === "img" ? "image" : "video", url: src });
        }
      }
    },
    text(chunk) {
      const current = stack[stack.length - 1];
      if (!current) {
        return;
      }
      if (text.depth > 0) {
        current.textChunks.push(chunk.text);
      } else if (topic.depth > 0) {
        current.topicChunks.push(chunk.text);
      } else if (count.depth > 0 && current.counts.length > 0) {
        current.counts[current.counts.length - 1] += chunk.text;
      }
    },
  });

  await rewriter.transform(response).arrayBuffer();

  const main = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const previous = blocks.length > 1 ? blocks[blocks.length - 2] : null;
  return { unavailable, main, parent: previous?.isParent ? previous : null };
}

function stats(block: Block): NormalizedPost["stats"] {
  const result: NonNullable<NormalizedPost["stats"]> = {};
  STAT_KEYS.forEach((key, index) => {
    const value = decodeEntities(block.counts[index] ?? "").trim();
    if (value) {
      result[key] = value;
    }
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function toPost(page: EmbedPage, main: Block, code: string): NormalizedPost {
  const post: NormalizedPost = {
    title: `@${main.handle}`,
    siteName: "Threads",
    author: {
      name: "",
      handle: main.handle,
      avatar: main.avatar,
      verified: main.verified,
      url: `${THREADS_ORIGIN}/@${main.handle}`,
    },
    text: cleanText(main.textChunks),
    media: main.media,
    createdAt: createdAtFromCode(code),
  };
  const topicName = main.topicQuery || cleanText(main.topicChunks);
  if (topicName) {
    post.topic = topicName;
  }
  const counts = stats(main);
  if (counts) {
    post.stats = counts;
  }
  if (page.parent?.handle) {
    post.replyTo = { handle: page.parent.handle, text: cleanText(page.parent.textChunks) };
  }
  if (main.quote?.handle) {
    post.quoted = { handle: main.quote.handle, text: cleanText(main.quote.textChunks), media: main.quote.media };
  }
  return post;
}

export const embedFetcher: Fetcher = {
  name: "embed",
  async run(ref): Promise<UpstreamResult> {
    // The embed page answers on /t/{code}/embed without the username
    // (verified 2026-10-03), so /t/ and resolved links share one request.
    const response = await threadsGet(`${THREADS_ORIGIN}/t/${ref.params.code}/embed`);
    const status = response.status;
    if (status !== 200) {
      await response.body?.cancel();
      if (status === 404) {
        return { kind: "not_found", httpStatus: status, errorCode: null };
      }
      return {
        kind: "transient",
        httpStatus: status,
        errorCode: status >= 300 && status < 400 ? "redirect" : isTransientStatus(status) ? null : "unexpected_status",
      };
    }

    const page = await parseEmbedPage(response);
    if (page.unavailable) {
      return { kind: "login_required", httpStatus: status, errorCode: "thread_not_available" };
    }
    if (!page.main?.handle) {
      return { kind: "transient", httpStatus: status, errorCode: "embed_unparsed" };
    }
    return { kind: "public", httpStatus: status, post: toPost(page, page.main, ref.params.code) };
  },
};
