# Architecture

> **Status:** proposed, pending approval.
> **Stack:** TypeScript · Node.js 20+ · `stremio-addon-sdk` · Vitest · no framework.
> Everything factual about external systems is cited; see
> [`data-sources.md`](./data-sources.md) and
> [`nuvio-compatibility.md`](./nuvio-compatibility.md).

---

## 1. Architecture at a glance

```
                          ┌──────────────────────────────┐
   Nuvio / Stremio  ─────► │  HTTP layer  (SDK + express) │  CORS · routing · lint
                          └───────────────┬──────────────┘
                                          │
                          ┌───────────────▼──────────────┐
                          │  addon/  manifest · catalog   │  protocol shape only
                          │           · meta              │
                          └───────────────┬──────────────┘
                                          │
                          ┌───────────────▼──────────────┐
                          │  services/                   │
                          │   catalog.service            │  orchestrates: cache →
                          │   meta.service               │  source → mapping →
                          │   search.service             │  normalize → render
                          │   resolve.service            │
                          └───────┬───────────────┬───────┘
                                  │               │
                    ┌─────────────▼──────┐   ┌────▼──────────────────┐
                    │  SourceResolver    │   │  IdentityResolver     │
                    │  (ordering,        │   │  (canonical + cross-  │
                    │   fallback,        │   │   ids, cache)         │
                    │   timeout, circuit)│   └────┬──────────────────┘
                    └─────────────┬──────┘        │
                                  │               │
              ┌───────────────────┼───────────────┼────────────────┐
              ▼                   ▼               ▼                ▼
        ┌──────────┐        ┌──────────┐   ┌──────────────┐  ┌──────────┐
        │ AniList  │        │  Kitsu   │   │ Identity     │  │  AniZip  │
        │ adapter  │        │ adapter  │   │  Bundle      │  │  adapter │
        │ (primary)│        │ (fb #1)  │   │ (Fribb)      │  │ (enrich) │
        └────┬─────┘        └────┬─────┘   └──────────────┘  └────┬─────┘
             │                   │                               │
             └─────────┬─────────┴───────────────────────────────┘
                       ▼
             ┌─────────────────────┐        ┌──────────────────────┐
             │  Normalizer         │        │  Enrichment          │
             │  source → Anime      │        │   images · episodes  │
             └──────────┬──────────┘        └──────────┬───────────┘
                        └──────────────┬────────────────┘
                                       ▼
                             ┌──────────────────┐
                             │  Renderer        │
                             │  Anime → Stremio │
                             └──────────────────┘

  ┌───────────────────────────────────────────────────────────┐
  │  cross-cutting:  HttpClient (timeout, retry, UA)          │
  │                    Cache (TTL + stale-while-revalidate)    │
  │                    RateLimiter (per-source token bucket)  │
  │                    Logger  ·  Config (env + query)        │
  └───────────────────────────────────────────────────────────┘
```

---

## 2. Layer contracts

The one rule: **each layer depends only on the interface below it, and on its
own domain types.** No adapter imports another adapter. No service imports an
adapter directly — it talks to `SourceResolver`.

```
transport ─▶ sources ─▶ domain ─▶ services ─▶ addon
              (implement Source)  (Anime)   (render Stremio)
```

### 2.1 `Source` — the adapter interface

```ts
interface Source {
  readonly name: 'anilist' | 'jikan' | 'kitsu' | 'tmdb' | 'anizip';
  /** True when configured/usable right now (e.g. TMDB needs a key). */
  isAvailable(): boolean;
  /** Cheap capability probe used to build catalogs and skip dead sources. */
  capabilities(): {
    catalog: boolean;
    search: boolean;
    meta: boolean;
    episodes: boolean;
    idMapping: boolean;
  };

  fetchCatalogPage(req: CatalogQuery): Promise<Anime[]>;
  search(req: SearchQuery): Promise<Anime[]>;
  fetchByIds(ids: IdentityQuery): Promise<Anime[]>;
  fetchByExternalIds(ids: IdentityQuery): Promise<Anime[]>;
  fetchEpisodes(canonical: AnimeIdentity): Promise<Episode[]>;
  resolveIdentity(id: UnknownId): Promise<Partial<AnimeIdentity> | null>;
}
```

