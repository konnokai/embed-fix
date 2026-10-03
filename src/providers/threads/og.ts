/**
 * Second Threads fetcher: the post page's own Open Graph tags.
 *
 * Only a title and a generated card image are available here (no text as of
 * 2026-10-03), so this layer is used when the embed page fails. A login-only
 * post still answers 200 but without `og:title`, and its `og:url` has an empty
 * username (`/@/post/{code}`).
 */

import { decodeEntities } from "../../core/html";
import type { Fetcher, UpstreamResult } from "../../core/types";
import { getFollowingThreads, isTransientStatus, parsePostUrl, THREADS_ORIGIN } from "./http";

/** Reads `og:*` meta tags and the canonical link from a page head. */
export async function readMeta(response: Response): Promise<Map<string, string>> {
  const meta = new Map<string, string>();
  const rewriter = new HTMLRewriter()
    .on("meta[property]", {
      element(element) {
        const property = element.getAttribute("property");
        const content = element.getAttribute("content");
        if (property?.startsWith("og:") && content !== null && !meta.has(property)) {
          meta.set(property, decodeEntities(content));
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

/** "Adam Mosseri (@mosseri) on Threads" → name and handle. */
const OG_TITLE = /^(.*?)\s*\(@([A-Za-z0-9._]+)\)\s+on Threads$/;

export const ogFetcher: Fetcher = {
  name: "og",
  async run(ref): Promise<UpstreamResult> {
    const path = ref.params.username
      ? `/@${ref.params.username}/post/${ref.params.code}`
      : `/t/${ref.params.code}`;
    const fetched = await getFollowingThreads(new URL(path, THREADS_ORIGIN));
    if (fetched.kind === "redirect_rejected") {
      return { kind: "transient", httpStatus: fetched.httpStatus, errorCode: "redirect_rejected" };
    }
    const { response } = fetched;
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
        author: { name: named?.[1] ?? "", handle: handle || undefined },
        text: meta.get("og:description") ?? "",
        media: image ? [{ kind: "image", url: image }] : [],
        createdAt: null,
      },
    };
  },
};
