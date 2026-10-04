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

> Status: Phase 1 (AniList only). Kitsu fallback, TMDB enrichment, AniZip
> episodes, genre catalogues and deployment land in Phases 2–8 per
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
  `meta` resource, so Nuvio only consults us for ids we minted. `kitsu:` ids
  are declared from day one (ADR-016) but **not emitted** in Phase 1 — the
  meta handler answers them with a minimal placeholder until the Kitsu source
  lands in Phase 2.

---

## Architecture

What actually exists in Phase 1 (see `docs/architecture.md` for the full
multi-phase design — several layers there are not built yet):

```
Nuvio ──► express + SDK router ──► addon/ ──► services/ ──► sources/anilist
            src/index.ts            manifest     CatalogService   AniListSource
                                    catalog      MetaService        (GraphQL)
                                    meta              │                │
                                                      ▼                ▼
                                                  cache/store    normalize/
                                                  TTLCache        media → Anime
                                                  (single-flight)      │
                                                                       ▼
                                                                    render/
                                                              Anime → Stremio meta
```

One-line layer summary:

- **`src/index.ts`** — composition root: builds config, HTTP client, limiter,
  cache, source and services; mounts `public/` (logo), a 24 h
  `Cache-Control` on `/manifest.json`, and the SDK router. Importing it never
  binds a port; only `node dist/index.js` listens.
- **`src/addon/`** — protocol layer only: manifest builder (+ 8 KB size
  assertion), catalog handler (parses `skip`/`search` extras), meta handler
  (parses `anilist:<id>`, never returns non-200).
- **`src/services/`** — orchestration: page stitching, search, meta lookup,
  and the cache/error policies (empty → short cache, failure → valid empty
  body, never 5xx).
- **`src/sources/anilist/`** — the only upstream adapter: GraphQL documents,
  response types, and `AniListSource` (`fetchCatalogPage`, `search`,
  `fetchById`/`fetchByIds`). Translates into our domain, never exposes
  AniList shapes upward.
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

| Layer | Key / header | TTL (fresh) | Stale grace | Status in Phase 1 |
|---|---|---|---|---|
| Response `Cache-Control` | per resource (see below) | varies | — (stale is served server-side by `TTLCache`) | ✅ implemented |
| Page cache | `catalog:{id}:{genre}:{skip}` | 15 min | 6 h | ✅ implemented |
| Search cache | `search:{term}:{skip}` | 30 min | 6 h | ✅ implemented |
| Meta cache | `meta:anilist:{id}` | **7 d** | **30 d** | ✅ implemented |
| Negative meta cache | `meta:anilist:{id}` → `null` | 60 s | — | ✅ implemented |
| Identity cache (`resolve:{ns}:{value}`, 30 d) | — | — | — | ❌ designed, lands Phase 3 |
| Raw-source cache (upstream URL, 10 min) | — | — | — | ❌ designed, lands Phase 2 |

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

Honest list — Phase 1 is a slice, not the whole design:

- **Jikan is unreachable and therefore disabled.** Its API host
  (`api.jikan.moe`) timed out at TCP level on repeated attempts during
  research while AniList, Kitsu, AniZip and TMDB all responded. No Jikan
  adapter ships in Phase 1; it lands (opt-in) in Phase 2.
- **No Kitsu, TMDB or AniZip code yet.** Fallback chain, logo/backdrop
  enrichment and episode data are Phases 2–4. AniList is the single upstream.
- **`videos[]` is always empty.** No episode list until AniZip lands (Phase 4);
  Nuvio renders a clean details page without it.
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

### Live smoke test

`test/live/anilist.live.test.ts` hits the real AniList API (~4 requests —
well under the 30 req/min limit; do not add more, and do not run it more
often than needed). It verifies a catalogue page (and the perPage→50 clamp),
`fetchById(21)` → One Piece (AniList 21 / MAL 21), `fetchById(99999999)` →
`null`, and reports the current `x-ratelimit-limit`. Skipped unless
`ANICATA_LIVE=1`:

```bash
ANICATA_LIVE=1 npm run test:live   # opt-in; needs network
npx vitest run                     # live suite skips, default suite stays offline
```

> As of 2026-10-04 the `99999999` case **fails live** (HTTP 404 throw vs
> expected `null`) — see Known limitations. The other three pass and the
> observed `x-ratelimit-limit` is `30`.
