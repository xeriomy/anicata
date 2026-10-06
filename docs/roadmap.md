# Implementation Roadmap

> Phases 0 and the Phase 1–2 design are complete in the documentation set.
> Phases 1+ are **estimates**, not commitments, until Phase 1 is measured.
> Each phase has an explicit exit gate; do not start the next phase until the
> current one passes.

---

## Phase 0 — Research ✅ COMPLETE

**No feature code was written.**

| Deliverable | Status |
|---|---|
| [`research.md`](./research.md) | ✅ |
| [`architecture.md`](./architecture.md) | ✅ |
| [`data-sources.md`](./data-sources.md) | ✅ |
| [`sdk-reference.md`](./sdk-reference.md) | ✅ |
| [`nuvio-compatibility.md`](./nuvio-compatibility.md) | ✅ |
| [`id-mapping.md`](./id-mapping.md) | ✅ |
| [`catalog-design.md`](./catalog-design.md) | ✅ |
| [`decisions.md`](./decisions.md) | ✅ |
| [`roadmap.md`](./roadmap.md) | ✅ this file |

**Verified sources:** NuvioMobile client source (read directly), Nuvio's vendored
Stremio docs, `stremio-addon-sdk` source, AniList (introspection + live queries +
headers), Kitsu (live JSON:API), AniZip (live, all params), `Fribb/anime-lists`
(downloaded and parsed), `demdex/nuvio-anime`, `anisync-addon`.

**Known gaps carried forward:** Jikan unreachable (UNVERIFIED), TMDB needs a key
to verify anime coverage, `nuvio.wiki` unreachable, Kitsu's real rate limit
UNVERIFIED. (AniList max `perPage` was since resolved: **clamped to 50**.)

---

## Phase 1 — Minimal add-on (AniList only)

**Goal:** install in Nuvio, see a catalogue, open an item, read metadata.

### Scope

- Project scaffold: TypeScript, Node 22, `tsrc→dist` build, ESLint, Prettier, Vitest.
- `domain/anime.ts` — the `Anime` type.
- `sources/anilist/` — adapter + GraphQL documents + response types.
- `normalize/` — status, format, text (HTML strip, attribution strip, length cap).
- `render/meta-preview.ts`, `render/meta-detail.ts`.
- `addon/manifest.ts`, `addon/catalog.ts`, `addon/meta.ts`, `index.ts`.
- `cache/store.ts` — TTL + stale + single-flight.
- `net/http.ts` — timeout, `User-Agent`, header capture.
- **Two catalogs only:** `anime-trending`, `anime-top-rated`.
- **One catalog:** `anime-search`.

### Explicitly deferred

Jikan, Kitsu, TMDB, AniZip, the identity bundle, genre catalogs, `videos[]`,
disk cache, deployment config.

### Exit gate

- [ ] `GET /manifest.json` → 200, passes the SDK linter, ≤ 8192 B
- [ ] Manifest installs in **real Nuvio**; both catalogs appear on **Home**
- [ ] `anime-trending.json/skip=0` → exactly 100 items, all with `id`/`type`/`name`/`poster`
- [ ] `skip=100` → items `[100,200)`, **zero overlap** with `skip=0`
- [ ] `skip=1000` → `{"metas":[]}`, pagination ends cleanly
- [ ] `anime-search` returns results for a real query (e.g. "cowboy bebop")
- [ ] `/meta/anime/anilist%3A21.json` → `{meta:{…}}` with `id`/`type`/`name`
- [ ] Meta includes `id`, `type`, `name`, `poster`, `banner`, `description`,
      `releaseInfo`, `genres`, `imdbRating`, `links[]`, **and both**
      `country`+`countryOfOrigin`, `language`+`audioLanguage`
- [ ] Opening a title in Nuvio shows the poster, synopsis, genres and rating
- [ ] Nuvio's **anime classification/tracking** engages (Simkl section appears)
- [ ] Every emitted id is prefixed `anilist:`
- [ ] `Cache-Control` present on all responses
- [ ] Cold response < 5 s; warm response < 100 ms
- [ ] Throwing adapter → 200, never 5xx
- [ ] Malformed inbound id → 200 + `metas: []` with **zero** upstream calls
- [ ] Tests: manifest, pagination non-overlap, id prefixing, degradation

---

## Phase 2 — Source abstraction + fallback

**Goal:** AniList fails → users still get content.

### Scope

