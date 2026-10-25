# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ebfix: a Cloudflare Worker that takes a post URL from Naver Cafe, Threads, Facebook or Instagram (same path, swapped domain) and answers with Open Graph HTML plus a Discord Components V2 payload, so chat unfurlers get a preview without running scripts.

**This project is live** (`ebfix.konnokai.me`, `fb.ebfix.konnokai.me`, `ig.ebfix.konnokai.me`, legacy `cafe.konnokai.me`) with real Discord users and production D1 data. Old links must keep working; schema changes go through new numbered files in `migrations/`.

`README.md` (Chinese) is the source of truth for per-platform behavior, routing collisions, cache TTLs, DB schema, deploy and backup. Read the relevant section before changing behavior, and update it in the same change. `docs/*_EMBED_FIX_PLAN.md` hold upstream investigation results (dated measurements; upstream may have changed since).

## Commands

```bash
npm test                                   # vitest in the Workers runtime (Miniflare), local D1 with real migrations
npx vitest run test/providers/threads/worker.test.ts   # one file
npx vitest run -t "serves a public post"   # tests by name
npm run typecheck                          # tsc --noEmit
npm run types                              # regenerate worker-configuration.d.ts after wrangler.jsonc changes
npx wrangler dev --test-scheduled          # local dev; GET /__scheduled runs the health check
npx wrangler d1 migrations apply naver-cafe-embed-fix --local
```

Deploy is automatic from `main` via Cloudflare Workers Builds. It does **not** apply D1 migrations (its token has no D1 permission): remote migrations are run by hand with `--remote`. The Worker and D1 names stay `naver-cafe-embed-fix`; renaming creates a different Worker.

## Architecture

Request flow (`src/index.ts`):
1. `/` on any host except the legacy one → home page (`src/core/home.ts`, reads health status from D1).
2. `route()` in `src/router.ts`: the hostname picks the allowed providers (`HOST_PROVIDERS`, default `PROVIDERS`), then each provider's `match(url)` is tried **in order**. Order resolves path collisions on the shared domain (e.g. Facebook's numeric `/reel/{id}` before Instagram's). No match → 400, no upstream request.
3. Cache API lookup keyed by `origin + provider.canonicalPath(ref)`; the query string is never forwarded or cached.
4. `servePost()` in `src/core/pipeline.ts`: `provider.resolve` (share links → direct ref), then `provider.fetchers` in order. Only a `transient` result falls through to the next fetcher; a thrown error is logged as `fetcher_failed` and counted as `transient`.
5. Public result → saved to D1 (`posts` + `post_versions`, `src/core/db.ts`) and rendered by `renderPostPage` (`src/core/page.ts`). Non-public → if `serveStoredWhenUnavailable`, the last stored version is served; otherwise a status card (HTTP 200 so Discord can read it; `transient` → 503 + `no-store`).

Rules that hold across the codebase:
- A failed fetch never becomes an HTTP redirect to the platform (the platform gives unfurlers an empty shell). Browsers get a `meta refresh` instead.
- Every provider is a `Provider` object (`src/core/types.ts`) that normalizes to `NormalizedPost`. Adding a platform = new folder in `src/providers/` + entry in `PROVIDERS`. The usual provider layout is `index.ts` (Provider + path regexes), `http.ts` (origin, path helpers), `share.ts` (resolver built on `resolveShareLink` in `src/core/http.ts`), then one file per fetcher layer (`embed`/`plugin`, `og`).
- Upstream requests are anonymous: no cookies, always `USER_AGENT` from `src/core/http.ts` (without it Threads redirects to an unsupported-browser page). The exceptions are Facebook group home pages and profiles with a numeric ID, which answer reliably from Cloudflare's network only on `m.facebook.com` with Discord's crawler UA (README, Facebook).
- HTML parsing uses `HTMLRewriter` with helpers in `src/core/html.ts`.
- The home page's in-browser URL converter (`src/core/home.ts`) duplicates the host mapping and Facebook's kept query params (`KEPT_PARAMS` in `src/providers/facebook/http.ts`). Change both together.
- `hashPost` in `src/core/db.ts` decides when a new `post_versions` row is written. Adding a field to the hash changes every post's hash and adds a version on the next fetch; add new fields only when present, like `topic`.
- D1 calls on the request path go through `waitForD1` (`src/core/db.ts`, `D1_WAIT_MS`): the binding has no timeout, and during a D1 outage one query can hang for minutes. Writes keep running in `ctx.waitUntil` after the wait gives up (at most 30 s after the response, then the runtime cancels them). The cron batches its `health_state` reads and writes instead.
- The Cache API only works on Custom Domains, so `wrangler dev` and workers.dev never hit the cache.
- `page.ts` keeps the Discord payload under `PAYLOAD_LIMIT` (3000 bytes): it trims text first, then drops parts in a fixed order. Check `test/core/page.test.ts` when changing it.
- The `scheduled` handler (hourly cron) runs each provider's fetchers on every `healthCheckPaths` entry (no D1 post writes; the first path drives the home page status), records results in `health_state`, and posts to the optional `HEALTH_WEBHOOK_URL` secret only on an ok → failing transition (`src/core/health.ts`, `src/core/notify.ts`). `HEALTH_WEBHOOK_URL` is declared by hand in `src/env.d.ts` because `wrangler types` cannot see secrets.

## Tests

- Tests run inside the Workers runtime via `@cloudflare/vitest-plugin`; `cloudflare:workers` gives `env` and `exports.default.fetch` for end-to-end requests.
- Upstream is never called: `test/providers/threads/stub.ts` (`stubFetch`, `html`, `redirect`) replaces global `fetch` and is shared by all provider and core tests.
- Parsers are tested against real captured pages in `test/providers/*/fixtures/` (imported with `?raw`). New upstream formats get a new captured fixture, not a hand-written one. Strip scripts (Instagram embeds keep only the `contextJSON` script) and keep only `<head>` of full post pages. Upstream answers differ between a home network and Cloudflare's egress; Facebook fixtures come from the egress, and the README's fixture list records where each set came from.
- The Cache API persists between tests, so worker tests use a unique post code per test. `resetDatabase()` in `test/helpers.ts` also wipes Cache API storage, which races with cache writes still running in `waitUntil`; worker tests that hit the cache avoid calling it.

## Conventions

- User-facing text (status cards, home page) and README are Traditional Chinese.
- Structured logs are `console.error(JSON.stringify({ event: "...", ... }))`.
