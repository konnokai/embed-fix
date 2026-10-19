/**
 * Second Threads fetcher: the post page's own Open Graph tags.
 *
 * Only a title and a generated card image are available here (no text as of
 * 2026-10-03), so this layer is used when the embed page fails. A login-only
 * post still answers 200 but without `og:title`, and its `og:url` has an empty
 * username (`/@/post/{code}`).
 */

import { follow, isTransientStatus } from "../../core/http";
import { readMeta } from "../../core/html";
import type { Fetcher, UpstreamResult } from "../../core/types";
import { createdAtFromCode } from "./code";
import { isThreadsUrl, parsePostUrl, THREADS_ORIGIN, threadsGet } from "./http";

/** "Adam Mosseri (@mosseri) on Threads" → name and handle. */
const OG_TITLE = /^(.*?)\s*\(@([A-Za-z0-9._]+)\)\s+on Threads$/;

export const ogFetcher: Fetcher = {
  name: "og",
  async run(ref): Promise<UpstreamResult> {
    const path = ref.params.username
      ? `/@${ref.params.username}/post/${ref.params.code}`
      : `/t/${ref.params.code}`;
    const response = await follow(new URL(path, THREADS_ORIGIN), threadsGet, isThreadsUrl);
    if (!(response instanceof Response)) {
      return response;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { kind: "not_found", httpStatus: 404, errorCode: null };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return {
        kind: "transient",
        httpStatus: response.status,
        errorCode: isTransientStatus(response.status) ? null : "unexpected_status",
      };
    }

    const meta = await readMeta(response);
    const title = meta.get("og:title");
    const postUrl = parsePostUrl(meta.get("og:url") ?? meta.get("canonical") ?? "");
    if (!title) {
      return postUrl && postUrl.username === ""
        ? { kind: "login_required", httpStatus: 200, errorCode: "og_empty_username" }
        : { kind: "transient", httpStatus: 200, errorCode: "og_unparsed" };
    }

    const named = OG_TITLE.exec(title);
    const handle = named?.[2] ?? postUrl?.username ?? ref.params.username ?? "";
    const image = meta.get("og:image");
    return {
      kind: "public",
      httpStatus: 200,
      post: {
        title: handle ? `@${handle}` : title,
        siteName: "Threads",
        author: {
          name: named?.[1] ?? "",
          ...(handle ? { handle, url: `${THREADS_ORIGIN}/@${handle}` } : {}),
        },
        text: meta.get("og:description") ?? "",
        media: image ? [{ kind: "image", url: image }] : [],
        createdAt: createdAtFromCode(ref.params.code),
      },
    };
  },
};