> **The critical property:** `Anime[]` is *our* type, not AniList's. Adapters
> translate **into the domain**, never out of it. This is exactly what
> `demdex/nuvio-anime` fails at — every adapter normalises **to the AniList
> shape**, so AniList's schema is the real contract and "fallbacks" are
> subordinate.

### 2.2 Domain model

```ts
interface Anime {
  identity: AnimeIdentity;              // anilist is required

  title: {
    romaji?: string;
    english?: string;
    native?: string;
    synonyms?: string[];
  };
  displayTitle: string;                 // resolved once, used by the renderer

  description?: string;                 // plain text, normalised
  format: AnimeFormat;                  // AniList enum, normalised
  status: AnimeStatus;                  // AniList enum, normalised
  type: 'anime' | 'movie';              // Stremio type

  episodes?: number;
  durationMinutes?: number;

  releaseDate?: string;                 // ISO date
  releaseYear?: number;
  season?: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  seasonYear?: number;
  endDate?: string;

  genres: string[];                     // AniList genre strings
  tags: Tag[];                          // rank ≥ threshold, non-spoiler
  synonyms: string[];

  studios: Studio[];
  relations: Relation[];

  images: {
    poster?: string;
    background?: string;
    logo?: string;
    fanart?: string;
  };

  scores: {
    anilist?: number;                   // 0–100
    mal?: number;                       // 0–10
    kitsu?: number;                     // 0–100
  };

  airing?: AiringInfo;

  /** Where each field came from — powers debugging and merge precedence. */
  provenance?: Partial<Record<keyof Anime, string>>;
}

interface Episode {
  key: string;                          // "1", "S1" — AniList-relative
  number: number;
  season: number;                       // 0 for specials
  title?: string;
  overview?: string;
  thumbnail?: string;
  airedAt?: string;
  runtimeMinutes?: number;
  rating?: number;
}

interface Tag {
  id: number;
  name: string;
  rank: number;
  category: string;
}
```

> **`provenance`** is a deliberate investment. When a user reports "the poster is
> wrong", we can answer *which source* supplied it, instead of bisecting three
> adapters by hand. It costs one optional field and is worth it.

### 2.3 `SourceResolver`

Owns: ordering, timeouts, circuit breaking, fallback decisions, rate limiting.

```ts
class SourceResolver {
  constructor(sources: Source[], breaker: CircuitBreaker, log: Logger)

  async fetchCatalogPage(
    req: CatalogQuery,
    opts?: { preferred?: SourceName[] },
  ): Promise<{ items: Anime[]; source: SourceName; degraded: boolean }>

  async fetchByIdentity(id: AnimeIdentity): Promise<Anime | null>
}
```

**Fallback is per-capability, not global.** A source that can serve catalogs may
be unable to serve episodes.

---

## 3. Fallback strategy (the precise rules)

The brief asked us not to "blindly fallback on every error". Here is the exact
policy.

### 3.1 Error taxonomy

```ts
type SourceErrorKind =
  | 'not_found'        // 404, or data:null  → NOT a fallback trigger for meta
  | 'invalid_request'  // 4xx (except 408/429) → never retry, never fall back
  | 'rate_limited'     // 429 + Retry-After → do NOT fall back; wait & retry
  | 'server_error'     // 5xx → fall back
  | 'timeout'          // our deadline hit → fall back
  | 'network'          // DNS/TLS/reset → fall back
  | 'parse'            // malformed body → fall back + log loudly
```

### 3.2 Decision matrix

| Situation | Fall back? | Action |
|---|---|---|
| Catalog query returns **0 items** | ❌ | Success with an empty page. Zero results is an answer, not a failure. |
| Catalog query returns < requested | ❌ | Success. Short page is legitimate (end of list). |
| `anilist:99999999` → `data.media = null` | ❌ | `metas: []` + 60 s cache. Retrying Jikan/Kitsu is pure waste. |
| Invalid id format | ❌ | `metas: []`. No upstream call at all. |
| 400/401/403/404 | ❌ | Do not retry. If 403 is a known AniList outage, use **stale cache**. |
| 429 | ❌ | Respect `Retry-After`; serve **stale** if available; do **not** burn a second source — it likely shares the same upstream, and falling back converts one rate-limit event into two. |
| 5xx | ✅ | Try next source in the chain. |
| Timeout | ✅ | Try next source. |
| Network/DNS | ✅ | Try next source. |
| Malformed JSON | ✅ | Try next source; log with a body excerpt. |
| **All sources exhausted** | — | Serve **stale** (up to 24 h). Else `metas: []` with a short `Cache-Control` and a log at `error`. **Never 500.** |

