# Architecture Decision Records

> Each record: **Context → Decision → Alternatives rejected → Consequences.**
> Dates are the research phase (2026-10-04).

---

## ADR-001 — Canonical identity is the AniList ID

**Status:** Accepted

**Context.** Stremio requires a single opaque string `id` per item, and that id is
what every future request is keyed on. AniList — our primary source — exposes only
two identifiers (`id`, `idMal`); there is no `idKitsu`, no `externalIds`, and
`externalLinks` carries no database IDs at all. So the choice of canonical id is a
real architectural decision, not a detail.

**Decision.** The canonical id is **`anilist:<anilistId>`**. Kitsu ids
(`kitsu:<id>`) are accepted as an inbound fallback and are declared in `meta`
`idPrefixes` from day one, but are not emitted until/unless Kitsu-only coverage
proves material.

**Alternatives rejected**

| Option | Rejected because |
|---|---|
| `tt…` (IMDb) | Exists for only ~25% of anime (measured on the Fribb dataset). A hard ceiling; most items would have no valid id. |
| `tmdb:<id>` | Only ~26% coverage, **and** Nuvio actively rewrites `tmdb:` ids to IMDb before calling us (`MetaDetailsRepository.resolveMetaLookupId`), so it buys nothing and adds a fragile dependency. Also requires an API key. |
| `kitsu:<id>` | Requires a live `/mappings` lookup for every title before we can emit an id. Kitsu ids are *not* derivable from MAL (21→12). Adds a request to the hot path. |
| `mal:<id>` | 95% coverage and keyless, but MAL ids are secondary to our primary source, and Nuvio prefers `anilist:` in its tracking precedence order (`simkl → imdb → tmdb → tvdb → trakt → mal → anidb → anilist → kitsu`). |
| Composite/encoded id (`al21.ks12.tmdb37854`) | Stable but brittle: any missing component changes the id, breaking saved state. |
| Title string | Explicitly forbidden by the brief and by common sense — ambiguous and unstable. |

**Consequences**

- ✅ Catalog and meta cost **one** upstream source, not two.
- ✅ Nuvio classifies the item as `TrackingMediaKind.ANIME` natively and its Simkl
  anime-list sync engages — we implement **zero** tracking code.
- ✅ `idPrefixes: ["anilist:", "kitsu:"]` makes us the handler only for our own ids.
- ⚠ Identity availability is coupled to AniList's uptime; the Kitsu fallback chain
  mitigates but cannot eliminate this.
- ⚠ Diverges from `demdex/nuvio-anime`, which prefers `tt…` for scraper
  compatibility. That is a streaming-motivated choice; a future streaming layer
  resolves `anilist:` → `tt…` through the identity bundle.

---

## ADR-002 — `anilist:` is a routing filter, not decoration

**Status:** Accepted

**Context.** Nuvio's meta routing is:

```kotlin
resource.name == "meta" &&
resource.types.contains(type) &&
(resource.idPrefixes.isEmpty() || resource.idPrefixes.any { id.startsWith(it) })
```

An empty `idPrefixes` therefore means "match **everything**".

**Decision.** Declare the object form of `resources` with
`idPrefixes: ["anilist:", "kitsu:"]` on the `meta` resource only.

**Alternatives rejected**

- **Omit `idPrefixes`:** we become a candidate for every id in the app — IMDb and
  TMDB ids from other add-ons. We'd get asked for content we cannot resolve,
  adding latency (Nuvio waits 5 s per candidate) and error surface for content we
  do not own.
- **`idPrefixes` at root only:** applies to *all* resources including `catalog`,
  where it is meaningless and where it would prevent Nuvio from treating our
  catalogue as its own content source.

**Consequences.** We are only consulted for ids we minted. A malformed or
foreign id from a third party never reaches us.

---

## ADR-003 — Use `stremio-addon-sdk` rather than hand-rolling the protocol

**Status:** Accepted

**Context.** The protocol is simple enough to hand-roll with express. The SDK
adds express itself, so the saving is marginal — but it also adds CORS, manifest
linting, handler-coverage validation, the canonical URL scheme, and TypeScript
types.

**Decision.** Use `stremio-addon-sdk` v1.6.10 with `addonBuilder`,
`defineCatalogHandler`, `defineMetaHandler`, `serveHTTP`.

**Alternatives rejected**

