/**
 * Instagram provider: `/p/{code}`, `/reel/{code}`, `/reels/{code}`,
 * `/tv/{code}` and `/{username}/p|reel/{code}`, the same paths as on
 * instagram.com (see `http.ts`).
 *
 * Nothing here logs in or sends cookies. The embed page is the main source;
 * the post page's Open Graph tags cover what the embed refuses. Share links
 * are resolved first (see `share.ts`).
 *
 * On the shared domain Threads and Facebook are listed first, so a numeric
 * `/reel/{id}` and `/share/p/{hash}` stay Facebook's and `/share/{hash}`
 * stays Threads'; ig.ebfix.konnokai.me serves only Instagram.
 */

import type { Provider } from "../../core/types";
import { embedFetcher } from "./embed";
import { matchPostUrl, postPath, postUrl } from "./http";
import { ogFetcher } from "./og";
import { matchShare, resolveShare } from "./share";

export const instagram: Provider = {
  id: "instagram",
  siteName: "Instagram",
  lang: "zh-Hant",
  originalLinkText: "前往 Instagram 原文",
  match: (url) => matchPostUrl(url) ?? matchShare(url),
  resolve(ref) {
    return ref.params.share ? resolveShare(ref.params.path) : Promise.resolve(ref);
  },
  fetchers: [embedFetcher, ogFetcher],
  originalUrl: postUrl,
  canonicalPath: postPath,
  statusText: {
    login_required: {
      title: "需登入的貼文",
      description: "這篇貼文需要登入 Instagram 才能查看，也可能是私人帳號或已刪除。",
    },
    not_found: {
      title: "貼文不存在或已刪除",
      description: "找不到這篇貼文，可能已被刪除。",
    },
    restricted: {
      title: "貼文無法公開預覽",
      description: "這篇貼文目前限制公開。",
    },
    transient: {
      title: "暫時無法取得預覽",
      description: "上游暫時無法回應，請稍後再試。",
    },
  },
  cacheTtl: { post: 600, status: 60 },
  serveStoredWhenUnavailable: true,
  healthCheckPath: "/p/CuE2WNQs6vH",
};
