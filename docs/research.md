# Research: Anime Catalog Add-on for Nuvio

> **Research phase complete.** Every non-obvious technical claim in this
> documentation set is either verified from primary source (official source code,
> official docs, live API probes) or explicitly marked **UNVERIFIED**.
>
> This document is the ecosystem overview. Deep dives live in:
> [`data-sources.md`](./data-sources.md) ·
> [`nuvio-compatibility.md`](./nuvio-compatibility.md) ·
> [`sdk-reference.md`](./sdk-reference.md) ·
> [`id-mapping.md`](./id-mapping.md) ·
> [`catalog-design.md`](./catalog-design.md) ·
> [`architecture.md`](./architecture.md) ·
> [`decisions.md`](./decisions.md) ·
> [`roadmap.md`](./roadmap.md)

---

## 1. What Nuvio is

Nuvio is a **native, Kotlin Multiplatform media client** — Android, iOS, plus
JavaScript builds for webOS/Tizen and desktop — that speaks the Stremio Add-on
Protocol. It is a *client*, not a website, and not an aggregator with its own
content database.

It is a mature, actively-developed client (3.7k stars on `NuvioMobile`, commits
landing in the research window). Most importantly for us: **its source code is
public**, so add-on compatibility is a matter of reading the client rather than
guessing. This project validated Nuvio behaviour almost entirely from source
rather than documentation — see [`nuvio-compatibility.md`](./nuvio-compatibility.md).

Nuvio also owns the user-state layer itself — Trakt, Simkl, MDBList,
watch progress, lists, profiles. That is precisely why our brief excludes them.

---

## 2. What a Stremio add-on is

A Stremio add-on is a small HTTP service that speaks a simple, URL-shaped
protocol. No SDK handshake, no WebSocket, no session — just five endpoints:

| Endpoint | Purpose |
|---|---|
| `/manifest.json` | what this add-on can do: types, resources, catalogs |
| `/catalog/{type}/{id}.json/{extras}` | catalogue pages and search results |
| `/meta/{type}/{id}.json` | full metadata for one item |
| `/stream/{type}/{id}.json` | playable sources (**out of scope for us**) |
| `/subtitles/{type}/{id}.json` | subtitle tracks (**out of scope for us**) |

The whole protocol is "manifest + URL routing + JSON in, JSON out". Anything
else — a database, a queue, a framework — is our implementation detail and
invisible to the client.

Clients discover add-ons by fetching a manifest URL the user supplies (or clicks
a link for), then issue the resource URLs the manifest advertises.

---

## 3. How add-ons communicate

```
   user installs  ──►  GET /manifest.json
                             │
                             │ manifest declares:
                             │   types:      ["anime", "movie"]
                             │   resources:  ["catalog", {name:"meta", …}]
                             │   catalogs:   [{type, id, name, extra:[…]}]
                             ▼
   client renders  ──►  GET /catalog/anime/anime-trending.json/skip=0
                             │          GET /meta/anime/anilist%3A21.json
                             ▼
   client caches   ◄──  Cache-Control: max-age=…, public
```

Key properties that shape our design:

- **Stateless.** Every request carries everything needed. Our config rides in the
  manifest URL's query string (Nuvio preserves it).
- **The manifest is the contract.** Clients read it to decide what to fetch, and
  — as Nuvio shows — to decide which features are even *available*.
- **Caching is first-class.** `Cache-Control` is the cheapest performance lever
  in the entire protocol, and Nuvio honours it with a 50 MB OkHttp disk cache.

---

## 4. What this project is

A **catalog and metadata add-on for anime**, following the Stremio Add-on
Protocol, installed into Nuvio.

It does:

- anime discovery (trending, popular, top-rated, seasonal, by genre, by format)
- catalogue pages with correct pagination
- search across the anime catalogue
- rich metadata: titles, synopsis, genres, tags, studios, relations, scores,
  images, airing information
- optional episode metadata (season/episode lists with titles)
- stable cross-source identifiers, and cross-links to AniList / MAL / Kitsu / AniDB
- optional enrichment: logos and backdrops from TMDB, episodes from AniZip

Its primary source is **AniList**, with **Kitsu** and **Jikan** as fallbacks.

---

## 5. What this project is NOT

Explicitly, and by design:

| Not | Why |
|---|---|
| **A streaming add-on** | no `stream` resource, no scrapers, no source extraction |
| **A watch-progress system** | Nuvio owns it via Trakt / Simkl |
| **A user-list system** | Nuvio owns it |
| **An account system** | no auth, no database, no PII |
| **A Trakt / Simkl / MDBList integration** | same reason |
| **A host for video** | obviously |

