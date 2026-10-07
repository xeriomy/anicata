# Phase 2 Design — Source abstraction and fallback

**Date:** 2026-10-07
**Status:** Draft for review
**Supersedes:** the Phase 2 section of `docs/roadmap.md` (scope narrowed — see below)

## Goal

When AniList fails, users still get content. Catalogue and metadata each need a
fallback path, and the response must still arrive inside Nuvio's 5-second meta
budget.

## Scope change from the roadmap

The roadmap specified `AniList → Kitsu → Jikan`, with Jikan opt-in behind
`ENABLE_JIKAN`. **Jikan is removed.**

Re-verified 2026-10-07: `api.jikan.moe` is TCP-silent on ports 80 and 443, over
IPv4 *and* IPv6, and by direct IP (`135.181.39.91`) with DNS bypassed — while
`jikan.moe` and `docs.api.jikan.moe` both answer HTTP 200. Only the API host is
gone, which rules out a local network fault. The cause is that **Jikan's public
API was discontinued on 2026-10-01**, announced in June 2026 on their Discord
and corroborated by independent reports in `jikan-me/jikan-rest`.

It is removed outright rather than kept behind a flag because our own rule is
that fixtures must be real API captures. A dead service yields either fabricated
fixtures or an untested adapter, and both are worse than absence.

**Tenrai** (`https://api.tenrai.org/v1`), the announced successor, is alive and
Jikan-v4-shaped — verified HTTP 200 in ~460 ms. Not adopted: young service, no
uptime record, and redundant with Kitsu's MAL-derived data. Recorded as the
candidate if a third source is ever justified by evidence.

`ADR-004` is amended accordingly. `docs/data-sources.md` and `docs/roadmap.md`
are updated.

## Verified characteristics of the fallback source

All probed live on 2026-10-07, not taken from documentation:

| Property | Value |
|---|---|
| Base URL | `https://kitsu.io/api/edge` |
| Media type header | `Accept: application/vnd.api+json` (required) |
| Envelope | `{ data, included, links, meta }` — JSON:API |
| Latency | ~450–640 ms |
| `average_rating` | `"82.27"` — **string**, not number |
| Titles | `titles: { en, en_jp, ja_jp, ... }`, plus `canonicalTitle` |
| Genres | require `?include=genres`; arrive in `included`, not on the record |
| `sort` accepted | `average_rating`, `-averageRating`, `userCount`, `-userCount`, `popularityRank` |
| `sort` rejected (400) | `trending`, `recently_popular`, `relevance`, `title`, `favorites` |
| Search | `?filter[text]=<term>` |

**Catalogue mapping.** Two of three map exactly; the third has no equivalent:

| Catalogue | AniList | Kitsu | Fidelity |
|---|---|---|---|
| `anime-top-rated` | `SCORE_DESC` | `sort=-averageRating` | exact |
| `anime-search` | `SEARCH_MATCH` | `?filter[text]=` | exact |
| `anime-trending` | `TRENDING_DESC` | `sort=-userCount` | **proxy** |

Kitsu exposes no trending sort. Per decision, the Trending catalogue falls back
to most-favorited (`-userCount`): a blank row reads as broken, and both signals
are forms of popularity, so the content is thematically right even though the
label is not literally accurate during an outage. **This is a deliberate,
documented approximation** — recorded here so nobody later mistakes it for an
exact mapping.

## Architecture

```
       ┌─────────────────────────────────────────────┐
Nuvio ─┤  src/addon/     protocol layer              │
       │  catalog.ts · meta.ts                       │
       └───────────────────┬─────────────────────────┘
                           │  depends on a structural port
       ┌───────────────────▼─────────────────────────┐
       │  src/services/   orchestration             │
       │  SourceChain · per-capability resolution    │
       └───────────────────┬─────────────────────────┘
                           │  picks a source, enforces the deadline
       ┌───────────────────▼─────────────────────────┐
       │  src/sources/    adapters                   │
       │  anilist/ · kitsu/                          │
       │  each: fetchCataloguePage · fetchById       │
       │        · search                             │
       └───────────────────┬─────────────────────────┘
                           │
       ┌───────────────────▼─────────────────────────┐
       │  src/net/        http · limiter · breaker   │
       │  src/cache/      TTL cache (SWR)            │
       └─────────────────────────────────────────────┘
```

