/**
 * Facebook provider: page and profile posts, videos and reels, photos,
 * `story.php` / `permalink.php` and public group posts, with the same paths as
 * on facebook.com (see `http.ts` for the exact rules).
 *
 * Nothing here logs in or sends cookies. The embedded post plugin is the main
 * source; the post page's Open Graph tags cover what the plugin refuses.
 * Share links are resolved first (see `share.ts`). `/share/{hash}` has the
 * same shape as a Threads share link, so on the shared domain Threads (listed
 * earlier in the router) takes it; fb.ebfix.konnokai.me serves only Facebook.
 */

import type { Provider } from "../../core/types";
import { matchPostUrl, postUrl } from "./http";
import { ogFetcher } from "./og";
import { pluginFetcher } from "./plugin";
import { matchShare, resolveShare } from "./share";

export const facebook: Provider = {
  id: "facebook",
  siteName: "Facebook",
  lang: "zh-Hant",
  originalLinkText: "前往 Facebook 原文",
  match: (url) => matchPostUrl(url) ?? matchShare(url),
  resolve(ref) {
    return ref.params.share ? resolveShare(ref.params.path) : Promise.resolve(ref);
  },
  fetchers: [pluginFetcher, ogFetcher],
  originalUrl: postUrl,
  canonicalPath: (ref) => ref.params.path,
  statusText: {
    login_required: {
      title: "需登入的貼文",
      description: "這篇貼文需要登入 Facebook 才能查看，也可能是私人貼文或已刪除。",
    },
    not_found: {
      title: "貼文不存在或已刪除",
      description: "找不到這篇貼文，可能已被刪除，或是不支援的內容（例如活動頁）。",
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
  healthCheckPath: "/reel/2300161320399228",
};
