/**
 * Threads provider: `/@{username}/post/{code}`, `/t/{code}` and
 * `/share/{shareCode}`, the same paths as on threads.com / threads.net.
 *
 * Nothing here logs in or sends cookies. Posts that need a login are shown as
 * a status card; anonymously they look the same as deleted ones, and the card
 * says so.
 */

import type { PostRef, Provider } from "../../core/types";
import { embedFetcher } from "./embed";
import { POST_PATH, THREADS_ORIGIN } from "./http";
import { ogFetcher } from "./og";
import { resolveShare } from "./share";

const SHORT_PATH = /^\/t\/([A-Za-z0-9_-]+)\/?$/;
const SHARE_PATH = /^\/share\/([A-Za-z0-9_-]+)\/?$/;

function postPath(ref: PostRef): string {
  const { username, code, shareCode } = ref.params;
  if (username && code) {
    return `/@${username}/post/${code}`;
  }
  return code ? `/t/${code}` : `/share/${shareCode}`;
}

export const threads: Provider = {
  id: "threads",
  siteName: "Threads",
  lang: "zh-Hant",
  originalLinkText: "前往 Threads 原文",
  match(url): PostRef | null {
    const post = POST_PATH.exec(url.pathname);
    if (post && post[1]) {
      return { key: post[2], params: { username: post[1], code: post[2] } };
    }
    const short = SHORT_PATH.exec(url.pathname);
    if (short) {
      return { key: short[1], params: { code: short[1] } };
    }
    const share = SHARE_PATH.exec(url.pathname);
    if (share) {
      return { key: `share:${share[1]}`, params: { shareCode: share[1] } };
    }
    return null;
  },
  resolve(ref) {
    return ref.params.shareCode ? resolveShare(ref.params.shareCode) : Promise.resolve(ref);
  },
  fetchers: [embedFetcher, ogFetcher],
  originalUrl: (ref) => `${THREADS_ORIGIN}${postPath(ref)}`,
  canonicalPath: postPath,
  statusText: {
    login_required: {
      title: "需登入的貼文",
      description: "這篇貼文需要登入 Threads 才能查看，也可能是私人帳號或已刪除。",
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
  healthCheckPath: "/@zuck/post/C-srcchPpp7",
};