> **The two rules that matter most:**
> 1. **"No results" is never a failure.** Treating an empty result as an error is
>    what makes naive fallback chains slow.
> 2. **Rate limiting is not a fallback trigger.** Falling back on 429 converts one
>    throttled request into N throttled requests across N providers, and we are
>    almost certain to be sharing a rate-limit domain. Serve stale instead.

### 3.3 Chain order

| Capability | Order |
|---|---|
| Catalog | AniList → Kitsu → Jikan(opt) |
| Search | AniList → Kitsu → Jikan(opt) |
| Meta | AniList → Kitsu → Jikan(opt) |
| Episodes | AniZip → Kitsu → (none) |
| ID resolution | Bundle → Kitsu `/mappings` → AniZip |

**Jikan is last and optional** because its host was unreachable during research
(`data-sources.md` §2.1). It is gated behind a config flag and never on the
critical path.

### 3.4 Timeouts

| Call | Timeout | Rationale |
|---|---|---|
| Catalog | **3 s** | leaves room inside Nuvio's 5 s meta budget |
| Meta | **3.5 s** | Nuvio's own timeout is 5 s; we must answer first |
| Enrichment (TMDB/AniZip) | **1.5 s** | must not eat the budget |
| ID resolution (live) | **1 s** | bundle should answer; this is a safety net |

Plus a **global 4.5 s deadline** per request, after which we render from whatever
we have. **Degraded output always beats no output.**

---

## 4. Caching

Five layers, each with one job.

### 4.1 Design

| Layer | Key | TTL | Stale grace | Store | Purpose |
|---|---|---|---|---|---|
| **L1 Response** | HTTP request URL | see §4.2 | — | memory | serve Nuvio's OkHttp cache, cut upstream load |
| **L2 Page** | `catalog:{id}:{genre}:{skip}` | 15 min | 6 h | memory | exact page → stable pagination |
| **L3 Meta** | `meta:anilist:{id}` | **7 d** | **30 d** | memory | meta changes rarely |
| **L4 Identity** | `resolve:{ns}:{value}` | **30 d** | 90 d | memory | ids are stable |
| **L5 Source** | raw upstream URL | 10 min | 1 h | memory | shields transient failures |

**No disk persistence in v1.** Rationale: correctness first. A restart empties the
cache and the system rebuilds from the bundled identity data plus live calls; the
stale-grace window then protects the first hours. Disk caching adds invalidation
bugs for a workload that is already ~99% cache hits. Revisit only if a measured
cold-start problem appears.

### 4.2 Response TTLs

| Resource | `cacheMaxAge` | Why |
|---|---|---|
| `/manifest.json` | **86400** (24 h) | changes only on release |
| Catalog — trending / airing / upcoming | **900** (15 min) | volatile |
| Catalog — top-rated / movies / OVA | **3600** (1 h) | stable |
| Catalog — seasonal | **3600** | changes 4×/year |
| Catalog — search | **1800** (30 min) | volatile + expensive |
| `/meta` | **604800** (7 d) | stable |
| Empty result | **60** | cheap negative caching |
| Error / no handler | **10** | allow quick recovery |

All wrapped with `stale-while-revalidate` and `stale-if-error` where we can
serve stale:

```
Cache-Control: max-age=900, stale-while-revalidate=21600, stale-if-error=86400, public
```

The SDK turns numeric `cacheMaxAge` / `staleRevalidate` / `staleError` on the
handler's return value into exactly this header (`getRouter.js:69-85`).

### 4.3 Stale-while-revalidate — the resilience core

> This is the single most important pattern in the project, borrowed from
> `demdex/nuvio-anime` (`cache.js:22`, `STALE_GRACE_SECONDS = 24h`) — the one
> thing about that codebase that is unambiguously right.

