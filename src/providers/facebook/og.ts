/**
 * Second Facebook fetcher: the Open Graph tags of the post page on
 * www.facebook.com, used when the plugin has nothing. This is the only source
 * for public group posts and for post URLs with a slug (checked 2026-10-03).
 *
 * Only a title, a text excerpt and one image are available. The title format
 * depends on the post kind:
 *
 * - group post: `{text excerpt} | Facebook` since 2026-10 (it used to start
 *   with the group). The group name is read from the page's JSON
 *   (`group_name`) or `<title>` (`{group} | {text}`) instead. A text-only post
 *   has the group banner (`group_image_url`) as `og:image`; it is dropped.
 * - video: no `og:title`; `twitter:title` is `40M views · 241K reactions | {text}`
 *
 * Pages that need a login redirect to `/login`; `story.php`, `permalink.php`
 * and photo pages always do, even for public posts.
 */

import { decodeEntities } from "../../core/html";
import type { Fetcher, UpstreamResult } from "../../core/types";
import {
  FACEBOOK_ORIGIN,
  facebookGet,
  isFacebookUrl,
  isLoginUrl,
  isTransientStatus,
  MAX_REDIRECTS,
  parseUrl,
  postUrl,
} from "./http";

const VIEW_COUNTS = /^[\d.,]+[KMB]? views? · /;

const GROUP_NAME = /"group_name":"((?:[^"\\]|\\.)*)"/;

const GROUP_BANNER = /"group_image_url":"((?:[^"\\]|\\.)*)"/;

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

interface GroupPage {
  /** `<title>`, `{group} | {text}`. */
  pageTitle?: string;
  /** `group_name` from the page's JSON. */
  name?: string;
  /** `group_image_url` from the page's JSON: the group banner. */
  banner?: string;
}

/** A JSON string literal's content (without quotes) → its value; undefined when the escapes are invalid. */
function jsonString(literal: string | undefined): string | undefined {
  if (literal === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return undefined;
  }
}

/** Adds handlers for the group name and banner of a group post page. */
function readGroup(rewriter: HTMLRewriter, group: GroupPage): HTMLRewriter {
  let title = "";
  let script = "";
  return rewriter
    .on("head > title", {
      text(chunk) {
        title += chunk.text;
        if (chunk.lastInTextNode && group.pageTitle === undefined) {
          group.pageTitle = decodeEntities(title).trim();
        }
      },
    })
    .on("script", {
      text(chunk) {
        script += chunk.text;
        if (!chunk.lastInTextNode) {
          return;
        }
        if (script.includes('"group_')) {
          group.name ??= jsonString(GROUP_NAME.exec(script)?.[1])?.trim() || undefined;
          group.banner ??= jsonString(GROUP_BANNER.exec(script)?.[1]);
        }
        script = "";
      },
    });
}

/** Last path segment, e.g. `842331526_…_n.jpg`; the host and signed query differ between copies of one image. */
function fileName(value: string): string | undefined {
  return parseUrl(value)?.pathname.split("/").pop() || undefined;
}

/** `/zuck/videos/…` → "zuck"; null for paths without a profile segment. */
function profileName(value: string | undefined): string | null {
  const url = value ? parseUrl(value) : null;
  const first = url?.pathname.split("/")[1] ?? "";
  return first && !first.includes(".") && !["groups", "watch", "reel", "photo"].includes(first) ? first : null;
}

/**
 * Splits the title into a display name: the first part, except for videos.
 * A video title starts with counters and ends with the author
 * (`327K views · 61K reactions | {text} | {author}`); the shortened
 * `twitter:title` drops the author.
 */
function nameFromTitle(title: string): string {
  const parts = title.replace(/\s*\|\s*Facebook$/, "").split(" | ");
  if (VIEW_COUNTS.test(parts[0])) {
    return parts.length >= 3 ? parts[parts.length - 1].trim() : "";
  }
  return parts[0].trim();
}

export const ogFetcher: Fetcher = {
  name: "og",
  async run(ref): Promise<UpstreamResult> {
    let current = new URL(postUrl(ref));
    for (let hop = 0; ; hop += 1) {
      const response = await facebookGet(current.href);
      const status = response.status;

      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        const next = parseUrl(response.headers.get("location") ?? "", current);
        if (next && isFacebookUrl(next) && isLoginUrl(next)) {
          return { kind: "login_required", httpStatus: status, errorCode: "login_redirect" };
        }
        if (!next || !isFacebookUrl(next) || hop >= MAX_REDIRECTS) {
          return { kind: "transient", httpStatus: status, errorCode: "redirect_rejected" };
        }
        current = next;
        continue;
      }
      if (status === 404) {
        await response.body?.cancel();
        return { kind: "not_found", httpStatus: status, errorCode: null };
      }
      if (status !== 200) {
        await response.body?.cancel();
        return { kind: "transient", httpStatus: status, errorCode: isTransientStatus(status) ? null : "unexpected_status" };
      }

      const group: GroupPage = {};
      const isGroup = ref.key.startsWith("group:");
      const meta = await readMeta(response, isGroup ? (rewriter) => readGroup(rewriter, group) : undefined);
      const canonical = parseUrl(meta.get("canonical") ?? "");
      if (canonical && isLoginUrl(canonical)) {
        return { kind: "login_required", httpStatus: status, errorCode: "login_page" };
      }
      const title = meta.get("og:title") ?? meta.get("twitter:title");
      if (!title) {
        // 不存在的貼文也是 200、沒有 og 標籤，匿名時跟需登入分不出來。
        return { kind: "login_required", httpStatus: status, errorCode: "og_missing" };
      }

      const pageUrl = meta.get("og:url") ?? meta.get("canonical");
      const profile = profileName(pageUrl);
      // 網址第一段可能是數字 ID（例如 /17841401331580275/videos/…），不能拿來當名稱。
      const groupName = group.name || group.pageTitle?.split(" | ")[0].trim();
      const name =
        groupName || nameFromTitle(title) || (profile && !/^\d+$/.test(profile) ? profile : "") || "Facebook";
      let image = meta.get("og:image");
      // 純文字的社團貼文，og:image 會是社團 banner，不是貼文的圖。
      if (image && group.banner && fileName(image) === fileName(group.banner)) {
        image = undefined;
      }
      return {
        kind: "public",
        httpStatus: status,
        post: {
          title: name,
          siteName: "Facebook",
          author: { name, ...(profile ? { url: `${FACEBOOK_ORIGIN}/${profile}` } : {}) },
          text: meta.get("og:description") ?? meta.get("twitter:description") ?? "",
          media: image && parseUrl(image)?.protocol === "https:" ? [{ kind: "image", url: image }] : [],
          createdAt: null,
        },
      };
    }
  },
};