- **Hand-rolled express:** saves one dependency but we would re-implement manifest
  validation, the `qs.parse` extra handling, and the URL scheme — all of which have
  non-obvious behaviours (the 8 KB limit; extras parsed from the *raw* URL because
  `req.params` decodes `%26` and breaks them). Re-implementing them is a bug farm.
- **`@stremio/addon-sdk` / other forks:** not the official package.

**Consequences.** We inherit express 4 and node-fetch 2 (both old but functional
on Node 22). The 8 KB manifest cap becomes a hard design constraint
(ADR-007).

---

## ADR-004 — AniList primary, Kitsu first fallback, Jikan optional and last

**Status:** Accepted

**Context.** The brief proposed AniList → Jikan → Kitsu. Research reordered it.

- **AniList** — best search, tags, relations, airing schedules, trending. ✅ reachable.
- **Jikan** — ⚠ `api.jikan.moe` **timed out at TCP level** from the research
  environment on repeated attempts (IPv4 and IPv6) while AniList/Kitsu/AniZip/TMDB
  all responded normally. Its docs host works, so the service plausibly exists —
  but we could not verify it. It also has the strictest documented limits
  (3 req/s, 60 req/min) and is an unauthorised third-party wrapper.
- **Kitsu** — ✅ reachable, fast (~70 ms), actively maintained (`updatedAt` current),
  and its `/mappings` endpoint is a first-class keyless MAL↔Kitsu↔AniList bridge.

**Decision.** AniList → **Kitsu** → Jikan (opt-in via `ENABLE_JIKAN`, default off).

**Alternatives rejected.** Keeping the brief's order would have made an
unverifiable service the *first* fallback and demoted a verified, faster one.

**Consequences.** Kitsu's normalisation burden is now on the critical path, so it
must be correct and well-tested from Phase 2. If Jikan turns out to be healthy,
enabling it is a one-env-var change.

---

## ADR-005 — Cross-ID mapping from a bundled dataset, not per-title APIs

**Status:** Accepted

**Context.** AniList gives us only two ids. We need Kitsu/TMDB/IMDb/AniDB for
`links[]`, for future streaming, and to let other clients cross-reference.
Three candidate mechanisms:

| Mechanism | Coverage | Cost |
|---|---|---|
| Kitsu `/mappings` per title | 21,129 MAL rows | 1 live request per title |
| AniZip `/mappings` per title | good, returns all ids | 1 request, up to 1.87 MB |
| **Fribb bulk bundle** | 32,363 records / 459 KB gz | **0 requests at runtime** |

**Decision.** Build a trimmed mapping bundle from
`Fribb/anime-lists/anime-list-full.json` at build time; resolve from memory first,
falling back to Kitsu `/mappings` then AniZip for anything missing.

**Alternatives rejected**

- **Per-title API resolution only:** correct but costs a request per title, against
  a 30 req/min budget. Untenable.
- **Ship the raw 7.49 MB file:** 16× larger for zero extra information.
- **Relying on `AniList/anime-lists`:** that repo is **404 — gone**. It is what
  `demdex/nuvio-anime` builds from, which is a latent production bug in that
  project.