- `sources/types.ts` — the `Source` interface.
- `sources/kitsu/` — adapter, JSON:API types, `include=genres` handling.
- `sources/jikan/` — adapter behind `ENABLE_JIKAN` (default off).
- `net/limiter.ts`, `net/breaker.ts`.
- `domain/errors.ts` — the error taxonomy.
- `sources/` orchestration: per-capability chains, timeouts, global deadline.
- Record fixtures for all three sources (from live APIs).
- ESLint boundary rules between layers.

### Exit gate

- [ ] All three adapters pass the same contract test suite
- [ ] Jikan unreachable → **zero** impact on response time
- [ ] AniList 500 → Kitsu-sourced catalogue, comparable item count
- [ ] AniList 429 → **stale served, zero fallback calls** (assert with a spy)
- [ ] AniList + Kitsu down → stale (up to 24 h), never 5xx
- [ ] Empty result → **zero** fallback calls
- [ ] Every adapter maps to identical `Anime` for equivalent input (snapshot)
- [ ] Every response still 200, still ≤ 5 s

---

## Phase 3 — Identity & mapping

**Goal:** every item carries cross-source ids, from any id we might be handed.

### Scope

- `scripts/build-identity.ts` — download Fribb, trim, gzip → `data/identity.min.json.gz`.
- `identity/ids.ts` — `parseIncomingId`, `formatId`, reject bare numbers.
- `identity/bundle.ts` — load + build the 5 reverse indices.
- `identity/resolver.ts` — the chain: bundle → Kitsu `/mappings` → AniZip → title.
- `render/` — emit `links[]` for AniList / MAL / Kitsu / AniDB.
- Inbound resolution for `anilist:`, `mal:`, `kitsu:`, `tmdb:`, `tt…`, `imdb:`.

### Exit gate

- [ ] `npm run identity:build` reproduces a ≤ 500 KB gzipped artefact
- [ ] One Piece: all four sources agree; `id` = `anilist:21`
- [ ] `mal:21`, `kitsu:12`, `tmdb:37854`, `tt0388629` all resolve to `anilist:21`
- [ ] Unknown-but-valid `anilist:99999999` → `metas: []`, **zero** fallback calls
- [ ] Bare numeric id → rejected, no upstream call
- [ ] Mapping resolution served from memory in < 1 ms
- [ ] Malformed id → never maps to a *different* title (the worst failure mode)

---

## Phase 4 — Enrichment

**Goal:** better visuals and episodes — still fully optional.

### Scope

- `sources/anizip/` — `/mappings`, episode extraction, TVDB artwork.
- `render/videos.ts` — season/episode lists; specials → season 0.
- `sources/tmdb/` — logos + backdrops, gated on `TMDB_API_KEY`.
- Enrichment runs in parallel under a 1.5 s budget each.

### Exit gate

- [ ] `videos[]` populated for a long series (One Piece) with correct titles
- [ ] Specials in season 0; AniList-relative numbering preserved
- [ ] **TMDB key unset → everything else still works identically**
- [ ] **AniZip down → meta renders without `videos`, no error**
- [ ] Enrichment timeout adds < 1.5 s to worst-case response
- [ ] `logo` populated when TMDB is configured
- [ ] All Nuvio `videos[]` fields round-trip (`season`, `episode`, `thumbnail`,
      `overview`, `runtime`, `rating`, `released`)

---

## Phase 5 — Catalogue expansion

**Goal:** the full, curated catalogue.

### Scope

- Remaining catalogs: `anime-popular`, `anime-airing`, `anime-upcoming`,
  `anime-recent`, `anime-movies`, `anime-ova`, `anime-seasonal`,
  2 × `type: movie`.
- Genre catalogs: `anime-genres`, `anime-top-genres` with 18 curated options.
- ~~Probe AniList's max `perPage`~~ ✅ **resolved: clamped to 50.** One Nuvio
  page of 100 = 2 AniList requests. Build the 2-page fetch into Phase 1.

### Exit gate

- [ ] All 15 catalogs appear on Nuvio Home (verifies no `isRequired` extras)
- [ ] All paginate with no overlap at every `skip`
- [ ] Genre filter populated with 18 options and filters correctly
- [ ] Discover works with **and** without a genre selected
- [ ] Manifest still ≤ 8192 B (asserted in CI)
- [ ] Seasonal catalog rolls over correctly across a season boundary
- [ ] Request count per 1,000 catalogue page views stays within budget

---

## Phase 6 — Performance & resilience

**Goal:** comfortable margin against AniList's 30 req/min.

### Scope