```
cache.get(key)          → fresh?  return
                        → stale?  return immediately + trigger background refresh
                        → miss?   fetch (single-flight)
```

Single-flight de-duplication: concurrent misses on the same key share one
upstream promise. Essential because Nuvio fires **parallel identical catalog
requests** on Home refresh (it dedups client-side too, but not across devices).

**Why this matters concretely:** AniList is officially *"currently in a degraded
state"*. When it degrades further, a naive implementation shows Nuvio users empty
catalogs. With stale-while-revalidate they see content for up to 24 h.

---

## 5. Rate limiting

AniList's **30 req/min** (✅ live-verified; nominally 90) is the binding
constraint. Defence in depth:

1. **Token bucket per source**, default AniList = **25/min** (17% headroom).
2. **Request coalescing** — `id_in` / `idMal_in` batch queries ✅ exist in the
   schema. N catalogues page → 1 AniList request, not N.
3. **Layered caches** (§4) absorb the majority of traffic.
4. **Single-flight** prevents duplicate concurrent upstream calls.
5. **Reactive**: read `x-ratelimit-remaining`; when `≤ 3`, stop issuing requests
   and serve stale until reset.
6. **Off-peak prefetch is NOT implemented.** Explicitly rejected for v1 — it
   multiplies complexity for a marginal gain over caching.

> **Planned action:** request a rate-limit raise from `contact@anilist.co`
> (documented, `data-sources.md` §1.2). 25/min supports roughly 3,600 catalog
> page views/hour. That is likely enough for launch, but a raise makes the
> fallbacks much less load-bearing.

---

## 6. Repository structure

```
anicata/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .env.example
├── README.md
│
├── docs/                          ← this documentation set
│
├── data/
│   └── identity.min.json.gz       ← Fribb-derived mapping bundle (≈459 KB)
│
├── scripts/
│   └── build-identity.ts          ← regenerates data/identity.min.json.gz
│
├── public/
│   └── logo.png                   ← manifest logo (relative URL, Nuvio-resolvable)
│
├── test/
│   ├── fixtures/                  ← recorded upstream payloads (no live calls)
│   └── *.test.ts
│
└── src/
    ├── index.ts                   ← composition root; serveHTTP
    │
    ├── addon/                     ← PROTOCOL LAYER (Stremio shapes only)
    │   ├── manifest.ts            ← manifest builder + 8 KB assertion
    │   ├── catalog.ts             ← catalog handler + extras parsing
    │   ├── meta.ts                ← meta handler
    │   └── errors.ts              ← empty-result / error helpers
    │
    ├── services/                  ← ORCHESTRATION
    │   ├── catalog.service.ts
    │   ├── meta.service.ts
    │   ├── search.service.ts
    │   └── resolve.service.ts     ← IdentityResolver orchestration
    │
    ├── sources/                   ← ADAPTERS (implement Source)
    │   ├── types.ts               ← the Source interface
    │   ├── anilist/
    │   │   ├── adapter.ts
    │   │   ├── queries.ts         ← GraphQL documents
    │   │   └── types.ts           ← AniList response types
    │   ├── kitsu/
    │   │   ├── adapter.ts
    │   │   └── types.ts
    │   ├── jikan/
    │   │   ├── adapter.ts
    │   │   └── types.ts
    │   ├── tmdb/
    │   │   ├── adapter.ts         ← enrichment only
    │   │   └── types.ts
    │   └── anizip/
    │       ├── adapter.ts         ← episodes + cross ids
    │       └── types.ts
    │
    ├── domain/                    ← CORE TYPES (no I/O)
    │   ├── anime.ts
    │   ├── episode.ts
    │   ├── identity.ts
    │   └── errors.ts              ← SourceError taxonomy
    │
    ├── identity/                  ← ID RESOLUTION
    │   ├── ids.ts                 ← parse / format / normalise
    │   ├── bundle.ts              ← Fribb bundle loader + 5 indices
    │   └── resolver.ts            ← the §5.2 chain
    │
    ├── normalize/                 ← source → domain
    │   ├── status.ts
    │   ├── format.ts
    │   ├── text.ts                ← HTML strip, attribution strip, length cap
    │   └── merge.ts               ← field-level merge w/ provenance
    │
    ├── render/                    ← domain → Stremio
    │   ├── meta-preview.ts
    │   ├── meta-detail.ts
    │   ├── videos.ts
    │   └── types.ts               ← extended Stremio types (banner, country…)
    │
    ├── cache/
    │   ├── store.ts               ← TTL + stale + single-flight
    │   └── policies.ts            ← TTL table
    │
    ├── net/
    │   ├── http.ts                ← timeout, UA, retry, header capture
    │   ├── limiter.ts             ← token bucket per source
    │   └── breaker.ts             ← circuit breaker
    │
    ├── config/
    │   └── index.ts               ← env + query-string config
    │
    └── util/
        ├── logger.ts
        ├── result.ts
        └── env.ts
```

