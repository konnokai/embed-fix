/**
 * Threads provider: `/@{username}/post/{code}`, `/t/{code}`,
 * `/share/{shareCode}` and `/@{username}` (a profile), the same paths as on
 * threads.com / threads.net.
 *
 * Nothing here logs in or sends cookies. Posts that need a login are shown as
 * a status card; anonymously they look the same as deleted ones, and the card
 * says so.
 */

import type { PostRef, Provider } from "../../core/types";
import { embedFetcher } from "./embed";
import { POST_PATH, THREADS_ORIGIN } from "./http";
import { ogFetcher } from "./og";
import { profileFetcher } from "./profile";
import { resolveShare } from "./share";

const SHORT_PATH = /^\/t\/([A-Za-z0-9_-]+)\/?$/;
const SHARE_PATH = /^\/share\/([A-Za-z0-9_-]+)\/?$/;
const PROFILE_PATH = /^\/(?:@|%40)([A-Za-z0-9._]+)\/?$/;

function postPath(ref: PostRef): string {
  const { username, code, shareCode } = ref.params;
  if (username && code) {
    return `/@${username}/post/${code}`;
  }
  return code ? `/t/${code}` : `/share/${shareCode}`;
}

function profilePath(ref: PostRef): string {
  return `/@${ref.params.username}`;
}

export const threads: Provider = {
  id: "threads",
  siteName: "Threads",
  lang: "zh-Hant",
  originalLinkText: "前往 Threads 原文",
  accentColor: 0x000000,
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
  healthCheckPaths: ["/@zuck/post/C-srcchPpp7"],
};

/**
 * Threads profiles. `/@{username}` is Instagram's profile path too; the shared
 * domain gives it to Threads (listed earlier in the router), and Instagram
 * profiles are not supported at all.
 */
export const threadsProfiles: Provider = {
  ...threads,
  match(url) {
    const profile = PROFILE_PATH.exec(url.pathname);
    if (!profile) {
      return null;
    }
    // 帳號不分大小寫，但只有小寫的網址回得了內容（2026-11-10 實測 @NASA 是「Profile not available」）。
    const username = profile[1].toLowerCase();
    return { key: `profile:${username}`, params: { username } };
  },
  fetchers: [profileFetcher],
  originalUrl: (ref) => `${THREADS_ORIGIN}${profilePath(ref)}`,
  canonicalPath: profilePath,
  originalLinkText: "前往 Threads 個人頁",
  statusText: {
    login_required: {
      title: "無法預覽的個人頁",
      description: "這個個人頁需要登入 Threads 才能查看，也可能是私人帳號或已刪除。",
    },
    not_found: {
      title: "個人頁不存在或已刪除",
      description: "找不到這個個人頁。",
    },
    restricted: {
      title: "個人頁無法公開預覽",
      description: "這個個人頁目前限制公開。",
    },
    transient: threads.statusText.transient,
  },
  // 首頁狀態只看每個平台的第一個樣本，這裡的樣本只送通知（見 health.ts）。
  healthCheckPaths: ["/@zuck"],
};
