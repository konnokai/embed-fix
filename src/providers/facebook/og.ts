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
 * - profile: `og:title` is the name and `og:image` the profile picture.
 *   `og:description` is `{name}. {n} followers · {n} talking about this. {bio}`;
 *   only the bio is kept. Profiles without one have the sign-up text
 *   `{name} is on Facebook. Join Facebook to connect…`, which is dropped.
 *
 * Pages that need a login redirect to `/login`; `story.php`, `permalink.php`
 * and photo pages always do, even for public posts.
 */

import { decodeEntities, readMeta } from "../../core/html";
import { follow, isTransientStatus } from "../../core/http";
import type { Fetcher, PostRef, UpstreamResult } from "../../core/types";
import {
  DISCORDBOT_USER_AGENT,
  FACEBOOK_ORIGIN,
  NOT_PROFILES,
  facebookGet,
  isFacebookUrl,
  isLoginUrl,
  matchPageUrl,
  postUrl,
} from "./http";

const VIEW_COUNTS = /^[\d.,]+[KMB]? views? · /;

const SIGN_UP_TEXT = " is on Facebook. Join Facebook to connect ";

/** Counters at the start of a profile description, e.g. `121,496,024 followers · 1,137,038 talking about this. `. */
const PROFILE_COUNTS = /^(?:[\d,]+ (?:followers?|following|likes?|talking about this|were here)(?: · |\.\s*|$))+/;

const GROUP_NAME = /"group_name":"((?:[^"\\]|\\.)*)"/;

const GROUP_BANNER = /"group_image_url":"((?:[^"\\]|\\.)*)"/;

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
  return URL.parse(value)?.pathname.split("/").pop() || undefined;
}

/** `/zuck/videos/…` → "zuck"; null for paths without a profile segment. */
function profileName(value: string | undefined): string | null {
  const url = value ? URL.parse(value) : null;
  const first = url?.pathname.split("/")[1] ?? "";
  return first && !first.includes(".") && !NOT_PROFILES.has(first) ? first : null;
}

/** The bio from a profile's `og:description`; empty for the sign-up text or when there are only counters. */
function profileBio(description: string, name: string): string {
  if (description.includes(SIGN_UP_TEXT)) {
    return "";
  }
  // 名稱以 . 結尾時（例如 `CHUNITHM International ver.`），Facebook 不會在名稱後面再加 .。
  const rest = description.startsWith(name) ? description.slice(name.length).replace(/^\.?\s*/, "") : description;
  return rest.replace(PROFILE_COUNTS, "").trim();
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

/**
 * Where the og tags are read and with which UA. From Cloudflare's network
 * (probed 2026-10-21) `/{username}` and group home pages redirect to the login
 * page. Group home pages and profiles with a numeric ID answer on
 * m.facebook.com to Discord's crawler UA; `m.` redirects `/{username}` to the
 * login page even then. For usernames, `/{username}/about` has the same tags;
 * from Cloudflare it answers some of the time and redirects to the login page
 * otherwise (2026-10-26). A post redirected to its author keeps the login
 * result.
 */
function ogSource(ref: PostRef): { start: URL; get: (url: string) => Promise<Response> } {
  const discordbotGet = (url: string) => facebookGet(url, DISCORDBOT_USER_AGENT);
  if (ref.key.startsWith("group-home:")) {
    return { start: new URL(`https://m.facebook.com${ref.params.path}`), get: discordbotGet };
  }
  const profileId = /^profile:(\d+)$/.exec(ref.key)?.[1];
  if (profileId) {
    return { start: new URL(`https://m.facebook.com/profile.php?id=${profileId}`), get: discordbotGet };
  }
  return {
    start: new URL(postUrl(ref)),
    get(url) {
      const target = new URL(url);
      const isPage = ref.key.startsWith("profile:") && matchPageUrl(target);
      return facebookGet(isPage ? `${target.origin}${target.pathname.replace(/\/?$/, "/about")}` : url);
    },
  };
}

export const ogFetcher: Fetcher = {
  name: "og",
  async run(ref): Promise<UpstreamResult> {
    const source = ogSource(ref);
    const response = await follow(source.start, source.get, isFacebookUrl, (target, status): UpstreamResult | null =>
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

    const group: GroupPage = {};
    const isGroup = ref.key.startsWith("group:");
    const meta = await readMeta(response, isGroup ? (rewriter) => readGroup(rewriter, group) : undefined);
    const canonical = URL.parse(meta.get("canonical") ?? "");
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
    const description = meta.get("og:description") ?? meta.get("twitter:description") ?? "";
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
        text: ref.key.startsWith("profile:") ? profileBio(description, name) : description,
        media: image && URL.parse(image)?.protocol === "https:" ? [{ kind: "image", url: image }] : [],
        createdAt: null,
      },
    };
  },
};
