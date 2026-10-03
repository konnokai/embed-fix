/**
 * Types shared by the router, the pipeline and every platform provider.
 */

export type AccessStatus = "public" | "login_required" | "not_found" | "restricted" | "transient";

export type FailureStatus = Exclude<AccessStatus, "public">;

export interface MediaItem {
  kind: "image" | "video";
  url: string;
  width?: number;
  height?: number;
}

/** One post in a platform-neutral shape; this is what gets rendered and stored. */
export interface NormalizedPost {
  title: string;
  /** Upstream site or community name; may be empty, the provider default is used then. */
  siteName: string;
  /** `url` is the author's profile page, when the platform has one. */
  author: { name: string; handle?: string; avatar?: string; verified?: boolean; url?: string };
  /** Topic or community tag shown next to the author (Threads). */
  topic?: string;
  text: string;
  media: MediaItem[];
  /** Counts as the platform displays them ("5.9K"); the exact numbers are not published. */
  stats?: { likes?: string; replies?: string; reposts?: string; shares?: string };
  /** ISO 8601, or null when the upstream gives no machine-readable time. */
  createdAt?: string | null;
  replyTo?: { handle: string; text: string };
  quoted?: { handle: string; text: string; media: MediaItem[] };
}

export type UpstreamResult =
  | { kind: "public"; post: NormalizedPost; httpStatus: number | null }
  | { kind: FailureStatus; httpStatus: number | null; errorCode: string | null };

/** A post identified from the request path. `key` is unique per platform. */
export interface PostRef {
  key: string;
  params: Record<string, string>;
}

export interface Fetcher {
  /** Logged and stored so a result can be traced to the layer that produced it. */
  name: string;
  run(ref: PostRef, env: Env): Promise<UpstreamResult>;
}

export interface StatusText {
  title: string;
  description: string;
}

export interface Provider {
  id: string;
  /** Default `og:site_name` when the post itself carries none. */
  siteName: string;
  /** `<html lang>` of rendered pages. */
  lang: string;
  /** Text of the in-page link back to the original post. */
  originalLinkText: string;
  /** Returns null when the path does not belong to this provider. */
  match(url: URL): PostRef | null;
  /** Turns an indirect reference (for example a share link) into a direct one. */
  resolve?(ref: PostRef, env: Env): Promise<PostRef | UpstreamResult>;
  fetchers: Fetcher[];
  originalUrl(ref: PostRef): string;
  /** Path of the canonical service URL for a resolved reference. */
  canonicalPath(ref: PostRef): string;
  statusText: Record<FailureStatus, StatusText>;
  /** Cache API lifetimes in seconds; 0 disables caching. Transient results are never cached. */
  cacheTtl: { post: number; status: number };
  serveStoredWhenUnavailable: boolean;
  /** A known public post path used by the scheduled health check. */
  healthCheckPath?: string;
}
