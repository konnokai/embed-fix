/**
 * Main Instagram fetcher: the public embed page `/p/{code}/embed/captioned/`.
 * `/reel/{code}/embed/…` only returns the app shell, so every kind of post
 * goes through `/p/` (checked 2026-10-04).
 *
 * Two sources on the same page:
 *
 * - Videos and carousels carry `contextJSON` in a ServerJS script: a JSON
 *   string holding `gql_data.shortcode_media` with the owner, the full
 *   caption, exact counts, `video_url` and every carousel item. It is null on
 *   single-image posts.
 * - The visible HTML, the only source for single images:
 *   `.HeaderText .UsernameText`, `.HeaderText .VerifiedSprite` (a second one
 *   sits in the hover card), `a.Avatar img`, `img.EmbeddedMediaImage` (first item or video cover), `.SocialProof`
 *   ("257,134 likes") and `.Caption`, which starts with `a.CaptionUsername`
 *   and two `<br>` and ends with `.CaptionComments` ("View all 777
 *   comments"). The caption there is the full text.
 *
 * Missing, private and deleted posts all render `.EmbedBrokenMedia`; the og
 * fetcher decides what they are. Anything that matches neither shape is
 * reported as `transient`.
 */

import { decodeEntities, hasClass } from "../../core/html";
import type { Fetcher, MediaItem, NormalizedPost, UpstreamResult } from "../../core/types";
import { createdAtFromCode, INSTAGRAM_EARLIEST_MS } from "../threads/code";
import { INSTAGRAM_ORIGIN, instagramGet, isTransientStatus, mediaUrl } from "./http";

/** Discord shows at most 10 gallery items. */
const MAX_MEDIA = 10;

const CONTEXT_JSON = /"contextJSON":("(?:[^"\\]|\\.)*")/;

const LIKES = /^([\d.,]+[KMB]?) likes?$/;
const COMMENTS = /([\d.,]+[KMB]?) comments?$/;

interface GqlResource {
  src?: string;
  config_width?: number;
  config_height?: number;
}

interface GqlMedia {
  __typename?: string;
  shortcode?: string;
  is_video?: boolean;
  video_url?: string;
  display_url?: string;
  display_resources?: GqlResource[];
  dimensions?: { width?: number; height?: number };
  owner?: { username?: string; is_verified?: boolean; profile_pic_url?: string };
  edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
  edge_liked_by?: { count?: number };
  edge_media_to_comment?: { count?: number };
  edge_sidecar_to_children?: { edges?: Array<{ node?: GqlMedia }> };
}

export interface EmbedPage {
  broken: boolean;
  /** `shortcode_media` from `contextJSON`; undefined when it is null or unreadable. */
  media?: GqlMedia;
  handle: string;
  verified: boolean;
  avatar?: string;
  image?: string;
  caption: string;
  likes?: string;
  comments?: string;
}

