/**
 * Shared request flow: resolve the reference, run the provider's fetchers in
 * order, persist the outcome and pick the page to serve.
 *
 * A failed fetch never turns into an HTTP redirect to the platform: the
 * platform answers unfurlers with an empty shell, so a redirect would leave
 * the chat client with nothing but the platform name. A status card (or the
 * last stored version) is served instead.
 */

import { hashPost, loadLatestVersion, recordAccess, savePublic } from "./db";
import type { AccessParams } from "./db";
import { renderPostPage, renderStatusPage } from "./page";
import type { NormalizedPost, PostRef, Provider, UpstreamResult } from "./types";

export interface FetchOutcome {
  result: UpstreamResult;
  /** Fetcher that produced `result`, or null when resolving already failed. */
  fetcher: string | null;
  ref: PostRef;
  /** False when `resolve` failed, so `ref` is still the indirect one (for example a share code). */
  resolved: boolean;
}

export interface PageResult {
  html: string;
  status: number;
  /** Seconds the page may be cached; 0 means do not cache. */
  cacheTtl: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRANSIENT_EXCEPTION: UpstreamResult = { kind: "transient", httpStatus: null, errorCode: "exception" };

/**
 * Resolves the reference and runs fetchers until one gives a definite answer.
 * Only `transient` moves on to the next fetcher; a thrown error counts as
 * `transient` and is logged with the fetcher name.
 */
export async function fetchPost(provider: Provider, ref: PostRef, env: Env): Promise<FetchOutcome> {
  let resolved = ref;
  if (provider.resolve) {
    let next: PostRef | UpstreamResult;
    try {
      next = await provider.resolve(ref, env);
    } catch (error) {
      console.error(
        JSON.stringify({ event: "resolve_failed", platform: provider.id, postKey: ref.key, message: errorMessage(error) }),
      );
      next = TRANSIENT_EXCEPTION;
    }
    if ("kind" in next) {
      return { result: next, fetcher: null, ref, resolved: false };
    }
    resolved = next;
  }

  let last: FetchOutcome = {
    result: { kind: "transient", httpStatus: null, errorCode: null },
    fetcher: null,
    ref: resolved,
    resolved: true,
  };
  for (const fetcher of provider.fetchers) {
    let result: UpstreamResult;
    try {
      result = await fetcher.run(resolved, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "fetcher_failed",
          platform: provider.id,
          fetcher: fetcher.name,
          postKey: resolved.key,
          message: errorMessage(error),
        }),
      );
      result = TRANSIENT_EXCEPTION;
    }
    last = { result, fetcher: fetcher.name, ref: resolved, resolved: true };
    if (result.kind !== "transient") {
      break;
    }
  }
  return last;
}

/**
 * Persists access state, and the content version when the post is public.
 * A storage failure must not silently disappear: it is logged with the post
 * identifiers, and the freshly fetched preview is still served because the
 * upstream answer was valid.
 */
async function persist(env: Env, params: AccessParams, post: NormalizedPost | null): Promise<void> {
  try {
    if (post) {
      await savePublic(env.DB, params, post);
    } else {
      await recordAccess(env.DB, params);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "d1_write_failed",
        platform: params.platform,
        postKey: params.postKey,
        status: params.status,
        message: errorMessage(error),
      }),
    );
  }
}

async function readStored(env: Env, platform: string, postKey: string): Promise<NormalizedPost | null> {
  try {
    return await loadLatestVersion(env.DB, platform, postKey);
  } catch (error) {
    console.error(JSON.stringify({ event: "d1_read_failed", platform, postKey, message: errorMessage(error) }));
    return null;
  }
}

/** Fetches, persists and renders one post for the given service origin. */
export async function servePost(provider: Provider, ref: PostRef, origin: string, env: Env): Promise<PageResult> {
  const startedAt = Date.now();
  const outcome = await fetchPost(provider, ref, env);
  const { result } = outcome;
  const canonicalUrl = `${origin}${provider.canonicalPath(outcome.ref)}`;
  const originalUrl = provider.originalUrl(outcome.ref);
  const params: AccessParams = {
    platform: provider.id,
    postKey: outcome.ref.key,
    sourceUrl: originalUrl,
    status: result.kind,
    httpStatus: result.httpStatus,
    errorCode: result.kind === "public" ? null : result.errorCode,
    fetcher: outcome.fetcher,
    startedAt,
    hash: null,
  };

  if (result.kind === "public") {
    params.hash = await hashPost(result.post);
    await persist(env, params, result.post);
    return {
      html: renderPostPage({ provider, canonicalUrl, originalUrl, post: result.post }),
      status: 200,
      cacheTtl: provider.cacheTtl.post,
    };
  }

  // 沒解析出貼文代碼的 share 連結不是一篇貼文，不寫進 posts，也沒有舊版本可讀。
  if (outcome.resolved) {
    await persist(env, params, null);
  }

  if (outcome.resolved && provider.serveStoredWhenUnavailable) {
    const stored = await readStored(env, provider.id, outcome.ref.key);
    if (stored) {
      return {
        html: renderPostPage({ provider, canonicalUrl, originalUrl, post: stored }),
        status: 200,
        cacheTtl: provider.cacheTtl.post,
      };
    }
  }

  const text = provider.statusText[result.kind];
  const transient = result.kind === "transient";
  return {
    html: renderStatusPage({
      provider,
      canonicalUrl,
      originalUrl: result.kind === "not_found" ? null : originalUrl,
      title: text.title,
      description: text.description,
    }),
    status: transient ? 503 : 200,
    cacheTtl: transient ? 0 : provider.cacheTtl.status,
  };
}