- Tune TTLs from measured hit rates.
- Batched `id_in` / `idMal_in` where it helps.
- `x-ratelimit-remaining` guard (stop at ≤ 3, serve stale).
- Circuit breaker tuning.
- `identity:build` scheduled as a build step (daily).

### Exit gate

- [ ] **Request an AniList rate-limit raise** (documented process)
- [ ] p95 catalogue response < 500 ms warm, < 3 s cold
- [ ] Cache hit ratio > 90% over 24 h
- [ ] Zero AniList 429s over 24 h at expected load
- [ ] Simulated AniList outage for 1 h → users see stale content, no errors
- [ ] Memory bounded under LRU eviction (`CACHE_MAX_ENTRIES`)

---

## Phase 7 — Testing & Nuvio verification

**Goal:** confidence before real users.

### Unit
- [ ] Adapters vs recorded fixtures (all sources)
- [ ] Normalizer table-driven per source shape
- [ ] Renderer golden JSON snapshots
- [ ] Cache: TTL, stale window, single-flight (fake timers)
- [ ] Limiter + breaker (fake clock)
- [ ] Identity resolver (small fixture bundle)
- [ ] ID parsing: every prefix, every malformed form

### Integration
- [ ] Services with adapter fakes, including throwing ones
- [ ] Handlers via supertest: manifest lint, extras parsing, degradation
- [ ] **Never 5xx** invariant test

### Live smoke (`npm run test:live`, opt-in)
- [ ] AniList / Kitsu / AniZip reachable and returning expected shapes
- [ ] AniList `perPage` maximum confirmed ✅ (already verified in research: 50)
- [ ] AniList current rate limit re-confirmed
- [ ] Kitsu rate-limit behaviour observed and self-limiter tuned

### On-device (manual, real Nuvio)
- [ ] Install from a URL and from a `stremio://` link
- [x] Manifest logo renders in the add-on list ✅ **verified on device 2026-10-05**
      The repo shipped a 1×1, 67-byte placeholder `public/logo.png`. It satisfied every
      assertion the integration test made (a 1×1 pixel *is* a valid `image/png`, and is
      certainly >0 bytes), so the test passed while Nuvio rendered an empty tile in the
      add-on list — caught only by on-device verification, not by any test.
      `public/logo.png` is now a real 512×512 mark generated by
      `scripts/generate-logo.mjs` (no image dependency; written with Node's built-in
      `zlib`), and the test now asserts PNG signature, dimensions ≥64×64, squareness and
      >1 KB — verified to fail against the old placeholder. Re-verified rendering in the
      Nuvio add-on list on device.
- [x] All catalogs on Home ✅ **verified on device 2026-10-05** — all three rows render
      (Trending, Top Rated, Search)
- [ ] Scroll triggers pagination correctly — not separately confirmed on device
- [x] Search returns results ✅ **verified on device 2026-10-05** — "attack on titan"
      returned 4 titled results with artwork
- [ ] Genre filter works — Phase 5, not applicable yet
- [x] Details page: poster, genres, rating render ✅ **verified on device 2026-10-05**
      (Attack on Titan / `anilist:16498`: poster, `Action • Drama • Fantasy`, `2013`,
      `24m`, `IMDb 8.5`, synopsis with Show More, `FINISHED`).
      Critically, `Origin Country: JP` and `Original Language: JA` both rendered, which
      confirms the dual `country`/`countryOfOrigin` and `language`/`audioLanguage` emission
      works against a real client. "Playback unavailable" is expected — `videos: []` until
      AniZip in Phase 4. Note: Nuvio labels this section "Movie Details" for all types;
      that string is hardcoded (`DetailAdditionalInfoSection.kt:36` →
      `details_movie_details`) and is not something an add-on can influence.
- [ ] `links[]` renders — the Nuvio details overflow (⋯) menu was not opened
- [ ] **Anime classification + tracking engages** (Simkl section present)
- [ ] Empty search shows a clean "no results" — no error banner
- [ ] Kill the add-on → Nuvio degrades gracefully

### Contract conformance
- [ ] Validate against `stremio-addon-client`
- [ ] Validate responses against Stremio response schemas
- [ ] Confirm compatibility in at least one non-Nuvio Stremio-compatible client

---

## Phase 8 — Deployment

**Goal:** a public URL Nuvio can install.