**A deliberate, load-bearing boundary:** Nuvio parses `anilist:`-prefixed IDs and
classifies such titles as anime for its own tracking. By emitting `anilist:<id>`
we make Nuvio's existing tracking work — **without us implementing any of it**.
That is the payoff of the scope boundary.

---

## 6. Important ecosystem constraints

These are the non-obvious findings that most shaped the design. Each is verified
in the linked document.

### 6.1 AniList is rate-limited to 30 req/min — officially "degraded"

✅ Live header: `x-ratelimit-limit: 30`.
📄 Official docs: *"The API is currently in a degraded state and is limited to
**30 requests per minute**. This is a temporary measure until the API is fully
restored."* — above the nominal 90/min.

**This is the single most consequential fact in the project.** It makes caching
not an optimisation but the architecture. See [`architecture.md` §4–5](./architecture.md).

Mitigations: token-bucket limiter at 25/min, batch queries (`id_in`, `idMal_in` ✅
exist), single-flight dedup, five cache layers, stale-while-revalidate,
and a planned rate-limit raise request.

### 6.2 AniList exposes only TWO identifiers

✅ Introspection of `Media` (55 fields): `id` and `idMal`. No `idKitsu`, no
`externalIds`, and `externalLinks` contains **zero** database IDs — verified live
on One Piece (13 streaming/social links) and Cowboy Bebop (7).

> Common belief to discard: "AniList has an `externalIds` field (tmdb, imdb,
> anidb…)" — **it does not exist in the current schema**; querying it returns 400.

Consequence: cross-ID mapping is a real subsystem, not a lookup.
See [`id-mapping.md`](./id-mapping.md).

### 6.3 A bulk mapping dataset exists and is excellent

✅ `Fribb/anime-lists/anime-list-full.json` — 7.49 MB, 39,577 records, pushed
2026-09-29. Trimmed to 10 fields it becomes **32,363 records / 459 KB gzipped**
with MAL 95%, AniList 64%, Kitsu 64%, TMDB 26%, IMDb 25% coverage.

⚠ **`AniList/anime-lists` is 404 / gone** — which is the mapping source the
reference add-on `demdex/nuvio-anime` builds from.

### 6.4 AniZip's documented host is dead; the real one is `api.ani.zip`

⚠ `anizipapi.com` / `api.anizipapi.com` return nothing. ✅ `api.ani.zip` works
and returns **every** cross-database ID in one request:

```json
"mappings": { "anilist_id":1, "mal_id":1, "kitsu_id":1, "anidb_id":23,
              "thetvdb_id":76885, "imdb_id":"tt0213338", "themoviedb_id":"30991" }
```

Keyless, Cloudflare-cached (`max-age=900`), no rate limiting observed.
But: payloads reach **1.87 MB** for long series, and episode numbering does
**not** align across AniList/MAL/TVDB.

### 6.5 Nuvio's manifest `extra` array is a feature switchboard

Verified from source:

| Declared extra | Home row | Paginates | Searchable | Genre filter |
|---|---|---|---|---|
| `{name:"skip"}` | ✅ | ✅ | — | — |
| `{name:"genre",options:[…]}` | ✅ | — | — | ✅ |
| `{name:"search"}` | ✅ | — | ✅ | — |
| **anything with `isRequired:true`** | ❌ | | | |

So a single wrong `isRequired` silently deletes a catalog from Nuvio's Home.

And: `search` on a catalog means Nuvio sends a search request to **that catalog**.
Declaring it on 13 catalogs = 13 requests per search.

### 6.6 Nuvio reads `country` and `language` — not the standard field names

✅ Exhaustive grep of `NuvioMobile`: `countryOfOrigin` and `audioLanguage` appear
**nowhere** in meta parsing. `MetaDetailsParser.kt:52,54` read `country` and
`language`.

Mitigation: emit **both** spellings — costs ~40 bytes and keeps Stremio and
other clients working.

### 6.7 Nuvio's meta budget is 5 seconds

✅ `MetaDetailsRepository.FETCH_TIMEOUT_MS = 5_000L`. Exceed it and Nuvio silently
skips our add-on for that item.

This single number sets every timeout in our architecture
(3.5 s meta, 3 s catalog, 1.5 s enrichment, 4.5 s global deadline).

### 6.8 The SDK caps the manifest at 8 KB

✅ `builder.js:22`. Combined with §6.5, this rules out "one catalog per genre"
and "declare genre options everywhere". See
[`catalog-design.md`](./catalog-design.md).

### 6.9 Jikan could not be verified as reachable

⚠ `api.jikan.moe` timed out at TCP level on both IPv4 and IPv6 from the research
environment, repeatedly, while AniList/Kitsu/AniZip/TMDB responded normally.
Its docs host works.