New in this phase:

- **`src/sources/types.ts`** — the `AnimeSource` port. Phase 1 already made
  services depend on a structural type (`{ fetchById(id): Promise<Anime|null> }`)
  rather than a concrete adapter; this names that shape and widens it to the
  three capabilities. Adapters implement it; services consume it; the chain
  selects among them.
- **`src/sources/chain.ts`** — `SourceChain`. Owns source selection, the shared
  deadline, and the rule for which failures permit fallback.
- **`src/net/breaker.ts`** — circuit breaker. A source failing repeatedly is
  skipped without a network call, so a dead primary costs no latency.

## The deadline

Nuvio's `MetaDetailsRepository` has `FETCH_TIMEOUT_MS = 5_000L`. Our per-request
upstream timeout is capped at 4000 ms by config. A naive sequential fallback
could therefore take 8 s — more than Nuvio's entire budget — and Nuvio would
time out and skip the add-on, which is the exact failure Phase 1's
error-containment design exists to prevent.

**Decision: one wall-clock deadline per request.**

- Created once, at handler entry, with a total budget of 4000 ms — deliberately
  under Nuvio's 5000 ms so serialization and network transit still fit.
- Each source is handed the *remaining* budget, never a fresh one.
- If the budget is exhausted, no further source is attempted and stale data is
  served.
- Every await in the chain respects the deadline; a source cannot overrun it.

