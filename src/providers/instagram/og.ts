/**
 * Second Instagram fetcher: the Open Graph tags of `/p/{code}/`, used when
 * the embed page has nothing. This is also the only place with the author's
 * display name. Formats observed 2026-10-04:
 *
 * - `og:title`: `{name} on Instagram: "{caption}"`
 * - `twitter:title`: `{name} (@{username}) • Instagram reel`
 * - `og:description`: `44K likes, 116 comments - {username} on {date}: "{caption}". `
 * - `og:url`: `https://www.instagram.com/{username}/reel/{code}/`
 *
 * A missing post still answers 200, only without any og tag; anonymously it
 * looks the same as a private or deleted one.
 */

import { readMeta } from "../../core/html";
import { follow, isTransientStatus } from "../../core/http";
import type { Fetcher, NormalizedPost, UpstreamResult } from "../../core/types";
import { createdAtFromCode, INSTAGRAM_EARLIEST_MS } from "../threads/code";
import { INSTAGRAM_ORIGIN, instagramGet, isInstagramUrl, isLoginUrl, matchPostUrl, mediaUrl, postUrl } from "./http";

const OG_TITLE = /^(.*?) on Instagram: "([\s\S]*)"$/;
const TWITTER_TITLE = /^(.*?) \(@([A-Za-z0-9._]+)\) • Instagram/;
const OG_DESCRIPTION = /^(?:([\d.,]+[KMB]?) likes?, )?(?:([\d.,]+[KMB]?) comments? - )?([A-Za-z0-9._]+) on [^:]+: "([\s\S]*)"\.?\s*$/;

interface Parsed {
  name: string;
  handle: string;
  text: string;
  stats: NonNullable<NormalizedPost["stats"]>;
}

function parseMeta(meta: Map<string, string>, title: string): Parsed {
  const named = OG_TITLE.exec(title);
  const twitter = TWITTER_TITLE.exec(meta.get("twitter:title") ?? "");
  const description = OG_DESCRIPTION.exec(meta.get("og:description") ?? "");
  const pageUrl = URL.parse(meta.get("og:url") ?? "");
  const fromUrl = pageUrl && isInstagramUrl(pageUrl) ? matchPostUrl(pageUrl)?.params.username : undefined;

  const stats: Parsed["stats"] = {};
  if (description?.[1]) stats.likes = description[1];
  if (description?.[2]) stats.replies = description[2];
  return {
    name: (twitter?.[1] ?? named?.[1] ?? title.replace(/ on Instagram$/, "")).trim(),
    handle: twitter?.[2] ?? description?.[3] ?? fromUrl ?? "",
    text: (named?.[2] ?? description?.[4] ?? "").trim(),
    stats,
  };
}

export const ogFetcher: Fetcher = {
  name: "og",
  async run(ref): Promise<UpstreamResult> {
    const response = await follow(new URL(postUrl(ref)), instagramGet, isInstagramUrl, (target, status): UpstreamResult | null =>
      isLoginUrl(target) ? { kind: "login_required", httpStatus: status, errorCode: "login_redirect" } : null,
    );
    if (!(response instanceof Response)) {
      return response;
    }
    const status = response.status;
    if (status === 404) {
      await response.body?.cancel();
      return { kind: "not_found", httpStatus: status, errorCode: null };
    }
    if (status !== 200) {
      await response.body?.cancel();
      return { kind: "transient", httpStatus: status, errorCode: isTransientStatus(status) ? null : "unexpected_status" };
    }

    const meta = await readMeta(response);
    const title = meta.get("og:title");
    if (!title) {
      // 不存在的貼文也是 200、沒有 og 標籤，匿名時跟私人帳號、已刪除分不出來。
      return { kind: "login_required", httpStatus: status, errorCode: "og_missing" };
    }

    const parsed = parseMeta(meta, title);
    const image = mediaUrl(meta.get("og:image"));
    const post: NormalizedPost = {
      title: parsed.handle ? `@${parsed.handle}` : parsed.name || "Instagram",
      siteName: "Instagram",
      author: {
        name: parsed.name,
        ...(parsed.handle ? { handle: parsed.handle, url: `${INSTAGRAM_ORIGIN}/${parsed.handle}/` } : {}),
      },
      text: parsed.text,
      media: image ? [{ kind: "image", url: image }] : [],
      createdAt: createdAtFromCode(ref.params.code, INSTAGRAM_EARLIEST_MS),
    };
    if (Object.keys(parsed.stats).length > 0) {
      post.stats = parsed.stats;
    }
    return { kind: "public", httpStatus: status, post };
  },
};