### 6.1 Dependency rules (enforced by lint)

```
addon      → services, render, config
services   → domain, sources(Source iface), identity, cache, net
sources/*  → domain, cache, net          ← NEVER imports another adapter
identity   → domain, cache, net
normalize  → domain
render     → domain
domain     → nothing
```

Enforced with `eslint` `no-restricted-imports` + `import/no-restricted-paths`.
This is what keeps the architecture from decaying into the
`demdex/nuvio-anime` shape.

---

## 7. Data flow

### 7.1 Catalog request

```
GET /catalog/anime/anime-trending.json/skip=0
  → addon/catalog.ts      parse extras (skip as string → int)
  → L1/L2 cache           hit? → return + cacheMaxAge
  → catalog.service
      → SourceResolver.fetchCatalogPage({type, id, genre, skip, limit:100})
          → limiter.acquire('anilist')
          → breaker.canRequest('anilist')?
          → anilist adapter  →  Anime[]  (domain!)
      → normalize.merge (fill gaps, keep provenance)
      → render.metaPreview  →  Stremio MetaPreview[]
  → return { metas, cacheMaxAge }
```

### 7.2 Meta request

```
GET /meta/anime/anilist%3A21.json          (Nuvio, ≤5 s budget)
  → addon/meta.ts        decode id → "anilist:21"
  → parseIncomingId()    reject if malformed
  → L3 meta cache        hit? → return
  → meta.service
      → identity.resolver.resolveToCanonical("anilist:21")   [L4, ~0 ms]
      → SourceResolver.fetchByIdentity({anilist:21})
          → anilist adapter (full Media fragment)
      → [enrich, ≤1.5 s each, all optional, all parallel]
          → anizip  → episodes
          → tmdb    → logo/backdrop      (only if TMDB_API_KEY set)
      → render.metaDetail → { meta: {…, videos, links} }
  → return { meta, cacheMaxAge }
```

### 7.3 Degradation ladder

| Level | Condition | Response |
|---|---|---|
| **Full** | everything up | complete meta + videos + links |
| **No enrichment** | TMDB/AniZip down/slow | meta without `videos`; Nuvio renders a clean page |
| **Source fallback** | AniList 5xx | Kitsu-sourced meta (fewer tags) |
| **Stale** | all sources down, cached | stale value + `stale-if-error` header |
| **Minimal** | nothing cached | `metas: []` / `{meta:{id,type,name}}` — never 500 |

> The **Minimal** level still returns `id`, `type`, `name` so Nuvio renders
> *something* rather than treating the addon as broken.

---

## 8. Configuration

### 8.1 Two layers

**Environment** (deployment):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP port |
| `ANILIST_RATE_LIMIT` | `25` | req/min |
| `ENABLE_JIKAN` | `false` | Jikan is unreachable/unverified |
| `TMDB_API_KEY` | *(unset)* | TMDB disabled when unset |
| `TMDB_ENABLED` | `true` | kill switch |
| `CACHE_MAX_ENTRIES` | `10000` | LRU cap |
| `LOG_LEVEL` | `info` | |
| `STALE_GRACE_HOURS` | `24` | stale window |

**Query string** (per install, Nuvio-native ✅):

```
https://host/manifest.json?titleLang=english&includeAdult=false
```

Nuvio preserves the manifest URL's query and re-attaches it to every
catalog/meta URL (`nuvio-compatibility.md` §3.1). This is the cheapest
configuration channel and requires no `/configure` page.

| Param | Default | Values |
|---|---|---|
| `titleLang` | `english` | `english` \| `romaji` \| `native` |
| `includeAdult` | `false` | `true` \| `false` |