Consequence: **Kitsu is promoted to fallback #1**, Jikan demoted to an optional,
config-gated last resort that can never block a response.
See [`data-sources.md` §2](./data-sources.md).

### 6.10 Nuvio interprets unprefixed numbers as Trakt IDs

✅ `TrackingMedia.kt parseTrackingExternalIds()` has a catch-all:
`else -> TrackingExternalIds(trakt = full.toLongOrNull())`.

Emitting `"21"` would make Nuvio look up Trakt #21. **Every ID must be prefixed.**

---

## 7. Source comparison (summary)

| | AniList | Kitsu | Jikan | TMDB | AniZip |
|---|---|---|---|---|---|
| Role | **primary** | fallback #1 | fallback #2 | enrichment | episodes |
| Reachable ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Auth | none | none | none | **key** | none |
| Rate limit | **30/min** | none advertised | 3/s, 60/min 📄 | 📄 | none |
| Cross IDs | `id`,`idMal` | via `/mappings` | `mal_id` | `imdb_id`,`tvdb_id` | **all** |
| Episode titles | ❌ | ✅ | ✅ 📄 | ✅ 📄 | ✅ localized |
| Images | cover + banner | poster + cover + dimensions | jpg/webp 📄 | **logos**, backdrops | TVDB art (hotlinks ✅) |
| Tags | ✅ rich + ranked | categories | themes/demographics 📄 | keywords 📄 | ❌ |
| Airing | ✅ UTC schedules | `startDate`/`nextRelease` 📄 | `/schedules` 📄 | air dates 📄 | `airDateUtc` |
| Maintained | ✅ live | ✅ `updatedAt` current | ❓ | ✅ live | ✅ live |

---

## 8. Reference projects — what to copy, what to avoid

### 8.1 `demdex/nuvio-anime` — architectural reference (rated 6/10 reuse)

**Adopt**

| Pattern | Why |
|---|---|
| Stale-while-revalidate cache with a 24 h grace (`cache.js:22`) | the single best resilience idea in the codebase — when AniList returns 403 site-wide, users keep seeing content instead of empty rows |
| Single-flight dedup (`cache.js:59-86`) | prevents thundering-herd GraphQL calls on Home refresh |
| ID normalisation with a clean `mal:` → `anilist:` fallback | predictable degradation when a mapping is missing |
| Unmapped titles still shown (`meta.js:181-202`) | added to fix a real production outage where a failed mapping blanked every catalog for 24 h |

**Avoid**

| Problem | Evidence |
|---|---|
| **AniList is the de-facto contract.** Every adapter normalises *to the AniList shape*; "fallbacks" are subordinate | `jikan.js:106-154`, `kitsu.js:98-145` — no interface, just shape-compatible objects |
| No `Source` interface; `withFallback` assumes shape compatibility with no compile-time or runtime contract | `source.js:28-52` |
| **Mapping built from a dead URL** (`AniList/anime-lists` → 404) | `build-mapping.js:20`, `mapper.js:27` |
| 7 MB mapping download on cold start when no bundle exists — can time out serverless | `mapper.js:212-214` |
| **ID choice is streaming-oriented**: prefers `tt…`/`tmdb:` for scraper compatibility. Wrong for a catalog-first add-on — IMDb exists for only ~25% of anime, and Nuvio rewrites `tmdb:`→IMDb anyway | `mapper.js:268-281` |
| 19 catalogs of which 8 (kids) ignore the `enabledCatalogs` config — config has partial effect, undocumented | `server.js:73-81` |
| Ad-hoc field deletion lifecycle (`_mapped`, `_anilistId`, `_lookup`, `_videoSuffix` deleted in one path, re-added in another) | `meta.js:194-198` vs `meta.js:270` |
| Outdated deps: `node-fetch@2` on Node 20 | `package.json:21` |

Its test suite (106 checks, including AniList-403 failover and dual-outage) is
genuinely good and worth studying for failure-mode coverage.

### 8.2 `atharvkharbade/anisync-addon` — ID-resolution reference

Quart (async Python), a real Stremio add-on serving `/manifest`, `/catalog`,
`/meta`, `/stream`, plus MongoDB caching.

**Adopt the *idea*, not the machinery:** a resolver chain
`cache → ARM API → AniZip → Fribb` with prefix normalisation and per-direction
resolvers. That is exactly the shape of our [`id-mapping.md` §5](./id-mapping.md)
chain, arrived at independently.

**Avoid:** MongoDB `id_cache`/`fribb_mappings`, Fribb GitHub fetch + distributed
lock rebuild, `arm.haglund.dev` (untrusted third-party dependency), RPDB /
TopPosters key management, the Quart blueprint structure.

**And explicitly: its Simkl/Trakt personalisation layer.** Our brief leaves watch
state to Nuvio. AniSync's `get_effective_meta_providers(user)` / Simkl scrobbling
is exactly the contamination to avoid — and it is why our `meta` handler takes no
user context at all.