- **Relying on `arm.haglund.dev`** (AniSync's ARM resolver): an untrusted
  third-party runtime dependency for something we can bundle.

**Consequences**

- ✅ Cross-links are effectively free.
- ✅ Works with no network at all for ~64% of titles (AniList-keyed).
- ⚠ A stale bundle means stale mappings. Mitigated: build-time generation, a
  documented `identity:build` script, and runtime fallbacks.
- ⚠ IMDb/TMDB coverage is ~25%. Acceptable — they are bonus `links[]` entries, not
  identity.

---

## ADR-006 — Domain model is ours, not AniList's

**Status:** Accepted

**Context.** `demdex/nuvio-anime` normalises **every** adapter *to the AniList
shape* (`jikan.js:106-154`, `kitsu.js:98-145`). AniList's schema therefore becomes
the real contract, fallbacks are subordinate, and any AniList schema change ripples
everywhere. There is no interface — `withFallback` relies on objects merely
*happening* to have compatible keys, with no compile-time or runtime check.

**Decision.** Define `Anime` / `Episode` / `AnimeIdentity` in `src/domain/` as our
own types. Each adapter implements a `Source` interface and translates **into** the
domain. No adapter imports another adapter. Enforced with ESLint
`no-restricted-imports`.

**Alternatives rejected**

- **Normalise to AniList shape:** the incumbent pattern. Cheaper to write, but it
  is precisely the coupling the brief forbids.
- **Normalise to the Stremio `MetaPreview` shape:** worse — it would drag protocol
  concerns into the data layer and make future streaming awkward.

**Consequences.** More code up front (three mapping functions instead of one), but
swapping or removing AniList touches exactly one directory, and each adapter is
unit-testable against recorded fixtures without any other source present.

---

## ADR-007 — 13–15 catalogs with curated extras, not a large manifest

**Status:** Accepted

**Context.** Two hard limits:

1. The SDK **throws** if `JSON.stringify(manifest).length > 8192` (`builder.js:22`).
2. Nuvio gates features on the `extra` array: any `isRequired` extra removes a
   catalog from Home; `skip` enables pagination; `search` makes Nuvio query that
   catalog on **every** search; `genre` options populate the Discover filter.

**Decision.** Ship 11 `anime` catalogs, 2 `movie` catalogs, and 2 genre-bearing
catalogs with 18 curated AniList genres. Declare `search` on **exactly one**
catalog. Estimate ≈ 2.2 KB of the 8192 B budget.

**Alternatives rejected**

- **One catalog per genre (~50):** 50 Home rows; manifest bloat; 50 requests per
  genre tap.
- **`search` on every catalog:** Nuvio fans out to all searchable catalogs — 13
  AniList requests per search from one user, against a 30/min budget.
- **A `date` extra for the season catalog:** no Nuvio UI sends it. Season is
  computed server-side and rolls over automatically.

**Consequences.** A smaller, faster, more usable add-on. CI asserts manifest size
≤ 8192 so a future catalog can never silently break startup.

---

## ADR-008 — Pagination by `skip`, returning pages of exactly 100

**Status:** Accepted

**Context.** Nuvio computes `nextSkip = requestedSkip + metas.length` (the **raw**
length, not the deduped one) and stops after 3 consecutive duplicate pages
(`DUPLICATE_CATALOG_PAGE_ADVANCE_LIMIT`). `CATALOG_PAGE_SIZE = 100`.

**Decision.** Handler reads `args.extra.skip` as a **string**, requests the
upstream window `[skip, skip+100)`, returns exactly 100 items when available, and
`metas: []` when exhausted.

**Alternatives rejected**

- **The SDK's `page` parameter:** does not exist. The SDK implements no pagination;
  the handler must slice.
- **Short pages:** legal and self-consistent, but they shorten Nuvio's next step and
  make `skip` arithmetic drift.

**Consequences.** Exact pagination, healthy infinite scroll, and one hard rule:
**a given `skip` must always return the same items.** This is why the page cache is
keyed by `skip` — AniList's `TRENDING_DESC` can reorder between requests, which
would otherwise manufacture duplicates and kill pagination after 3 pages.

**Unresolved.** AniList's maximum `perPage` is **UNVERIFIED**. If 100 is accepted,
one request serves one Nuvio page instead of two — the highest-value micro-optimisation
available. Probe before Phase 5.

---

## ADR-009 — Emit both `country`/`countryOfOrigin` and `language`/`audioLanguage`

**Status:** Accepted

**Context.** Nuvio reads `country` and `language`. An exhaustive grep of
`NuvioMobile` shows `countryOfOrigin` and `audioLanguage` appear **nowhere** in meta
parsing. The Stremio spec (and other clients) expect the longer names.

**Decision.** Emit both spellings for both fields.

**Alternatives rejected.**

- **Nuvio names only:** breaks Stremio and every other client.
- **Standard names only:** Nuvio silently shows blank fields.

**Consequences.** ~40 extra bytes per meta response. Non-negotiable — the brief's
goal is compatibility, and this is the cheapest possible compatibility fix.

---

## ADR-010 — Never return 5xx; degrade to valid empty responses

**Status:** Accepted

**Context.** Nuvio's behaviour on failure:

| Failure | Nuvio's response |
|---|---|
| Catalog non-200 | error message, row dropped |
| Meta non-200 or malformed body | **silently** skips the add-on, tries the next, then TMDB |
| `metas: []` | clean "no results" |

**Decision.** Every handler returns HTTP 200 with a valid Stremio body. Empty
results carry a short `Cache-Control` (60 s). Errors carry a very short one (10 s)
so recovery is quick. The only way to produce a non-200 is a bug in our own HTTP
layer, and a test asserts a throwing adapter still yields 200.

**Alternatives rejected**

- **Propagating 5xx:** makes a transient upstream blip look like a broken add-on.
- **Returning `undefined`:** typed as legal by the SDK, but yields an empty body
  that clients treat inconsistently.

**Consequences.** Users see "no results" instead of an error banner. Metrics and
logs carry the real diagnosis. This is also why the fallback matrix
(ADR-011) is worth so much.

---

## ADR-011 — Only transient failures trigger fallback

**Status:** Accepted

**Context.** The brief: *"Do not blindly fallback on every error."* Naive
fallback chains are slow and can multiply load precisely when a provider is
struggling.

**Decision.** An explicit error taxonomy with a decision matrix
(`architecture.md` §3.2):

- `not_found`, `invalid_request` → **no fallback**; an invalid id is not a
  transient failure and retrying other sources is pure waste.
- `rate_limited` → **no fallback**; respect `Retry-After` and serve stale.
  Falling back converts one throttled request into N throttled requests across N
  providers — which likely share a rate-limit domain anyway.
- `server_error`, `timeout`, `network`, `parse` → **fallback**.
- **Zero results is a success**, not a failure.

**Alternatives rejected**

- **Fallback on everything:** wasteful and self-amplifying under load.
- **Never fall back:** a single upstream blip empties the catalogue.

**Consequences.** A `rate_limited` error is the most common real-world failure, and
this decision makes it a *non-event* thanks to the stale cache. A test asserts
that a 429 on the primary produces **zero** fallback calls.

---

## ADR-012 — Five cache layers with stale-while-revalidate; no disk in v1

**Status:** Accepted

**Context.** AniList is at 30 req/min and officially degraded. Caching is not an
optimisation here — it is the architecture. Also, `demdex/nuvio-anime` ships a
24 h stale-grace cache, and its comment describes a real incident: a failed mapping
blanked every catalog for 24 h.

**Decision.** L1 response, L2 page (15 min / 6 h stale), L3 meta (7 d / 30 d
stale), L4 identity (30 d / 90 d stale), L5 raw source (10 min / 1 h stale).
In-memory only. Single-flight dedup. Per-resource `Cache-Control` including
`stale-while-revalidate` and `stale-if-error`.

**Alternatives rejected**

- **Serverless / edge deployment:** cold starts evict L2–L5, so every request hits
  AniList → 429. Rejected at the deployment level (ADR-013).
- **Disk persistence in v1:** adds invalidation bugs for a workload that is
  already ~99% cache hits. A restart empties the cache and rebuilds from the
  bundled identity data plus live calls; the stale window covers the gap.
- **Single global TTL:** our resources have very different volatilities (search
  30 min vs meta 7 d). One value cannot express that.

**Consequences.** Nuvio's 50 MB OkHttp disk cache means an identical catalog page
costs **zero** upstream requests for the whole TTL — the cheapest performance win
available. A total AniList outage degrades to stale content for up to 24 h rather
than empty rows.

---

## ADR-013 — Docker on a long-running host; reject serverless

**Status:** Accepted

**Context.** ADR-012 makes cache warmth load-bearing. Deployment options compared
on: long-running process, warm cache, env vars, cold starts, rate-limit
behaviour, cost, simplicity.

**Decision.** **Docker on Fly.io** (Railway/Render/VPS are equally acceptable).
Static `node dist/index.js` — no framework.

**Alternatives rejected**

| Option | Rejected because |
|---|---|
| **Vercel** | serverless; cold start evicts L2–L5 → every request hits AniList → 429 |
| **Cloudflare Workers** | no TCP problems in principle, but cold starts + CPU/memory limits make the caches useless; a 24 h stale window needs KV + D1. Defer. |
| **AWS Lambda** | same cold-start problem, worse |
| **Express/Fastify/NestJS** | no need. The SDK brings express. NestJS would fight the SDK's express instance. |

**Consequences.** We can be opinionated about a single long-lived process, an
in-process cache, and `AbortController` timeouts. Cost is near zero at launch
volume and grows predictably.

---

## ADR-014 — Batched AniList queries and a 25/min token bucket

**Status:** Accepted

**Context.** 30 req/min is ~0.5 req/s. Nuvio's Home screen requests every
non-required catalog, and a single user scrolling triggers many paginated fetches.

**Decision.** Per-source token bucket (AniList default 25/min, 17% headroom);
use `id_in` / `idMal_in` ✅ (both exist in the schema) to fetch many items per
request; read `x-ratelimit-remaining` and stop issuing requests at ≤ 3, serving
stale until reset; single-flight dedup; request an official rate-limit raise.

**Alternatives rejected**

- **Off-peak prefetch:** multiplies complexity for a marginal gain over caching.
- **Full utilisation (30/min):** no headroom for a cold start or a traffic spike —
  and being throttled costs us more than the throughput is worth.
- **Per-title resolution instead of the bundle (ADR-005):** untenable at this rate.

**Consequences.** Throughput is bounded by design rather than discovered in
production. 25 req/min supports roughly 3,600 catalog page views/hour, which the
caches multiply substantially.

---

## ADR-015 — No watch-state, no user context in the `meta` handler

**Status:** Accepted

**Context.** `atharvkharbade/anisync-addon` merges personalisation into metadata
(`get_effective_meta_providers(user)`), Simkl scrobbling, and list sync. The brief
places all of that out of scope because Nuvio owns it.

**Decision.** Our `meta` handler takes **no user context**. No auth, no database,
no PII, no cookies. `behaviorHints.configurable: false`. The only per-install
variation is two non-secret query params (`titleLang`, `includeAdult`).

**Alternatives rejected**

- **Optional Simkl integration for anime lists:** duplicating a system Nuvio
  already has, and creating exactly the "tracking contamination" the brief warns
  against.
- **User accounts:** no need, no benefit, real privacy cost.
- **Config via `/configure`:** unnecessary. Nuvio preserves the manifest URL's
  query string and re-attaches it to every request — a native, zero-UI channel.

**Consequences.** The add-on is stateless and privacy-clean. And because we emit
`anilist:` ids, **Nuvio's existing Simkl anime tracking engages on its own** — we
get the benefit with none of the code. This is the clearest example of the scope
boundary paying for itself.

---

## ADR-016 — Kitsu-only titles are supported structurally, emitted later

**Status:** Accepted

**Context.** Some titles exist in Kitsu with no AniList id (e.g. Kitsu 11392 has
`anilist: null, mal: 31608`). We could render them fully from Kitsu but could not
emit `anilist:` — our canonical id.

**Decision.** Declare `idPrefixes: ["anilist:", "kitsu:"]` on the `meta` resource
**from day one**, and emit `kitsu:` ids only if Phase 2 shows such coverage is
material. Nuvio classifies `kitsu:`-prefixed ids as anime too, so the fallback is
behaviourally equivalent.

**Alternatives rejected**

- **Drop those titles:** silently losing content we can actually render.
- **Mint a synthetic id** (e.g. `anilist:x-kitsu-11392`): invents an id namespace
  that would collide with real AniList ids and corrupt Nuvio's tracking.
- **Emit `kitsu:` immediately:** adds an id scheme we may never need, and splits
  Nuvio's catalogue rows across two identities for no proven benefit.

**Consequences.** Costs one extra string in the manifest. Removes a hard failure
mode: we are never forced to drop a title because AniList lacks it.

---

## Decision index

| ADR | Decision | Reversible? |
|---|---|---|
| 001 | Canonical id = `anilist:<id>` | Hard — changing it breaks every saved reference |
| 002 | `idPrefixes` on the `meta` resource | Easy |
| 003 | Use `stremio-addon-sdk` | Easy |
| 004 | AniList → Kitsu → Jikan(optional) | Easy (config flag) |
| 005 | Bundled Fribb mapping dataset | Medium |
| 006 | Our own domain model | Hard — touches everything |
| 007 | 13–15 curated catalogs | Easy |
| 008 | `skip` pagination, pages of 100 | Easy |
| 009 | Emit both `country` and `countryOfOrigin` | Trivial |
| 010 | Never return 5xx | Easy |
| 011 | Fallback only on transient errors | Medium |
| 012 | 5 cache layers, no disk in v1 | Easy |
| 013 | Docker + long-running host | Easy (infra change) |
| 014 | Batching + 25/min bucket | Easy |
| 015 | No user context / no tracking | By design, permanent |
| 016 | `kitsu:` declared, emitted later | Easy |