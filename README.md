# AniCata — anime catalog add-on for Nuvio

AniCata is a [Stremio-protocol](https://github.com/Stremio/stremio-addon-sdk)
catalog + metadata add-on that serves anime catalogues and detail pages from
**AniList**, installable in [Nuvio](https://nuvioapp.com) (a Stremio-compatible
client) via a manifest URL.

**What it is:** three browse/search catalogues and a meta handler — posters,
synopses, genres, ratings, links.

**What it is not:** not a streaming add-on (no sources, no playback), not
watch progress, not user lists, not an account system. There is no auth, no
database, no user context of any kind. Watch state and lists are Nuvio's job
(via Trakt / Simkl / MDBList) — this add-on stays out of the way so Nuvio's
own tracking "just works" (see [The `anilist:` id scheme](#the-anilist-id-scheme)).

> Status: Phase 2 (AniList primary, Kitsu fallback). TMDB enrichment, AniZip
> episodes, genre catalogues and deployment land in Phases 3–8 per
> [`docs/roadmap.md`](docs/roadmap.md).

---

## Install

Paste the manifest URL into Nuvio's add-on installer:

```
https://<host>/manifest.json
```

Locally that is `http://127.0.0.1:7000/manifest.json` (port from `PORT`,
default `7000`). Nuvio fetches this URL, reads the catalogue list, and calls
back for catalog pages and meta. No configuration page, no API keys, no
sign-up — `behaviorHints` declares `configurable: false`.

> `?titleLang=` is **not a working option.** `parseRequestConfig`
> (`src/config/index.ts`) exists and is unit-tested, but the SDK router
> discards the manifest URL's query string before any handler sees it, so
> `?titleLang=native` currently has no effect and the title language always
> falls back to `'english'`. Wiring it is deferred to Phase 8. Do not
> advertise it.

---

## Catalogues

Three catalogues, all of `type: 'anime'`, built from `CATALOG_DEFS`
(`src/sources/catalog-def.ts`) and emitted into the manifest by
`buildManifest` (`src/addon/manifest.ts`):

| Catalogue id    | Name              | AniList sort     | `extra`               |
|-----------------|-------------------|------------------|-----------------------|
| `anime-trending`  | Trending Anime  | `TRENDING_DESC`  | `skip`                |
| `anime-top-rated` | Top Rated Anime | `SCORE_DESC`     | `skip`                |
| `anime-search`    | Search Anime     | `SEARCH_MATCH`   | `skip`, **`search`**  |

`search` is declared on **exactly one** catalogue on purpose: Nuvio fans a
search out to *every* searchable catalogue, so declaring it on more would
multiply upstream requests per keystroke against AniList's 30 req/min budget
(ADR-007). `skip` on all three enables Nuvio's pagination (pages of exactly
100 items, stitched from two AniList pages of 50 — ADR-008).

---

## The `anilist:` id scheme

Every id this add-on emits looks like `anilist:21` (see `stremioIdFor` in
`src/domain/anime.ts`). This is the single most important design decision
(ADR-001):

- Nuvio parses the `anilist:` prefix and classifies such titles as anime,
  which engages its **Simkl anime tracking** — with zero tracking code on our
  side.
- **Never a bare number.** Nuvio reads an unprefixed number as a Trakt id, so
  emitting one would resolve the wrong title. Inbound bare numbers are
  rejected with zero upstream calls (`parseMetaId` in `src/addon/meta.ts`).
- `idPrefixes: ['anilist:', 'kitsu:']` is declared on the manifest and the
  `meta` resource, so Nuvio only consults us for ids we mint. Catalogue rows
  normally emit `anilist:` ids; rows served from the Kitsu fallback emit
  `kitsu:` ids (`stremioIdFor` in `src/domain/anime.ts` renders whichever
  identity the serving source returned). **Both namespaces resolve** through
  `/meta` (`parseMetaId` in `src/addon/meta.ts`, namespace routing in
  `SourceChain.fetchById` in `src/sources/chain.ts`).

---

## Fallback: AniList → Kitsu

One ordered chain, built in `src/index.ts`: `SourceChain([anilist, kitsu])`
with one `CircuitBreaker` per source and a shared `budgetMs` derived from
`HTTP_TIMEOUT_MS` (clamped ≤ 4000 ms): `min(httpTimeoutMs + 500, 4500)`, which
stays inside Nuvio's 5000 ms meta budget with 500–1000 ms of headroom for
serialisation and transit.

- A throwing AniList falls through to Kitsu, as does one that dies by HTTP
  timeout: the chain budget strictly exceeds the per-attempt timeout, and each
  attempt is bounded by the deadline's remaining budget (threaded through
  `PageRequest.timeoutMs` into the adapters' HTTP calls), so a timeout death
  leaves ~500 ms for the fallback. A source that hangs forever with no inner
  timeout still exhausts the shared deadline and degrades to empty — still
  HTTP 200. `429`/`404`/`invalid_request` never fall through (the source
  answered, so it is healthy — `permitsFallback`
  in `src/sources/fallback-policy.ts`).
- **Trending degrades to most-favorited during an AniList outage, and that is a
  deliberate approximation, not an exact mapping.** Kitsu has no trending sort:
  `trending`, `recently_popular`, `relevance`, `title` and `favorites` are all
  rejected with HTTP 400, so the trending catalogue is proxied onto
  `sort=-userCount` (`kitsuSort` in `src/sources/kitsu/adapter.ts`). A blank
  trending row reads as broken; an approximately-popular one does not.
- **Jikan is gone and is not a fallback.** Its public API was discontinued on
  2026-10-01; there is no Jikan adapter, no Jikan code path, and none planned
  (see roadmap Phase 2 scope and ADR-004).
- The no-5xx invariant holds through the chain: a dead primary still yields
  HTTP 200 on every catalogue, search and meta path (proven by
  `test/integration.test.ts` → "fallback chain wiring").

---

## Architecture

What actually exists in Phase 2 (see `docs/architecture.md` for the full
multi-phase design — several layers there are not built yet):

```
Nuvio ──► express + SDK router ──► addon/ ──► services/ ──► SourceChain ──► anilist
            src/index.ts            manifest     CatalogService       │       (GraphQL)
                                    catalog      MetaService         │
                                    meta              │             └─► kitsu
                                                      ▼               (JSON:API)
                                                  cache/store
                                                  TTLCache
                                                  (single-flight)
```

One-line layer summary:

- **`src/index.ts`** — composition root: builds config, HTTP client, limiter,
  cache, the `SourceChain([anilist, kitsu])` with per-source breakers, and
  services; mounts `public/` (logo), a 24 h
  `Cache-Control` on `/manifest.json`, and the SDK router. Importing it never
  binds a port; only `node dist/index.js` listens.

  `public/logo.png` is generated, not hand-drawn: run
  `node scripts/generate-logo.mjs` to rebuild it. It is a 512×512 PNG written
  directly with Node's built-in `zlib`, so the project needs no image
  dependency. Do not replace it with a placeholder — a 1×1 PNG satisfies every
  plumbing assertion (`200`, `image/png`, non-empty) and renders as an empty
  tile in Nuvio's add-on list, which is exactly the bug that shipped once.
- **`src/addon/`** — protocol layer only: manifest builder (+ 8 KB size
  assertion), catalog handler (parses `skip`/`search` extras), meta handler
  (parses `anilist:<id>` and `kitsu:<id>`, never returns non-200).
- **`src/services/`** — orchestration: page stitching, search, meta lookup,
  and the cache/error policies (empty → short cache, failure → valid empty
  body, never 5xx).
- **`src/sources/anilist/`** — primary upstream adapter: GraphQL documents,
  response types, and `AniListSource` (`fetchPage`, `search`, `fetchById`).
  Translates into our domain, never exposes AniList shapes upward.
- **`src/sources/kitsu/`** — fallback upstream adapter: JSON:API types, URL
  builders, and `KitsuSource` (same `AnimeSource` port; trending proxied onto
  `sort=-userCount`, see Fallback above).
- **`src/sources/chain.ts`** — `SourceChain`: ordered sources, per-source
  breakers, shared deadline, sticky fallback, namespace-routed `fetchById`.
- **`src/domain/`** — our own `Anime` / `AnimeIdentity` types plus
  `stremioIdFor`. Depends on nothing.
- **`src/normalize/`** — AniList `Media` → `Anime` (status/format mapping,
  HTML stripping, title resolution).
- **`src/render/`** — `Anime` → Stremio `MetaPreview` / `MetaDetail`
  (posters, `country`+`countryOfOrigin`, AniList/MAL `links[]`,
  always-empty `videos[]`).
- **Cross-cutting** — `src/net/http.ts` (`HttpClient`: timeout, `User-Agent`,
  header capture), `src/net/limiter.ts` (`TokenBucket`), `src/cache/store.ts`
  (`TTLCache`: TTL + stale-while-revalidate + single-flight),
  `src/config/` (env), `src/util/logger.ts`.

---

## Caching

One in-memory `TTLCache` (LRU-capped by `CACHE_MAX_ENTRIES`, default 10 000)
backs every cache key, with single-flight de-duplication so concurrent misses
share one upstream request. HTTP responses also carry `Cache-Control`
(`cacheMaxAge`), which Nuvio's OkHttp disk cache honours:

| Layer | Key / header | TTL (fresh) | Stale grace | Status in Phase 2 |
|---|---|---|---|---|
| Response `Cache-Control` | per resource (see below) | varies | — (stale is served server-side by `TTLCache`) | ✅ implemented |
| Page cache | `catalog:{source}:{id}:{genre}:{skip}` | 15 min | 6 h | ✅ implemented |
| Search cache | `search:{source}:{term}:{skip}` | 30 min | 6 h | ✅ implemented |
| Meta cache | `meta:{anilist\|kitsu}:{id}` | **7 d** | **30 d** | ✅ implemented |
| Negative meta cache | `meta:{anilist\|kitsu}:{id}` → `null` | 60 s | — | ✅ implemented |
| Identity cache (`resolve:{ns}:{value}`, 30 d) | — | — | — | ❌ designed, lands Phase 3 |
| Raw-source cache (upstream URL, 10 min) | — | — | — | ❌ designed, unplanned (deferred; no phase assigned) |

Response `cacheMaxAge` values (numeric `max-age` on the wire, from the services
and `src/index.ts`):
manifest 86 400 (24 h); catalog 900 fresh / 30 stale / 60 empty / 10 error;
search 1800; meta 604 800 (7 d); unknown id 60; failure 10.

No disk persistence: a restart rebuilds from live calls; the stale windows
cover the gap. (Full 5-layer design: `docs/architecture.md` §4, ADR-012.)

---

## AniList rate limit

AniList is officially in a degraded state: the live
`x-ratelimit-limit` header reads **30 req/min** (nominally 90/min per their
docs) — re-verified against the real API on 2026-10-04 by this repo's live
smoke test. Our client-side `TokenBucket` defaults to **25 req/min**
(`ANILIST_RATE_LIMIT`; ~17 % headroom), one Nuvio catalogue page costs 2
AniList requests (perPage clamps to 50), and the caches above absorb the rest.
Requesting an official raise via `contact@anilist.co` is a documented
pre-launch action item (`docs/data-sources.md` §1.2). Details and evidence:
[`docs/data-sources.md`](docs/data-sources.md) §1.

---

## Known limitations

Honest list — Phase 2 is a slice, not the whole design:

- **Jikan is gone.** Its public API was discontinued on 2026-10-01. There is
  no Jikan adapter, no Jikan code path, and none planned — it is not a Phase 2
  fallback and never will be (see roadmap Phase 2 scope and ADR-004).
- **Kitsu fallback ships; TMDB and AniZip code do not yet.** Logo/backdrop
  enrichment and episode data are Phases 3–4. AniList is the primary upstream,
  Kitsu the fallback.
- **Trending from fallback is most-favorited, not true trending.** During an
  AniList outage the trending catalogue is proxied onto Kitsu
  `sort=-userCount` — a deliberate approximation (see Fallback above).
- **`videos[]` is always empty.** No episode list until AniZip lands (Phase 4);
  Nuvio renders a clean details page without it.
- **Trakt library / watch progress will not work — this is structural, not a
  bug, and not fixable by returning more ids.** Verified in Nuvio's client
  source: `TraktLibraryRepository.hasAnyId()` accepts only `trakt`, `imdb` and
  `tmdb`; `TraktIdUtils.parseTraktContentIds("anilist:21")` returns null for all
  three; and `LibraryItem.imdbId` is computed as `id.takeIf { it.startsWith("tt") }`,
  which **discards** the `imdb_id` field Nuvio parses from our payload. So no
  id field we could add would help — only an id string literally starting with
  `tt` would. AniList cannot supply one either: `Media` exposes just `id`,
  `idMal` and `externalLinks`, and sampling `externalLinks` for five
  unambiguously IMDb-covered titles yielded zero IMDb ids.

  Switching the canonical id to `tt` was measured and rejected: across the
  20,840 titles in `Fribb/anime-lists` that carry an `anilist_id`, only 38.1%
  have an IMDb id and 39.6% a TMDB id — **60.1% have neither**. That trade
  would cost Trakt support for most of the catalogue *and* forfeit the Simkl
  anime tracking the `anilist:` prefix enables.

  **Nuvio still classifies these titles correctly** — it parses the prefix,
  marks them as anime and offers Add to Library / Mark as Watched; only the
  final Trakt mutation fails. Enable **Simkl** rather than Trakt to exercise
  tracking: Nuvio resolves `anilist:` to Simkl itself via
  `simkl.com/search/id?anilist=…`, and Simkl coverage is 64.2% versus IMDb's
  38.1%.
- **`links[]` are not displayed by Nuvio.** The parser extracts `links[]` only
  into `director` / `writer` / `cast`, and neither `links[]` nor `website` has
  any display consumer. Our AniList and MyAnimeList entries are sent
  correctly and are simply inert. Harmless, and the right thing to send for
  spec compliance and for other Stremio clients.
- **Only 3 catalogues.** Genre catalogues and the remaining curated catalogues
  are Phase 5.
- **`titleLang` is NOT wired** (see Install above): the SDK router discards
  the query string, so titles always resolve in English for now.
- ~~**Live 404-vs-`null` gap**~~ — **FIXED in Phase 1.** The opt-in live suite
  found that AniList answers an unknown id with **HTTP 404**, not HTTP 200, so
  `fetchById` used to throw where its contract promised `null`, and the 60 s
  negative-cache entry was skipped — letting repeated unknown-id lookups drain
  the 30 req/min budget. `AniListSource.fetchById` now maps a 404 to `null`
  (narrowly: a 400 still throws, so malformed queries are not masked). Verified
  live: `fetchById(99999999) → null`, 4/4 live tests passing.
- **No on-device verification by the agent.** Installing in real Nuvio and
  walking the Phase 1 exit gate (`docs/roadmap.md` Phase 1) is a human step
  that has not been performed.

---

## Documentation

Nine design documents in [`docs/`](docs/):

| Document | Contents |
|---|---|
| [`research.md`](docs/research.md) | Raw research findings |
| [`architecture.md`](docs/architecture.md) | Full multi-phase architecture, fallback matrix, caching, deployment |
| [`data-sources.md`](docs/data-sources.md) | Live-verified API reference: AniList, Jikan, Kitsu, TMDB, AniZip, Fribb bundle |
| [`sdk-reference.md`](docs/sdk-reference.md) | `stremio-addon-sdk` behaviours we depend on |
| [`nuvio-compatibility.md`](docs/nuvio-compatibility.md) | Nuvio client behaviours, verified from its source |
| [`id-mapping.md`](docs/id-mapping.md) | Cross-source identity design |
| [`catalog-design.md`](docs/catalog-design.md) | Catalogue plan (15 catalogues by Phase 5) |
| [`decisions.md`](docs/decisions.md) | 16 Architecture Decision Records (ADRs) |
| [`roadmap.md`](docs/roadmap.md) | Phases 0–8, exit gates, risk register |

---

## Development

Requires Node ≥ 22.

```bash
npm install          # or npm ci
npm test             # offline unit suite — never touches the network
npm run typecheck && npm run lint
npm run build        # tsc → dist/
npm start            # node dist/index.js (PORT=7000 by default)
```

Environment (see `.env.example` — it matches `loadAppConfig` exactly):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP port |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ANILIST_RATE_LIMIT` | `25` | AniList token-bucket refill, req/min |
| `HTTP_TIMEOUT_MS` | `3500` | per-request timeout (capped at 4000) |
| `CACHE_MAX_ENTRIES` | `10000` | in-memory LRU cap |

### Live smoke tests

`test/live/anilist.live.test.ts` hits the real AniList API (~4 requests —
well under the 30 req/min limit; do not add more, and do not run it more
often than needed). It verifies a catalogue page (and the perPage→50 clamp),
`fetchById(21)` → One Piece (AniList 21 / MAL 21), `fetchById(99999999)` →
`null`, and reports the current `x-ratelimit-limit`.
`test/live/kitsu.live.test.ts` hits the real Kitsu API (2 requests): a parsed
trending page via the `-userCount` proxy, and a `filter[text]=` search.
Combined the live suite makes roughly 8 requests. Both files are skipped
unless `ANICATA_LIVE=1`:

```bash
ANICATA_LIVE=1 npm run test:live   # opt-in; needs network
npx vitest run                     # live suite skips, default suite stays offline
```

> Last live run 2026-10-07: all 6 tests passed (4 AniList + 2 Kitsu);
> observed AniList `x-ratelimit-limit` is `30`. (The old 2026-10-04 note about
> the `99999999` case failing live is withdrawn — the 404→`null` mapping
> shipped in Phase 1 and the case passes.)