---

## 9. Key research findings that contradict common knowledge

Worth stating plainly, because each would have caused a bug:

| Common claim | Reality |
|---|---|
| AniList allows 90 req/min | ✅ 30/min today, officially "degraded" |
| AniList has `Media.externalIds` | ✅ **does not exist**; query → HTTP 400 |
| `Page.media` supports `search_as_broad` / `searchByAlias` | ✅ only `search` exists |
| `Page.media`'s `sort` is a single `MediaSort` | ✅ it is **`[MediaSort]`** — a list; a single value returns HTTP 400 |
| AniList honours `perPage: 100` | ✅ **silently clamps to 50** → 1 Nuvio page (100) costs **2** AniList requests |
| `MediaTag.category` is an object | ✅ a plain **String** (e.g. `"Cast-Traits"`); a sub-selection 400s |
| `MediaTag` has `isSpoiler` | ✅ renamed **`isMediaSpoiler`**; `isMediaRelevant` does not exist |
| `studios.edges[].isMainStudio` | ✅ `studios` uses `StudioEdge` → **`isMain`**; only `relations` uses `MediaEdge` |
| `coverImage.large` is the large image | ✅ it is a **medium**-sized URL; use `extraLarge` for posters |
| `MediaExternalLink.site` is an enum | ✅ plain `String`; values are "Crunchyroll", "Netflix", … |
| `externalLinks` contain Kitsu/TMDB/IMDb IDs | ✅ **no IDs at all** — streaming/social URLs only |
| `MediaStatus` includes `DELAYED` | ✅ `CANCELLED` and `HIATUS`, no `DELAYED` |
| AniZip is at `anizipapi.com` | ✅ real host is `api.ani.zip`; the other is dead |
| Kitsu has no genres (not in `attributes`) | ✅ true — but genres are a **relationship**, retrievable via `include=genres` |
| Kitsu mappings need `include=anime` | ✅ `400: "anime is not a valid relationship of mappings"`; use **`include=item`** |
| Kitsu id ≈ MAL id | ✅ MAL 21 → Kitsu 12; MAL 31608 → Kitsu 11392 |
| Kitsu sends `RateLimit-*` headers | ✅ **absent** in live responses |
| Jikan is a reliable fallback | ❌ **could not be verified as reachable** |
| `AniList/anime-lists` provides mappings | ✅ **404, repo is gone**; use `Fribb/anime-lists` |
| Nuvio reads `countryOfOrigin` / `audioLanguage` | ✅ reads `country` / `language` |
| Deep links support `anime` type | ✅ catalogue/search/details yes; `stremio://meta/anime/…` rejected |
| Nuvio needs `idPrefixes` to work at all | ⚠ it's a *routing filter*; without it you become a catch-all, not broken |

---

## 10. Documentation-set index

| Document | Answers |
|---|---|
| [`research.md`](./research.md) *(this file)* | ecosystem, scope, constraints |
| [`data-sources.md`](./data-sources.md) | every API: auth, endpoints, limits, strengths, weaknesses, evidence log |
| [`nuvio-compatibility.md`](./nuvio-compatibility.md) | exactly what Nuvio requests, parses, and gates on |
| [`sdk-reference.md`](./sdk-reference.md) | which SDK features we need, and their traps |
| [`id-mapping.md`](./id-mapping.md) | canonical identity, resolution chain, emission rules |
| [`catalog-design.md`](./catalog-design.md) | which catalogs, which extras, pagination, search |
| [`architecture.md`](./architecture.md) | layer contracts, fallback matrix, caching, deployment |
| [`decisions.md`](./decisions.md) | ADR-style record of decisions and alternatives |
| [`roadmap.md`](./roadmap.md) | phases, deliverables, acceptance criteria |

---

## 11. Confidence assessment

| Area | Confidence | Basis |
|---|---|---|
| Nuvio protocol behaviour | **Very high** | read from client source; `git ls-tree` + `git show` on NuvioMobile |
| AniList schema & limits | **Very high** | live introspection + live queries + live headers |
| Kitsu API shape | **High** | live JSON:API responses, mapping counts, header inspection |
| AniZip | **High** | live responses, all 5 params, image hotlink verified |
| SDK behaviour | **High** | source read, incl. 8 KB check and `qs.parse` detail |
| Fribb dataset | **High** | downloaded and parsed locally |
| Jikan | **Low** | API host unreachable; documented behaviour only |
| TMDB | **Medium** | host live (401), docs read; needs a key to verify anime coverage |
| Nuvio wiki content | **Low** | `nuvio.wiki` unreachable; client source + vendored Stremio docs used instead |