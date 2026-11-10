/**
 * Threads profile fetcher: the profile's public embed page `/@{username}/embed`.
 *
 * Structure observed 2026-11-10 (classes, not tag paths, are relied on):
 *
 * - `.ProfileHeader` holds `.ProfileAvatarContainer img`, `.ProfileDisplayName`
 *   and `.ProfileUsername`. `.ProfileBiography` is the bio, and each
 *   `.ProfileBioLinkItem a` a link in bio, wrapped in `l.facebook.com/l.php?u=`.
 * - `.ProfileFollowerCount` is the count as displayed ("26.0K followers"); the
 *   unit word is localized, the number is not.
 * - A profile that does not exist renders `.ErrorText` "Profile not available";
 *   private and deleted accounts cannot be told apart from it anonymously.
 * - The thread count is not on this page. It only appears in the profile page's
 *   `og:description` ("26.0K Followers • 294 Threads • …"), so that page is
 *   fetched too and the count is left out when it does not answer.
 * - `.VerifiedBadge` and the community tags are present but not shown.
 */

import { decodeEntities, hasClass, readMeta, track } from "../../core/html";
import { isTransientStatus } from "../../core/http";
import type { Fetcher, NormalizedPost, UpstreamResult } from "../../core/types";
import { cleanText, httpsUrl } from "./embed";
import { THREADS_ORIGIN, threadsGet } from "./http";

interface ProfilePage {
  unavailable: boolean;
  displayName: string;
  handle: string;
  avatar: string | null;
  bio: string;
  followers: string;
  links: { label: string; url: string }[];
}

type Field = "displayName" | "handle" | "bio" | "followers";

/** `https://l.facebook.com/l.php?u=<target>&h=…` → the target; any other https URL unchanged. */
function targetUrl(href: string): string | null {
  const value = httpsUrl(href);
  if (!value) {
    return null;
  }
  const url = new URL(value);
  const wrapped = url.searchParams.get("u");
  return url.hostname === "l.facebook.com" && url.pathname === "/l.php" && wrapped ? httpsUrl(wrapped) : value;
}

/**
 * A count as the platform displays it, without the unit word that follows:
 * "26.0K followers" and "2.6 萬位粉絲" give "26.0K" and "2.6 萬". The unit word
 * is localized, so it is never matched beyond the first letter.
 */
const COUNT = /^[\d.,]+\s*(?:[KMB](?![A-Za-z])|萬|万|億|亿)?/;

/** The second `•` segment of a profile's `og:description`: "294 Threads", "175 則串文". */
const THREAD_COUNT = /^\s*([\d.,]+\s*(?:[KMB](?![A-Za-z])|萬|万|億|亿)?)\s*(?:Threads?\b|則串文|串文|スレッド|스레드)/;

/** A count with the platform's non-breaking space ("2.6 萬") turned into a plain one. */
function countText(value: string): string {
  return value.replace(/\u00a0/g, " ").trim();
}