> **Never accept secrets from the query string** — it is stored in the user's
> add-on list in plaintext. TMDB/AniList credentials belong in env vars only.
> AniList needs no auth, so there is nothing to leak.

### 8.2 `behaviorHints`

```json
{ "configurable": false, "configurationRequired": false, "adult": false, "p2p": false }
```

`adult: false` because we filter `isAdult` server-side.

---

## 9. Error handling

| Situation | HTTP | Body | `Cache-Control` |
|---|---|---|---|
| Success | 200 | payload | resource TTL |
| Empty result | 200 | `{"metas":[]}` | `max-age=60` |
| Malformed id | 200 | `{"metas":[]}` | `max-age=60` |
| Not found | 200 | `{"metas":[]}` | `max-age=60` |
| All sources down, stale available | 200 | stale | `stale-if-error=86400` |
| All sources down, no cache | 200 | `{"metas":[]}` | `max-age=10` |
| Meta unresolvable | 200 | `{meta:{id,type,name}}` | `max-age=10` |
| Unexpected exception | 200 | `{"metas":[]}` | `max-age=10` |

**We never return 5xx.** Nuvio's behaviour on a catalog non-200 is to show an
error and drop the row; on a meta non-200 or malformed body it skips the addon
silently. Both are worse than an empty-but-valid response.

> **Engineering rule:** the HTTP handler wraps everything in
> `try/catch` and can only return a valid Stremio shape. There is no code path
> from an upstream failure to a non-200. This is enforced by a test that
> injects a throwing adapter and asserts a 200.

---

## 10. Deployment

### 10.1 Requirements

| Requirement | Source |
|---|---|
| Long-running process (warm cache is essential) | §4 |
| Native HTTPS (Nuvio requires a real origin) | ✅ `normalizeManifestUrl` → https |
| Env vars for secrets | §8 |
| No cold starts (cache loss = rate-limit storm) | §5 |
| Custom domain (addon identity) | good practice |

### 10.2 Recommendation: **Docker on Fly.io** (primary)

| Option | Fit | Verdict |
|---|---|---|
| **Docker + Fly.io** | long-running, volumes for optional disk cache, fast cold starts, cheap at low traffic, region-pinned egress | ✅ **recommended** |
| Railway / Render | equally viable, simpler ops | ✅ acceptable alternative |
| VPS + Docker Compose | cheapest at scale, full control, you own ops | ✅ best at high volume |
| **Vercel** | serverless; cold start kills L2–L5 caches → AniList 429s; 8 KB manifest *is* fine | ❌ **rejected** |
| **Cloudflare Workers** | no TCP to AniList issues in principle, but cold starts + short CPU/memory limits make the caches useless; a 24 h stale window needs a KV binding | ⚠ only with KV + D1; deferred |
| Lambda | same cold-start problem, worse | ❌ |

> **The decisive factor is not popularity — it is cache warmth.** At 30 AniList
> requests/min, a platform that evicts our cache between requests will
> self-DoS. That is why every serverless option is rejected.

### 10.3 Container

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run identity:build

FROM node:22-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/data  ./data
COPY --from=build /app/public ./public
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/manifest.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/index.js"]
```

### 10.4 Health

`GET /healthz` → `{status, uptime, cache:{entries,hits,misses}, sources:{…}}`.
No secrets, no internal URLs. Enough for a load balancer and for debugging
whether a source is down.

---

## 11. Observability

Structured JSON logs (one line per request):

```
{ts, level, reqId, route, type, id, genre, skip,
 durationMs, source, cache: "hit"|"stale"|"miss", degraded: bool, items: n}