/** Reads `shortcode_media` from one script's text; the JSON is a string inside the script's JSON. */
function contextMedia(script: string): GqlMedia | undefined {
  const match = CONTEXT_JSON.exec(script);
  if (!match) {
    return undefined;
  }
  try {
    const context = JSON.parse(JSON.parse(match[1]) as string) as { gql_data?: { shortcode_media?: GqlMedia } };
    return context.gql_data?.shortcode_media ?? undefined;
  } catch {
    // 格式壞掉就當作沒有 JSON，改用 HTML 欄位。
    return undefined;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 214763 → "214,763", the way the embed page shows counts. */
function formatCount(count: number | undefined): string | undefined {
  return typeof count === "number" && Number.isFinite(count) && count >= 0
    ? String(Math.floor(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : undefined;
}

/** Counts how deeply the parser currently sits inside matching elements. */
function track(element: Element, counter: { depth: number }): void {
  counter.depth += 1;
  element.onEndTag(() => {
    counter.depth -= 1;
  });
}

export async function parseEmbedPage(response: Response): Promise<EmbedPage> {
  const page: EmbedPage = { broken: false, handle: "", verified: false, caption: "" };
  const raw = { depth: 0 };
  const header = { depth: 0 };
  const username = { depth: 0 };
  const avatar = { depth: 0 };
  const likes = { depth: 0 };
  const caption = { depth: 0 };
  const captionUser = { depth: 0 };
  const comments = { depth: 0 };
  const handleChunks: string[] = [];
  const captionChunks: string[] = [];
  const likeChunks: string[] = [];
  const commentChunks: string[] = [];
  let script = "";

  const rewriter = new HTMLRewriter()
    .on("script", {
      text(chunk) {
        script += chunk.text;
        if (chunk.lastInTextNode) {
          page.media ??= script.includes('"contextJSON":"') ? contextMedia(script) : undefined;
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
        if (hasClass(element, "EmbedBrokenMedia")) {
          page.broken = true;
          return;
        }
        if (hasClass(element, "HeaderText")) {
          track(element, header);
          return;
        }
        if (header.depth > 0 && hasClass(element, "UsernameText")) {
          track(element, username);
          return;
        }
        if (header.depth > 0 && hasClass(element, "VerifiedSprite")) {
          page.verified = true;
          return;
        }
        if (tag === "a" && hasClass(element, "Avatar")) {
          track(element, avatar);
          return;
        }
        if (tag === "img" && avatar.depth > 0) {
          page.avatar ??= mediaUrl(decodeEntities(element.getAttribute("src") ?? "")) ?? undefined;
          return;
        }
        if (tag === "img" && hasClass(element, "EmbeddedMediaImage")) {
          page.image ??= mediaUrl(decodeEntities(element.getAttribute("src") ?? "")) ?? undefined;
          return;
        }
        if (hasClass(element, "SocialProof")) {
          track(element, likes);
          return;
        }
        if (hasClass(element, "Caption")) {
          track(element, caption);
          return;
        }
        if (caption.depth === 0) {
          return;
        }
        if (hasClass(element, "CaptionUsername")) {
          track(element, captionUser);
          return;
        }
        if (hasClass(element, "CaptionComments")) {
          track(element, comments);
          return;
        }
        if (tag === "br" && comments.depth === 0) {
          captionChunks.push("\n");
        }
      },
      text(chunk) {
        if (raw.depth > 0) {
          return;
        }
        if (username.depth > 0) {
          handleChunks.push(chunk.text);
        } else if (likes.depth > 0) {
          likeChunks.push(chunk.text);
        } else if (comments.depth > 0) {
          commentChunks.push(chunk.text);
        } else if (caption.depth > 0 && captionUser.depth === 0) {
          captionChunks.push(chunk.text);
        }
      },
    });

  await rewriter.transform(response).arrayBuffer();

  page.handle = decodeEntities(handleChunks.join("")).trim();
  page.caption = cleanText(decodeEntities(captionChunks.join("")));
  page.likes = LIKES.exec(decodeEntities(likeChunks.join("")).trim())?.[1];
  page.comments = COMMENTS.exec(decodeEntities(commentChunks.join("")).trim())?.[1];
  return page;
}

/** The video when there is a playable one, otherwise the largest image. */
function mediaItem(node: GqlMedia): MediaItem | null {
  const video = node.is_video ? mediaUrl(node.video_url) : null;
  const width = node.dimensions?.width;
  const height = node.dimensions?.height;
  if (video) {
    return { kind: "video", url: video, ...(width && height ? { width, height } : {}) };
  }
  const largest = (node.display_resources ?? [])
    .filter((resource) => mediaUrl(resource.src))
    .sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0))[0];
  if (largest?.src) {
    const size = largest.config_width && largest.config_height ? { width: largest.config_width, height: largest.config_height } : {};
    return { kind: "image", url: mediaUrl(largest.src)!, ...size };
  }
  const display = mediaUrl(node.display_url);
  return display ? { kind: "image", url: display, ...(width && height ? { width, height } : {}) } : null;
}

function jsonMedia(media: GqlMedia): MediaItem[] {
  const children = media.edge_sidecar_to_children?.edges ?? [];
  const nodes = children.length > 0 ? children.map((edge) => edge.node).filter((node): node is GqlMedia => !!node) : [media];
  return nodes
    .map(mediaItem)
    .filter((item): item is MediaItem => item !== null)
    .slice(0, MAX_MEDIA);
}

function toPost(page: EmbedPage, code: string): NormalizedPost {
  const json = page.media;
  const handle = json?.owner?.username || page.handle;
  const avatar = mediaUrl(json?.owner?.profile_pic_url) ?? page.avatar;
  const text = json?.edge_media_to_caption?.edges?.[0]?.node?.text;
  const media = json ? jsonMedia(json) : [];
  if (media.length === 0 && page.image) {
    media.push({ kind: "image", url: page.image });
  }
  const stats: NonNullable<NormalizedPost["stats"]> = {};
  const likes = formatCount(json?.edge_liked_by?.count) ?? page.likes;
  const replies = formatCount(json?.edge_media_to_comment?.count) ?? page.comments;
  if (likes) stats.likes = likes;
  if (replies) stats.replies = replies;

  const post: NormalizedPost = {
    title: `@${handle}`,
    siteName: "Instagram",
    author: {
      name: "",
      handle,
      ...(avatar ? { avatar } : {}),
      verified: json?.owner?.is_verified ?? page.verified,
      url: `${INSTAGRAM_ORIGIN}/${handle}/`,
    },
    text: typeof text === "string" ? cleanText(text) : page.caption,
    media,
    createdAt: createdAtFromCode(code, INSTAGRAM_EARLIEST_MS),
  };
  if (Object.keys(stats).length > 0) {
    post.stats = stats;
  }
  return post;
}

export const embedFetcher: Fetcher = {
  name: "embed",
  async run(ref): Promise<UpstreamResult> {
    const code = ref.params.code;
    const response = await instagramGet(`${INSTAGRAM_ORIGIN}/p/${code}/embed/captioned/`);
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
    // 別篇貼文的 JSON（例如改版後放了推薦內容）不能拿來用，退回 HTML 欄位。
    if (page.media && page.media.shortcode !== code) {
      page.media = undefined;
    }
    if (page.broken) {
      return { kind: "transient", httpStatus: status, errorCode: "embed_broken" };
    }
    if (!page.media?.owner?.username && !page.handle) {
      return { kind: "transient", httpStatus: status, errorCode: "embed_unparsed" };
    }
    return { kind: "public", httpStatus: status, post: toPost(page, code) };
  },
};