Rejected: racing both sources concurrently (doubles upstream volume against
AniList's 30 req/min, for requests Nuvio fans out per search); fixed per-source
sub-timeouts (no hard guarantee if a source overruns, and wastes budget when the
primary is healthy).

## Which failures permit fallback

Extends ADR-011, which established that only transient failures trigger fallback.

| From primary | Fall back? | Reason |
|---|---|---|
| `server_error` (5xx) | **yes** | upstream is unwell; another operator may be fine |
| `timeout` | **yes** | same |
| `network` | **yes** | same |
| `parse` | **yes** | the primary returned something unusable |
| `rate_limited` (429) | **no** — serve stale | our own budget is exhausted; another source cannot help, and calling it wastes the deadline |
| `not_found` (404) | **no** | a genuinely absent title is a valid answer |
| empty result | **no** | zero results is data, not failure |

The 404 row is the subtle one: falling back on 404 would resurrect titles that do
not exist, and would fire a pointless upstream call for every miss.

## Source consistency within a catalogue

Two mechanisms, each independently testable.

**1. Cache keys gain a source segment.** Today the key is
`catalog:${catalogId}:${genre}:${skip}` with no source in it, so a cached AniList
page and a fresh Kitsu page merge seamlessly into one scrolling catalogue. New
keys are `catalog:${source}:${catalogId}:${genre}:${skip}`.

**2. The selected source is sticky per catalogue for 10 minutes.** Without this,
scrolling mixes sources: each 100-item Nuvio page costs 2 AniList requests
(`perPage` clamps to 50), so ~15 rows exhaust the 30/min budget *mid-scroll*.
Page 16 would come from Kitsu and the user would scroll through two different
databases — near-duplicate titles under different ids, and three wasted pages
against Nuvio's `DUPLICATE_CATALOG_PAGE_ADVANCE_LIMIT = 3`.

Stickiness is per `(catalogueId, genre)`, not global: a fallback affecting
Trending must not also redirect Top Rated.

## Circuit breaker

Per source. States: `closed` → `open` → `half-open`.

- **closed** — normal. Count consecutive failures (only fallback-eligible ones).
- **open** — threshold reached (default: 5). The source is skipped **without a
  network call**, so a dead primary costs no latency.
- **half-open** — after a cooldown (default: 30 s), one probe request is allowed.
  Success closes the breaker; failure reopens it.

A success resets the failure count. `not_found` and `rate_limited` are not
failures — a source answering 404 is a *healthy* source.

This matters more than it would with a longer chain: with only one fallback, the
breaker is what stops every request paying a doomed AniList timeout first.

## Behaviour by scenario

| Scenario | Behaviour |
|---|---|
| AniList healthy | unchanged from Phase 1 |
| AniList 5xx / timeout | breaker counts; Kitsu serves, within the remaining deadline |
| AniList 429 | stale AniList data served; **zero** Kitsu calls |
| AniList 404 (single title) | minimal meta `"Unavailable"`; **zero** Kitsu calls |
| AniList returns 0 results | empty page returned; **zero** Kitsu calls |
| AniList breaker open | Kitsu serves immediately; no AniList call at all |
| AniList + Kitsu both down | stale (up to 6 h) or empty; **never 5xx** |
| Deadline exhausted | whatever is cached, else empty; **never 5xx** |

## Id spaces

A Kitsu-sourced catalogue emits `kitsu:<id>` ids. Phase 1 already declares
`idPrefixes: ["anilist:", "kitsu:"]` in the manifest, so Nuvio routes both to us
— that declaration was made in Phase 1 precisely so this phase needs no manifest
change.

**Phase 1 deliberately returns "Unavailable" for `kitsu:` ids** rather than
pretending to resolve them. Phase 2 must implement Kitsu meta resolution, or
fallback catalogues would list titles whose details pages are empty.

## Testing

**Fixtures are real captures only.** Recorded from the live APIs on 2026-10-07,
committed alongside the existing AniList captures. No fabricated responses.

**Shared contract suite.** Both adapters run the same tests, parameterised. Each
adapter must satisfy:

- `fetchById` returns a fully-populated `Anime` for a known id
- `fetchById` returns `null` for an unknown id — **not** a throw (AniList
  answers 404; the adapter maps it, per the Phase 1 fix)
- `fetchCataloguePage` honours `skip` and returns `perPage` items
- `search` returns results for a known title and an empty page for nonsense
- every field maps to the same `Anime` shape as AniList's, for equivalent input
- an unreachable host yields `network`, not an unhandled rejection

**Snapshot equality.** For a title present in both sources, both adapters must
produce an identical `Anime`. Any divergence is a normalisation bug in one of
them, and the snapshot is what catches it.

**Chain tests** (the substance of this phase), all with injected fakes:

- AniList 500 → Kitsu-sourced page, comparable item count
- AniList 429 → stale served, Kitsu spy shows **zero** calls
- AniList 404 → no fallback call
- AniList empty → no fallback call
- AniList + Kitsu both fail → stale, never 5xx
- breaker opens after 5 failures, and the 6th request makes **zero** AniList calls
- a slow source cannot exceed the deadline
- catalogue cache keys are source-namespaced, and stickiness holds for 10 minutes

**Live suite** extended with opt-in Kitsu cases (`ANICATA_LIVE=1`): Kitsu
reachable, trending proxy returns items, search returns results.

## Exit gates

- [ ] Both adapters pass the same contract test suite
- [ ] Snapshot equality for a title present in both sources
- [ ] AniList 500 → Kitsu-sourced catalogue, comparable item count
- [ ] AniList 429 → stale served, **zero** fallback calls (asserted with a spy)
- [ ] AniList 404 → **zero** fallback calls
- [ ] Empty result → **zero** fallback calls
- [ ] AniList + Kitsu down → stale (up to 6 h), never 5xx
- [ ] Breaker opens after threshold; subsequent requests make zero primary calls
- [ ] A slow source cannot exceed the deadline
- [ ] Cache keys are source-namespaced; stickiness prevents mid-scroll mixing
- [ ] Every response still 200, still ≤ 5 s
- [x] Jikan removed from the chain → zero impact by construction

## Out of scope

Streaming, watch progress, user accounts, genres (Phase 5), TMDB/AniZip
(Phases 3–4), `/configure` (Phase 8), deployment and TLS (Phase 8).

## Open questions for implementation

1. **Breaker thresholds** — 5 failures / 30 s cooldown are proposals. They need
   load-shaped reasoning once Kitsu latency is measured under our own limiter.
2. **Stickiness storage** — an in-process `Map` is sufficient for a single
   instance, but ADR-013 chose a long-running container, so a restart clears it.
   Acceptable; worth noting.
3. **`sort=-userCount` as a trending proxy** — verified to work, but whether it
   is *good enough* is a judgement best made after seeing it rendered in Nuvio.