```

Plus counters for `upstream.requests{source,status}`,
`upstream.ratelimit{source}`, `cache.{hit,miss,stale}`, `fallback{from,to}`.

Enough to answer: which source served this, why did it fall back, and are we
close to the AniList limit? No external service in v1.

---

## 12. Testing strategy

| Layer | Method | Fixtures |
|---|---|---|
| Adapters | unit | **recorded real payloads** per source (no live calls) |
| Normalizer | unit | table-driven per source shape |
| Renderer | snapshot | golden Stremio JSON |
| Cache | unit | fake timers — TTL, stale window, single-flight |
| Limiter / breaker | unit | fake clock |
| Resolver | unit | prebuilt small bundle |
| Services | integration | adapter fakes incl. throwing ones |
| **Handlers** | supertest | manifest lint, extras parsing, degradation |
| Manifest | unit | assert ≤ 8192, required fields present |

**Fixtures are recorded from live APIs** (already gathered during research) so
tests are deterministic and offline. A separate, opt-in `npm run test:live`
script hits the real APIs for smoke tests.

Non-negotiable tests:

1. Manifest ≤ 8192 bytes and passes the SDK linter.
2. Catalog `skip=0` and `skip=100` share **no** ids.
3. `skip` past the end → `metas: []`.
4. Every emitted id is prefixed.
5. Every item has `id`, `type`, `name`.
6. Malformed inbound id → 200 + `metas: []`, **zero upstream calls**.
7. A throwing adapter → 200, never 5xx.
8. 429 on the primary → stale served, **no** fallback call.
9. Empty result → no fallback call.
10. Single-flight: 10 concurrent misses → exactly 1 upstream call.

---

## 13. Why this architecture

| Brief requirement | How it is met |
|---|---|
| Separate mapping from enrichment | `identity/` vs `enrichment` inside adapters; `identity` never depends on `tmdb`/`anizip` |
| Never use titles as identity | `identity/ids.ts` rejects unprefixed ids; title match is last-resort and low-confidence |
| Don't couple to AniList | `Anime` is our type; adapters translate **into** the domain. AniList can be deleted and replaced without touching a service |
| Robust, non-blind fallback | §3.2 decision matrix; `not_found` and `rate_limited` explicitly do **not** fall back |
| Appropriate caching | 5 layers, resource-specific TTLs, stale-while-revalidate, single-flight |
| TMDB/AniZip optional | gated on config; every path completes without them (§7.3) |
| Streaming later without a rewrite | the seam is `meta.videos[]` + `identity` — a stream resource consumes both without touching catalogs |
| No watch progress / Trakt / Simkl | absent from the design entirely; Nuvio owns them and we feed it `anilist:` ids so its own tracking works |

---

## 14. Known weaknesses of this design

Honesty about what we are accepting:

1. **`anilist:` as canonical couples identity to AniList's uptime.** Mitigated by
   the Kitsu fallback chain, but a total AniList outage degrades the whole addon.
2. **No disk cache** — a restart re-fetches. Acceptable because the identity
   bundle is bundled and L2–L4 rebuild fast; would matter at much higher traffic.
3. **`videos[]` needs AniZip or Kitsu.** Without them the details page has no
   episodes. Acceptable for a catalog-first addon; this is the Phase 4 trade.
4. **Genre coverage is AniList-genre-shaped.** A title with only tags and no
   genre disappears from genre browse.
5. **Jikan is unverifiable.** Kept optional and last, but "MAL-backed data" as a
   fallback is currently theoretical.
6. **The 8 KB manifest limit** forecloses a richer Discover UX. If it ever
   becomes a problem the honest fix is a second addon with its own manifest
   rather than a bigger manifest.

---

## 15. Open questions

| # | Question | Impact | How to resolve |
|---|---|---|---|
| 1 | ~~AniList's max `perPage`?~~ | ✅ **resolved: clamped to 50** | closed 2026-10-04 |
| 2 | AniList 30/min — can we get a raise? | removes most fallback pressure | e-mail `contact@anilist.co` |
| 3 | Is Jikan actually up? | is fallback #2 real | probe from a normal network |
| 4 | Kitsu's real rate limit? | may need self-limiting tuning | docs are stale; probe carefully |
| 5 | Do we want Kitsu-only titles in v1? | `kitsu:` id emission | measure during Phase 2 |
| 6 | AniList `?x-large` resize suffix? | image sizing without client hints | probe image URLs |
| 7 | Do Stremio clients send a `date` extra? | seasonal catalog UX | check client behaviour |
| 8 | Does Nuvio truncate long descriptions? | description length cap | UI test on device |
| 9 | Is `AniZip` acceptable risk as a dependency? | episode data | monitor uptime; it is optional |
| 10 | Nuvio `banner` on catalog vs `background` — which wins visually? | image selection | render test on device |