async function parseProfilePage(response: Response): Promise<ProfilePage> {
  const chunks: Record<Field, string[]> = { displayName: [], handle: [], bio: [], followers: [] };
  const sink: { field: Field | null; depth: number } = { field: null, depth: 0 };
  const avatar = { depth: 0 };
  const label = { depth: 0 };
  const page: ProfilePage = {
    unavailable: false,
    displayName: "",
    handle: "",
    avatar: null,
    bio: "",
    followers: "",
    links: [],
  };

  function open(element: Element, field: Field): void {
    sink.field = field;
    sink.depth += 1;
    element.onEndTag(() => {
      sink.depth -= 1;
      if (sink.depth === 0) {
        sink.field = null;
      }
    });
  }

  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      if (hasClass(element, "ErrorText")) {
        page.unavailable = true;
        return;
      }
      if (hasClass(element, "ProfileAvatarContainer")) {
        track(element, avatar);
        return;
      }
      if (hasClass(element, "ProfileDisplayName")) {
        open(element, "displayName");
        return;
      }
      if (hasClass(element, "ProfileUsername")) {
        open(element, "handle");
        return;
      }
      if (hasClass(element, "ProfileBiography")) {
        open(element, "bio");
        return;
      }
      if (hasClass(element, "ProfileFollowerCount")) {
        open(element, "followers");
        return;
      }
      if (hasClass(element, "ProfileBioLinkAnchor")) {
        const url = targetUrl(element.getAttribute("href") ?? "");
        if (url) {
          page.links.push({ label: "", url });
          track(element, label);
        }
        return;
      }
      if (element.tagName === "br" && sink.field !== null) {
        chunks[sink.field].push("\n");
        return;
      }
      if (element.tagName === "img" && avatar.depth > 0) {
        page.avatar ??= httpsUrl(element.getAttribute("src"));
      }
    },
    text(chunk) {
      if (sink.field !== null) {
        chunks[sink.field].push(chunk.text);
      } else if (label.depth > 0 && page.links.length > 0) {
        page.links[page.links.length - 1].label += chunk.text;
      }
    },
  });

  await rewriter.transform(response).arrayBuffer();

  page.displayName = cleanText(chunks.displayName);
  page.handle = cleanText(chunks.handle);
  page.bio = cleanText(chunks.bio);
  page.followers = countText(COUNT.exec(cleanText(chunks.followers))?.[0] ?? "");
  page.links = page.links.map((link) => ({ label: decodeEntities(link.label).trim() || link.url, url: link.url }));
  return page;
}

/**
 * The thread count, which only the profile page's `og:description` carries
 * ("26.0K Followers • 294 Threads • …"). A segment that is not a number
 * followed by a known counter word leaves the count out instead of showing a
 * bio as a number.
 */
async function threadCount(username: string): Promise<string> {
  const response = await threadsGet(`${THREADS_ORIGIN}/@${username}`);
  if (response.status !== 200) {
    await response.body?.cancel();
    return "";
  }
  const meta = await readMeta(response);
  return countText(THREAD_COUNT.exec((meta.get("og:description") ?? "").split("•")[1] ?? "")?.[1] ?? "");
}

function toPost(page: ProfilePage, username: string, threads: string): NormalizedPost {
  const handle = /^[A-Za-z0-9._]+$/.test(page.handle) ? page.handle : username;
  const post: NormalizedPost = {
    title: page.displayName || `@${handle}`,
    siteName: "Threads",
    // 標題已經是顯示名稱，作者那行只留 @handle，不然卡片會把名字顯示兩次。
    author: { name: "", handle, url: `${THREADS_ORIGIN}/@${handle}` },
    text: page.bio,
    media: [],
    createdAt: null,
  };
  if (page.avatar) {
    post.author.avatar = page.avatar;
  }
  if (page.links.length > 0) {
    post.links = page.links;
  }
  const stats: NonNullable<NormalizedPost["stats"]> = {};
  if (page.followers) {
    stats.followers = page.followers;
  }
  if (threads) {
    stats.threads = threads;
  }
  if (Object.keys(stats).length > 0) {
    post.stats = stats;
  }
  return post;
}

export const profileFetcher: Fetcher = {
  name: "profile",
  async run(ref): Promise<UpstreamResult> {
    const username = ref.params.username;
    // 兩頁並行抓：串文數在貼文頁，其他都在 embed 頁。貼文頁失敗就少了串文數，不影響個人頁。
    const [response, threads] = await Promise.all([
      threadsGet(`${THREADS_ORIGIN}/@${username}/embed`),
      threadCount(username).catch(() => ""),
    ]);
    const status = response.status;
    if (status === 404) {
      await response.body?.cancel();
      return { kind: "not_found", httpStatus: status, errorCode: null };
    }
    if (status !== 200) {
      await response.body?.cancel();
      return {
        kind: "transient",
        httpStatus: status,
        errorCode: status >= 300 && status < 400 ? "redirect" : isTransientStatus(status) ? null : "unexpected_status",
      };
    }

    const page = await parseProfilePage(response);
    if (page.unavailable) {
      return { kind: "login_required", httpStatus: status, errorCode: "profile_not_available" };
    }
    if (!page.displayName && !page.handle) {
      return { kind: "transient", httpStatus: status, errorCode: "profile_unparsed" };
    }
    return { kind: "public", httpStatus: status, post: toPost(page, username, threads) };
  },
};