- [ ] Multi-stage `Dockerfile` (Node 22 Alpine, non-root, healthcheck)
- [ ] Deploy to Fly.io; pin region near AniList's edge for latency
- [ ] Custom domain + HTTPS (Nuvio requires a real origin)
- [ ] Env vars configured; no secrets in query strings
- [ ] `GET /healthz` → source/counters status
- [ ] Structured JSON logs; request-level `reqId`
- [ ] Rate-limit raise requested from AniList
- [ ] **Install the deployed URL in Nuvio and verify every Phase 7 device check**
- [ ] README: install instructions, config params, architecture overview
- [ ] Documented rollback

---

## Post-launch

| Item | Priority |
|---|---|
| Disk cache for L2–L4 (if cold starts ever matter) | Low |
| Redis if running > 1 replica | Medium — becomes required the moment we scale horizontally |
| `kitsu:` id emission if Kitsu-only titles prove material | Low (ADR-016) |
| Second addon for a bigger manifest if 8 KB binds | Low |
| `date` extra for a user-selectable season catalog | Low |
| More AniList tag categories as genre options | Low |

---

## Dependencies between phases

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
   │           │           │           │
   └───────────┴───────────┴───────────┴──► Phase 5 ──► Phase 6 ──► Phase 7 ──► Phase 8
```

**Hard ordering constraints:**

1. **Phase 2 before Phase 3.** The identity resolver needs Kitsu's `/mappings` as
   its second tier. Building it before Kitsu exists would mean a placeholder.
2. **Phase 3 before Phase 4.** AniZip's cross-IDs are only useful once an identity
   layer exists to consume them.
3. **Phase 5 after Phase 2.** Expanding 15 catalogs before the fallback chain and
   caching exist would multiply the request-budget problem 15×.
4. **Phase 6 before Phase 7's live tests.** Tuning needs production-shaped load.

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | AniList degrades further / raises the 30/min floor | Medium | **High** | 5 cache layers, stale-while-revalidate, fallback chain, request a raise (Phase 6) |
| 2 | AniList schema changes | Medium | Medium | Our own domain model isolates it to one adapter (ADR-006); contract tests catch drift |
| 3 | AniZip disappears (community-run) | Medium | Low | Optional; `videos[]` degrades cleanly; Kitsu also serves episodes |
| 4 | Fribb mapping dataset goes stale/gone | Low | Medium | Build script + scheduled rebuild + Kitsu/AniZip runtime fallbacks |
| 5 | Jikan stays unreachable | **High** | Low | Already optional and last; system is unaffected |
| 6 | Nuvio changes its protocol expectations | Low | Medium | Behaviour verified from source; contract tests + manual device checks each release |
| 7 | ~~`perPage: 100` unsupported~~ | **Certain** | Low | ✅ Confirmed clamped to 50. 2×50 fetch is the design, not a fallback. |
| 8 | 8 KB manifest binds | Low | Low | Second addon, not a bigger manifest |
| 9 | Cold starts on a mis-chosen host | Low | **High** | Docker on a long-running platform (ADR-013); healthcheck catches it |
| 10 | Rate-limit raise denied | Medium | Medium | Caching + batching + fallback already sized for 30/min |

---

## Definition of done

Per the brief, the project is complete when:

- [ ] Nuvio can install the add-on
- [ ] Manifest is valid (linter + ≤ 8 KB)
- [ ] Catalogues display correctly
- [ ] Search works
- [ ] Anime metadata opens correctly
- [ ] Stable IDs are used (`anilist:<id>`, always prefixed)
- [ ] AniList integration works
- [ ] Kitsu fallback works
- [ ] Jikan fallback works *(or is documented as unavailable — see ADR-004)*
- [ ] Mapping works (all cross-IDs, all inbound prefixes)
- [ ] Optional enrichment works, and is genuinely optional
- [ ] Images work
- [ ] API failures are handled gracefully (never 5xx)
- [ ] Rate limits are respected (25/min bucket + batching + `x-ratelimit-remaining`)
- [ ] Caching is implemented appropriately (5 layers + stale-while-revalidate)
- [ ] Tests cover the important behaviour (Phase 7)
- [ ] Documentation is complete (this set)
- [ ] Deployment works
- [ ] Nuvio compatibility is verified on-device

**Honest caveat on one item:** *"Jikan fallback works"* cannot be confirmed while
`api.jikan.moe` is unreachable from our environment. The adapter will be
implemented, unit-tested against recorded fixtures, and shipped **disabled**.
Enabling it is a one-environment-variable change once Jikan is verified
reachable. That is a fact about Jikan's availability, not an unfinished feature —
but it should be reported as such rather than quietly marked done.