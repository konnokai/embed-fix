/**
 * Second Facebook fetcher: the Open Graph tags of the post page on
 * www.facebook.com, used when the plugin has nothing. This is the only source
 * for public group posts and for post URLs with a slug (checked 2026-10-03).
 *
 * Only a title, a text excerpt and one image are available. The title format
 * depends on the post kind:
 *
 * - group post: `{group} | {text excerpt} | Facebook`
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

/** Reads `og:*` and `twitter:*` meta tags and the canonical link from a page head. */
export async function readMeta(response: Response): Promise<Map<string, string>> {
  const meta = new Map<string, string>();
  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(element) {
        const name = element.getAttribute("property") ?? element.getAttribute("name");
        const content = element.getAttribute("content");
        if (name && /^(?:og|twitter):/.test(name) && content !== null && !meta.has(name)) {
          meta.set(name, decodeEntities(content));
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
  await rewriter.transform(response).arrayBuffer();
  return meta;
}

/** `/zuck/videos/…` → "zuck"; null for paths without a profile segment. */
function profileName(value: string | undefined): string | null {
  const url = value ? parseUrl(value) : null;
  const first = url?.pathname.split("/")[1] ?? "";
  return first && !first.includes(".") && !["groups", "watch", "reel", "photo"].includes(first) ? first : null;
}

/**
 * Splits the title into a display name. A group title starts with the group
 * name; a video title starts with counters and carries no name at all.
 */
function nameFromTitle(title: string): string {
  const parts = title.replace(/\s*\|\s*Facebook$/, "").split(" | ");
  return VIEW_COUNTS.test(parts[0]) ? "" : parts[0].trim();
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

      const meta = await readMeta(response);
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
      const name = nameFromTitle(title) || profile || "Facebook";
      const image = meta.get("og:image");
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
