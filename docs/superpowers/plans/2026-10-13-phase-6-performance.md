# Phase 6 — Performance & resilience: implementation plan

Ordered by the user-reported pain from real Nuvio testing (2026-10-13 report):
Home loads varied between 3 and 8 of 13 rows because ~26 AniList calls per Home
burst queue behind the 25/min token bucket, blowing Nuvio's 5 s per-candidate
timeout. Items 1–3 below attack that directly. Each item is an independent
commit; do not batch them.

## Task 1 — Serve stale instead of queueing (the visible fix)

**Behaviour:** when a catalogue request cannot be served fresh *without waiting
on the rate limiter*, return the cached page immediately (stale-serve) and
refresh in the background. Today a stale hit already serves-and-refreshes
(`CatalogService.refreshCatalog`), but a **cold** key waits in the limiter
queue — and after a restart everything is cold, which is exactly when Home
bursts.

**Change:** `TokenBucket` (or `SourceChain`) exposes a non-blocking probe —
`tryReserve(n): boolean` alongside the existing blocking `take(n)`.
`CatalogService.fetchAndStoreCatalog` consults it: if the bucket is empty,
return the stale entry when one exists (any source's key — see the known
limitation comment at `catalog.service.ts:106` about cold-path lookups; this
task also fixes that by trying every source's key, not the predicted one),
otherwise proceed as today. If nothing is cached at all, queue as today —
there is nothing better to serve.

**Tests (watch red first):** limiter empty + warm stale cache → served
instantly (spy: zero upstream calls, freshness 'stale'); limiter empty + no
cache → queues and fetches; limiter has budget → normal fresh fetch. The
existing `known limitation` comment at `catalog.service.ts:106` is deleted by
this change — the comment and the behaviour go together.

## Task 2 — `x-ratelimit-remaining` guard

**Behaviour:** AniList responses carry `x-ratelimit-remaining` (headers are
already captured by `HttpClient` since Phase 1). When a response reports ≤ 3,
the source marks itself exhausted until the reset time, and `fetchPage` serves
stale or returns empty without touching AniList.

**Change:** `AniListSource` records the header per response; a small
`RateLimitState` (remaining + resetAt) gates the adapter before it builds a
request. The chain's existing error taxonomy gains nothing — this is a *pre*
-request check, not a new error kind.

**Tests:** response with remaining ≤ 3 → next `fetchPage` makes zero upstream
calls and serves stale/empty; remaining > 3 → normal; reset time passed →
fetches again. Use the captured-header plumbing in `HttpClient`; no clock
faking — inject `now` as elsewhere in this repo.

## Task 3 — TTL retune

**Change:** per-catalogue TTL on `CatalogDefinition` (`ttlMs?`, `staleMs?`),
defaulting to today's 15 min / 6 h. Slow-changing rows — top-rated, popular,
movies, ova, genres — go to 24 h fresh / 7 d stale. Airing, recent, seasonal,
search keep short TTLs. `CatalogService` reads them per request.

**Tests:** each slow-changing catalogue's stored entry carries the long TTL
(spy on `cache.set`); airing/search keep the short one. Constants stay exported
(`CATALOG_TTL_MS` remains the default, so existing importers do not break).

## Task 4 — Prewarm at startup

**Change:** after `createApp` builds the services, fire-and-forget one
`getCatalogPage` per feed catalogue (not search), errors swallowed. Log a single
summary line. Must not delay `listen()` — kick it off after the server binds.

**Tests:** app start triggers one cache-fill per feed catalogue (spy on
`getCatalogPage`), and a throwing catalogue does not reject startup.

## Task 5 — Suite hygiene (unblocks trusting CI)

The Kitsu per-attempt-timeout test (`test/kitsu-adapter.test.ts`) has flaked
under parallel load across three sessions (passes in isolation). Root-cause it
— most likely shared module state or a 5 s timer colliding with parallel
workers — and fix it properly, or split it into its own file with
`pool: 'forks'` config. Do this BEFORE relying on CI for tasks 1–4.

## Non-goals (explicit)

- No disk/Redis cache layer yet — measure the hit rate after Tasks 1–3 first
  (the roadmap gate needs 24 h of data anyway).
- No AniList rate-limit-raise request until Task 3 shows steady-state counts.
- No change to the meta 404/fall-through behaviour shipped at `5ee0af9`.

## Definition of done

`unshare -n -- npm test` green; typecheck 0; lint 0. Live check for Task 1:
restart the server, immediately load Home in Nuvio — all 13 rows render from
stale cache while refreshes run.
