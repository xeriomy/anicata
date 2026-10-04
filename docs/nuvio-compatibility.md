# Nuvio Compatibility Report

> **Verification basis.** Every non-obvious claim below was verified by reading the
> actual Nuvio client source (`NuvioMedia/NuvioMobile`, branch `cmp-rewrite`, cloned
> blobless into `/tmp/opencode/research/nuviamobile`) or by live HTTP probes.
> File paths and line references are given as evidence. Anything I could not
> confirm from source is explicitly marked **UNVERIFIED**.

---

## 1. Executive summary — the five facts that shape the design

| # | Finding | Consequence for this add-on |
|---|---|---|
| 1 | Nuvio speaks the **plain Stremio protocol** over HTTPS. Nothing exotic. | We can use `stremio-addon-sdk` with no Nuvio-specific code. |
| 2 | Nuvio **routes `meta` requests by `idPrefixes`** on the `meta` resource, matched with `id.startsWith(prefix)`. | Declaring `idPrefixes: ["anilist:"]` makes Nuvio ask us *only* for our own IDs. Omitting it makes us a catch-all for every addon in the app. |
| 3 | Nuvio **parses `anilist:` / `mal:` / `kitsu:` / `anidb:` ID prefixes natively** and classifies such titles as `ANIME`, routing them to its Simkl/Trakt anime tracking. | Emit `anilist:<id>`. We get correct anime classification *and* watch-state sync for free, with no IMDb/TMDB dependency. |
| 4 | Catalog `extra` declarations **gate** features: no `isRequired` extra → appears on Home; `extra:[{name:"skip"}]` → paginates; `extra:[{name:"search"}]` → searchable; `extra:[{name:"genre",options:[…]}]` → browse-by-genre. | Manifest `extra` is a feature switchboard, not documentation. Getting it wrong silently removes catalogs from Home. |
| 5 | Nuvio caches addon responses in a **50 MB OkHttp disk cache** and honours standard `Cache-Control`. | Correct `Cache-Control` headers are one of the highest-leverage performance features we have. |

---

## 2. What Nuvio is

Nuvio is a **native media client** (Kotlin Multiplatform: Android, iOS, plus
JavaScript builds for webOS/Tizen and desktop). It is a Stremio-compatible client,
not a website.

Verified org inventory (`api.github.com/orgs/NuvioMedia/repos`):

| Repo | Language | Stars | Note |
|---|---|---|---|
| `NuvioMedia/NuvioMobile` | Kotlin | 3.7k | Android + iOS |
| `NuvioMedia/NuvioTV` | Kotlin | 2.9k | Android TV |
| `NuvioMedia/NuvioDesktop` | Kotlin | 1.6k | alpha |
| `NuvioMedia/NuvioTVSmart` | JavaScript | 731 | webOS / TizenOS |
| `NuvioMedia/self-host` | PLpgSQL | 155 | self-hosted backend |
| `NuvioMedia/nuvio-engine` | C++ | 19 | torrent engine, *under active development* |

The relevant client for this project is **`composeApp/`** inside `NuvioMobile`
(Kotlin Multiplatform, shared across Android and iOS).

> **Scope note.** `NuvioMedia/nuvio-engine` (streaming) and Nuvio's **Plugins**
> system (JS/WASM scraper plugins, `composeApp/src/fullCommonMain/.../plugins/`)
> are the future *streaming* layer. Both are **out of scope** — our brief
> explicitly excludes streaming. Documented here only so we do not accidentally
> design against them.

---

## 3. Add-on discovery and installation

Verified in `composeApp/src/commonMain/kotlin/com/nuvio/app/features/addons/AddonRepository.kt`.

### 3.1 URL normalisation (`normalizeManifestUrl`, lines 471–491)

```
stremio://host/manifest.json  →  https://host/manifest.json
example.com                   →  https://example.com/manifest.json
http(s)://…/manifest.json     →  kept as-is
```

- Fragment is stripped (`#…`).
- **The query string is preserved** and re-appended after `/manifest.json`.
- Paths not ending in `/manifest.json` get it appended.
- Installed add-ons are stored as a newline-separated list of manifest URLs in
  `SharedPreferences` (`addonUrlsKey = "installed_manifest_urls"`, per profile).

> **Implication.** Config-as-query-string works: an install URL of
> `https://host/manifest.json?titleLang=english` is preserved and the query is
> later re-attached to every catalog/meta URL (see §4.2). This is the
> configuration mechanism Nuvio actually honours. We do not need `/configure`.

### 3.2 Install-time validation

`AddonRepository.add(...)` (lines ~173–195) surfaces three failure modes:

| Condition | Result |
|---|---|
| Empty / unparseable URL | `AddAddonResult.Error(addon_invalid_url)` |
| URL already installed | `AddAddonResult.Error(addon_already_installed)` |
| Manifest fetch or parse throws | `AddAddonResult.Error(addon_load_manifest_failed)` |

**Required manifest fields** — enforced by `AddonManifestParser.requiredString`,
which **throws** on missing/blank (`AddonManifestParser.kt`, `requiredString`):

- `id`
- `name`
- `version`

**Optional** (missing is fine): `description`, `logo`, `catalogs`, `behaviorHints`.

> **Consequence.** Our manifest builder must guarantee `id`, `name`, `version` are
> always present. Everything else degrades gracefully.

### 3.3 `logo` URL resolution

`resolveAgainstManifest()` (`AddonManifestParser.kt`) resolves `logo` relative to
the manifest URL and accepts:

| Input | Result |
|---|---|
| `https://…` / `http://…` / `data:` | used verbatim |
| `//host/x.png` | `https://host/x.png` |
| `/x.png` | `<scheme>://<host>/x.png` |
| `logo.png` | `<manifest dir>/logo.png` |

> **Consequence.** A **relative** `logo` path works. Serving `/logo.png` from our
> own origin is valid and avoids a third-party image dependency in the add-on list.

---

## 4. Manifest schema as Nuvio parses it

Verified from `AddonManifestParser.parse()` and `AddonModels.kt`.

```jsonc
{
  "id": "…",                    // REQUIRED
  "name": "…",                  // REQUIRED
  "version": "…",               // REQUIRED
  "description": "…",           // optional
  "logo": "…",                  // optional, may be relative

  // Root-level defaults, inherited by every resource that omits them
  "types": ["anime", "movie"],
  "idPrefixes": ["anilist:"],

  // Either ["catalog","meta"] OR [{"name":"meta","types":[…],"idPrefixes":[…]}]
  "resources": [ { "name": "meta", "types": ["anime"], "idPrefixes": ["anilist:"] } ],

  "catalogs": [
    { "type": "anime",           // REQUIRED
      "id": "trending",          // REQUIRED
      "name": "Trending",        // optional; falls back to `id`
      "extra": [ { "name": "skip" }, { "name": "search" } ] }
  ],

  "behaviorHints": {
    "configurable": false,
    "configurationRequired": false,
    "adult": false,
    "p2p": false
  }
}
```

Parsing details that matter:

- `resources[]` entries may be **plain strings** or **objects**. Object entries fall
  back to root-level `types` / `idPrefixes` when omitted
  (`obj.stringList("types").ifEmpty { defaultTypes }`).
- `catalogs[].extra[]` entries read `name`, `isRequired`, `options`, `optionsLimit`.
  Entries without a `name` are dropped (`mapNotNull`).
- `behaviorHints` is entirely optional; unknown keys ignored
  (`Json { ignoreUnknownKeys = true }`).
- Nuvio reads **only** these `behaviorHints` keys: `configurable`,
  `configurationRequired`, `adult`, `p2p`.

---

## 5. Resource URL construction

Verified from `AddonTransportUrls.kt`.

```
base        = manifestUrl.substringBefore("?").removeSuffix("/manifest.json")
query       = "?" + manifestUrl.substringAfter("?")     // preserved!
catalog     = {base}/catalog/{type}/{id}.json
catalog+ext = {base}/catalog/{type}/{id}/{extra}.json
meta        = {base}/meta/{type}/{id}.json
```

### 5.1 ID encoding

`encodeAddonPathSegment()` percent-encodes everything **except** the RFC 3986
unreserved set:

```
kept: a-z A-Z 0-9 - _ . ~
everything else → %XX (uppercase hex)
```

> **Consequence.** `:` inside an ID **must** be percent-encoded as `%3A`.
> `anilist:21` → `anilist%3A21`. This is exactly what `encodeURIComponent` does,
> so using `encodeURIComponent` in the SDK is correct. But it is a real trap if
> anyone hand-rolls a URL.
>
> The Stremio SDK parses `extra` off the **raw** URL with `qs.parse`
> (`getRouter.js`, line ~59) precisely because `req.params` decodes `%26` and would
> break `&`-separated extras. Do not "helpfully" decode before handing to the SDK.

### 5.2 Extra segment format

Verified from `CatalogData.kt` → `buildCatalogUrl()` (lines ~180–200). Extras are
appended in **this exact order**:

```
search=<q>&genre=<g>&skip=<n>
```

Each value is percent-encoded with the same unreserved-char set; `skip` is omitted
when `null` or `0`.

> **Consequence.** Our catalog handler receives `args.extra` with string values
> (`{search: "…", genre: "…", skip: "…"}`) and must coerce `skip` itself.
> Order does not matter to us, but this confirms `&`-joined path extras, **not**
> query-string extras.

---

## 6. Catalog requests — how Nuvio calls us and parses the answer

### 6.1 Request

`fetchCatalogPage()` (`CatalogData.kt`) → `buildCatalogUrl()`.
`CATALOG_PAGE_SIZE = 100` (`CatalogData.kt`, line 16).

### 6.2 Response parsing — `HomeCatalogParser.parseCatalogResponse()`

```kotlin
val id   = meta.string("id")     // REQUIRED
val type = meta.string("type")   // REQUIRED
val name = meta.string("name")   // REQUIRED
if (id.isNullOrBlank() || type.isNullOrBlank() || name.isNullOrBlank()) continue  // item DROPPED
```

Items missing `id`, `type`, **or** `name` are **silently dropped**.

Fields Nuvio reads from each `metas[]` entry:

| JSON field | Used for | Notes |
|---|---|---|
| `id` | identity | required |
| `type` | identity | required |
| `name` | display | required |
| `poster` | portrait art | |
| `banner` | wide art | **Nuvio-specific**; falls back to `background`, then `landscapePoster` |
| `landscapePoster` | 16:9 art | **Nuvio-specific**, read explicitly |
| `logo` | logo | |
| `posterShape` | aspect | `"square"` \| `"landscape"` \| anything else → portrait |
| `description` | synopsis | |
| `releaseInfo` | year/date string | |
| `released` | `rawReleaseDate` | |
| `imdbRating` | rating chip | read as **string** |
| `genres` | genre chips | array of strings |

Dedup key: `stableKey() = "$type:$id"` (`HomeModels.kt`). Duplicate `(type,id)`
pairs within one page are dropped by the client too.

> **Consequence.** `banner` is a free win: AniList gives us `bannerImage`, and
> Nuvio prefers `banner` over `background`. We should emit `banner` for catalog
> items (cheap: one extra string) — it is the best-looking field in the grid.

### 6.3 Pagination — the exact semantics

```kotlin
val nextSkip = if (parsed.rawItemCount > 0) (skip ?: 0) + parsed.rawItemCount else null
```

- `rawItemCount` = **`metas.length` as received**, *not* the deduped count.
- `nextSkip` advances by **however many items we returned**.
- Returning `metas: []` ends pagination (`nextSkip = null`).
- Returning fewer than requested items is fine — `skip` simply advances by that many.

Pagination is **enabled** if either:
1. `catalog.supportsPagination()` — i.e. the manifest catalog declares an extra
   whose name `.equals("skip", ignoreCase = true)`; **or**
2. `page.rawItemCount >= CATALOG_PAGE_SIZE` (100).

> **Consequence (important).** **Return full pages of exactly 100 items.** That
> keeps `skip` arithmetic exact and keeps Nuvio's infinite scroll healthy even if
> it ignores our `skip` declaration. Also: **never** return the same items twice
> for a given `skip`, or Nuvio's `consecutiveDuplicatePages` guard
> (`DUPLICATE_CATALOG_PAGE_ADVANCE_LIMIT = 3`) will terminate pagination early.
> And since `skip` is derived from *our* returned length, a short page is
> self-consistent — but a short page caused by an upstream page boundary is not.

### 6.4 In-flight de-duplication

Nuvio de-duplicates **concurrent identical catalog URLs** client-side via an
`inflightRequests` map keyed on `(url, forceRefresh)` (`CatalogData.kt`,
`deduplicatedHttpGetText`). `forceRefresh` sends `Cache-Control: no-cache`.

---

## 7. Catalog gating — what the manifest `extra` controls

This is the single highest-value Nuvio-specific knowledge in the project.

### 7.1 Home screen rows

```kotlin
// HomeCatalogDefinitions.kt
manifest.catalogs.filter { catalog -> catalog.extra.none { it.isRequired } }
```

> **A catalog with ANY `isRequired: true` extra never appears on the Nuvio Home
> screen.** All our browse catalogs must have every extra declared with
> `isRequired` absent or `false`.

Each home row's default title is rendered as `"<catalog.name> · <Type>"` using
`localizedMediaTypeLabel()`.

### 7.2 Search

```kotlin
// SearchRepository.kt
private fun AddonCatalog.supportsSearch(): Boolean =
    extra.any { it.name == "search" } &&
        extra.none { it.isRequired && it.name != "search" }
```

Exact, **case-sensitive** `"search"` match. Note this differs from `skip`, which is
matched case-**insensitively**.

Every matching catalog across every installed add-on receives a search request:

```kotlin
// SearchRepository.kt buildSearchRequests()
manifest.catalogs.filter { it.supportsSearch() }.map { … SearchCatalogRequest(…) }
```

> **Consequence.** Declaring `search` on N catalogs means **N upstream queries per
> user search**. At a 30 req/min AniList budget this is a real cost. Design
> decision: declare `search` on **exactly one** catalog (`anime-search`), not on all.

### 7.3 Browse / Discover by genre

```kotlin
private fun AddonCatalog.supportsDiscover(): Boolean {
    if (extra.any { it.name == "search" && it.isRequired }) return false
    return extra.none { property ->
        when (property.name) {
            "genre" -> property.isRequired && property.options.isEmpty()
            "skip"   -> false
            "search" -> false
            else     -> property.isRequired
        }
    }
}
```

Genre options come from:

```kotlin
private fun AddonCatalog.genreExtra() = extra.firstOrNull { it.name == "genre" }
… genreOptions = genreExtra?.options.orEmpty(), genreRequired = genreExtra?.isRequired == true
```

Selection resolution:

```kotlin
when {
    genreOptions.isEmpty()                              -> null   // no genre sent
    requestedGenre in genreOptions                      -> requestedGenre
    genreRequired                                      -> genreOptions.first()
    else                                               -> null
}
```

> **Consequence.** Declaring
> `{"name":"genre","options":["Action", …]}` (not required) gives Nuvio a populated
> genre filter that defaults to "All genres". The option strings must **exactly
> match** what our handler accepts, and must match AniList `Genre` enum strings.

### 7.4 The `extra` matrix

| Declared extra | Home row | Paginated | Searchable | Genre filter |
|---|---|---|---|---|
| `{name:"skip"}` | ✅ | ✅ | — | — |
| `{name:"genre",options:[…]}` | ✅ | — | — | ✅ (options shown) |
| `{name:"search"}` | ✅ | — | ✅ | — |
| `{name:"search",isRequired:true}` | ❌ | — | ✅ | ❌ (disables Discover) |
| `{name:"genre",isRequired:true}` | ❌ | — | — | forced to `options[0]` |
| any other `{isRequired:true}` | ❌ | — | ❌ | ❌ |

---

## 8. Meta requests — how Nuvio calls us and parses the answer

### 8.1 Routing — the `idPrefixes` filter

```kotlin
// MetaDetailsRepository.kt findMetaManifests()
manifest.resources.any { resource ->
    resource.name == "meta" &&
        resource.types.contains(type) &&
        (resource.idPrefixes.isEmpty() || resource.idPrefixes.any { id.startsWith(it) })
}
```

Three conditions, all required:

1. `resource.name == "meta"`
2. `resource.types` contains the requested `type`
3. `idPrefixes` is **empty** (match everything) **or** the id starts with one of them

> **Consequence — the most important design decision in this report.**
> We declare `{ "name": "meta", "types": ["anime"], "idPrefixes": ["anilist:"] }`.
> Nuvio then asks us **only** for ids beginning with `anilist:` — our own ids.
> Without `idPrefixes`, our addon becomes a candidate for *every* id in the app,
> including IMDb and TMDB ids from other add-ons, adding latency and risk to
> unrelated content.

`MetaDetailsRepository` also tries, in order:

1. each matching manifest's `/meta/{type}/{id}.json`, with a **5 s timeout**
   (`FETCH_TIMEOUT_MS = 5_000L`);
2. `TmdbMetadataService.fetchStandaloneMeta()` as a last-resort fallback.

> **Consequence.** Our `/meta` handler has a hard **5-second budget** before Nuvio
> gives up on us. This makes aggressive caching and strict upstream timeouts
> mandatory, not optional.

Special case — TMDB id translation:

```kotlin
// resolveMetaLookupId()
val tmdbId = itemId.takeIf { it.startsWith("tmdb:", true) }?.substringAfter(':')…?.toIntOrNull()
    ?: return itemId
return TmdbService.tmdbToImdb(tmdbId, …) ?: itemId
```

If an id starts with `tmdb:`, Nuvio rewrites it to an IMDb id before calling us.
We will not receive `tmdb:`-prefixed meta requests. **UNVERIFIED** whether this
runs for our addon specifically — it runs unconditionally on the requested id.

### 8.2 Response envelope

```kotlin
private fun JsonObject.extractMetaObject(): JsonObject? {
    val data = this["data"].asJsonObjectOrNull()
    return listOfNotNull(
        this["meta"].asJsonObjectOrNull(),                       // ← standard
        data?.get("meta").asJsonObjectOrNull(),
        data?.takeIf { it.looksLikeMetaObject() },
        this.takeIf { it.looksLikeMetaObject() },
    ).firstOrNull()
}
```

> The standard Stremio `{ "meta": { … } }` envelope is accepted first. Use it.

### 8.3 Required meta fields

`requiredString` **throws** on missing:

- `id`, `type`, `name`

If `parse()` throws, `tryFetchMeta` catches it, logs, returns `null`, and Nuvio
falls through to the next candidate add-on. A malformed meta body = silent failure
from the user's perspective.

### 8.4 Fields Nuvio reads from `meta`

| JSON field | Type read | Notes |
|---|---|---|
| `id`, `type`, `name` | string | **required** |
| `imdb_id` | string | **snake_case** — not `imdbId` |
| `poster` | string | |
| `background` | string | falls back to `landscapePoster` |
| `landscapePoster` | string | Nuvio-specific |
| `logo` | string | |
| `description` | string | |
| `releaseInfo` | string | |
| `lastAirDate` | string | ISO date, for year-range display |
| `status` | string | |
| `imdbRating` | string | |
| `ageRating` | string | or `app_extras.certificationLocal` / `app_extras.certification` |
| `runtime` | string | |
| `genres` | string[] | |
| `director` | string[] **or** CSV string | also `app_extras.directors[]`, `links[category=director\|directors]` |
| `writer` | string[] **or** CSV | also `app_extras.writers[]`, `links[category=writer\|writers\|screenplay]` |
| `cast` | string[] **or** CSV | also `app_extras.cast[]`, `links[category=cast\|actor\|actors]` |
| `country` | string | ⚠ **Nuvio reads `country`, NOT `countryOfOrigin`** |
| `awards` | string | |
| `language` | string | ⚠ **Nuvio reads `language`, NOT `audioLanguage`** |
| `website` | string | |
| `trailers[]` | `{id?,key\|source\|ytId\|ytid,name?,site?,size?,type?,official?,published_at\|publishedAt,seasonNumber\|season_number,displayName?}` | `key` is required |
| `links[]` | `{name, category, url}` — **all three required** | doubles as cast/director/writer source |
| `videos[]` | see §8.5 | |
| `behaviorHints.hasScheduledVideos` | bool | |
| `behaviorHints.defaultVideoId` | string | |
| `app_extras.seasonPosters` | object or array | season posters |

### 8.5 The `videos[]` schema

```kotlin
MetaVideo(
    id,                                   // required
    title = video.string("title") ?: video.string("name"),   // one of the two required
    released   = video["released"],
    available  = video["available"] ?: true,
    thumbnail  = video["thumbnail"],
    seasonPoster = video["seasonPoster"] ?: video["season_poster_path"],
    season   = video["season"],   // Int
    episode  = video["episode"],  // Int
    overview = video["overview"] ?: video["description"],
    runtime  = parseRuntimeMinutes(video["runtime"]),
    rating   = video["rating"]?.toDoubleOrNull(),
    streams  = embeddedStreams(),  // ← embedded streams supported!
)
```

`embeddedStreams()` reads `streams[]` entries with `url` \| `infoHash` \|
`externalUrl`, `name`, `description`\|`title`, `fileIdx`, `type`, and
`behaviorHints.{bingeGroup,notWebReady,videoSize,filename,proxyHeaders}`.

> **Consequence.** `videos[]` is how Nuvio renders seasons/episodes. For a
> catalogue-only add-on we can ship an **empty `videos`** array (or omit it) and
> Nuvio renders a clean details page with no episodes. Populating episodes is a
> **Phase 4** enrichment (AniZip) — and it is where a future streaming layer will
> hook in. This is the designed seam.

### 8.6 Two Nuvio-specific divergences to respect

| Standard Stremio | Nuvio reads | Mitigation |
|---|---|---|
| `countryOfOrigin` | `country` | emit **`country`** (and `countryOfOrigin` too, for other clients) |
| `audioLanguage` | `language` | emit **`language`** (and `audioLanguage` too) |

Verified exhaustively: grepping the whole `NuvioMobile` tree for
`countryOfOrigin` / `audioLanguage` in meta-parsing context returns **only**
`MetaDetailsParser.kt:52` (`country`) and `:54` (`language`).

> **Mitigation, decided:** emit **both** spellings for these two fields. Costs ~40
> bytes, keeps Stremio and other clients working, and satisfies Nuvio. This is the
> right call for a compatibility-focused add-on.

---

## 9. Content types

### 9.1 `anime` is supported — with one caveat

`localizedMediaTypeLabel()` (`LocalizedUiText.kt`) handles `movie`, `series`,
**`anime`**, `channel`, `tv`. `SearchRepository.typeSortKey()` orders
`"movie" -> "0_movie"`, … `"anime" -> "2_anime"`.

**But** deep links reject it:

```kotlin
// AppUrlBridge.kt
private fun normalizeDeepLinkMediaType(value: String): String? =
    when (value.trim().lowercase()) {
        "movie","movies","film","films"         -> "movie"
        "series","show","shows","tv","tvshow","tvshows" -> "series"
        else                                     -> ""
    }
```

A blank type → the deep link is rejected (`AppDeepLink.Meta` is `null`).

| Path | `type: "anime"` |
|---|---|
| Catalog items | ✅ label + sort order present |
| Search results | ✅ |
| Details screen | ✅ (type passed through verbatim) |
| Home rows | ✅ |
| Tracking classification | ✅ (`TrackingMediaKind.ANIME`) |
| `stremio://meta/anime/…` deep link | ❌ rejected |

> **Consequence.** Use `type: "anime"` for catalog type (correct labelling,
> correct anime tracking). Accept that *deep links* into anime are not supported
> by Nuvio's deep-link parser. This is a Nuvio limitation, not ours, and it does
> not affect in-app navigation from a catalog row.

### 9.2 Anime tracking is first-class

```kotlin
// TrackingMedia.kt
fun parseTrackingExternalIds(rawValue: String?): TrackingExternalIds {
    if (full.startsWith("tt", true)) return TrackingExternalIds(imdb = …)
    return when (full.substringBefore(':').lowercase()) {
        "imdb"    -> …; "tmdb"   -> …; "tvdb"    -> …; "trakt" -> …
        "simkl"   -> …; "mal"    -> …; "anidb"  -> …;
        "anilist" -> TrackingExternalIds(anilist = value.toLongOrNull())
        "kitsu"   -> TrackingExternalIds(kitsu   = value.toLongOrNull())
        "mdblist" -> …
        else      -> TrackingExternalIds(trakt = full.toLongOrNull())  // ← bare number
    }
}

fun trackingMediaKind(contentType: String, ids: TrackingExternalIds) =
    when {
        ids.mal != null || ids.anidb != null || ids.anilist != null || ids.kitsu != null
            || contentType.trim().lowercase() == "anime" -> TrackingMediaKind.ANIME
        contentType in setOf("movie","film")               -> TrackingMediaKind.MOVIE
        else                                                -> TrackingMediaKind.SHOW
    }
```

Preference order for `stableKey()`: `simkl → imdb → tmdb → tvdb → trakt → mal →
anidb → anilist → kitsu → mdblist → title+year`.

> **Consequence — the core ID decision.** Emitting `anilist:21` gives Nuvio:
> - a prefix it can route on (`idPrefixes: ["anilist:"]`),
> - automatic `TrackingMediaKind.ANIME` classification,
> - a usable `anilist` identity for its Simkl anime list sync.
>
> We therefore **do not** need to mint IMDb/TMDB ids to make tracking work — unlike
> `demdex/nuvio-anime`, which prefers `tt…` ids for scraper compatibility
> (`mapper.js:268-281`). That is a streaming-oriented choice; ours is
> catalog-oriented. We still *expose* IMDb/TMDB in `links` for convenience.

> ⚠ **Bare-number ids are dangerous.** The `else` branch interprets an unprefixed
> number as a **Trakt id**. Emitting `21` would make Nuvio look up Trakt #21.
> **Always** prefix our ids.

---

## 10. Caching behaviour

Verified in `AddonPlatform.android.kt`.

```kotlin
private const val cacheSizeBytes = 50L * 1024L * 1024L
… Cache(directory = File(context.cacheDir, "addon_http"), maxSize = cacheSizeBytes)
```

- OkHttp with a standard **50 MB HTTP disk cache**.
- Timeouts: connect/read/write all **60 s**.
- `Proxy.NO_PROXY`, redirects followed (HTTP and SSL).
- `fetchAddonResponseText(url, forceRefresh)` sends `Cache-Control: no-cache`
  on user-initiated refresh only.

> **Consequence.** Nuvio **respects `Cache-Control`**. Serving
> `Cache-Control: max-age=3600, public` on catalog responses means an identical
> catalog page costs **zero upstream requests** for an hour across all users.
> This is the cheapest performance win available and it is fully under our control.
> Client disk cache is also capped, so very long `max-age` is safe.

---

## 11. Resources Nuvio actually requests

Grepping all of `composeApp/src/commonMain` for `resource = "…"` yields exactly:

| Resource | Location |
|---|---|
| `catalog` | `CatalogData.kt:194` |
| `meta` | `MetaDetailsRepository.kt:238` |
| `stream` | `StreamsRepository.kt:421`, `PlayerStreamsRepository.kt:384` |
| `subtitles` | **not requested via `buildAddonResourceUrl`** — see below |

Subtitles: `AddonSubtitleLoader.kt` exists and reads `lang`/`language`/
`languageCode`/`locale`/`label` fields, but it is **not** driven by
`buildAddonResourceUrl(..., resource = "subtitles", …)`.

> **UNVERIFIED:** whether Nuvio ever calls an add-on's `/subtitles` resource.
> The absence of any `resource = "subtitles"` call in `commonMain` suggests it does
> not, or does so from a platform-specific source set. **Design consequence:
> subtitles are out of scope for this project anyway.**

`addon_catalog` is **not** requested by Nuvio.

> **Consequence for scope.** We implement `catalog` + `meta` only. `stream` is
> out of scope per the brief. Advertise only `["catalog", "meta"]` in
> `resources` — do not advertise handlers we do not implement.

---

## 12. Error behaviour

| Condition | Nuvio behaviour | Verified in |
|---|---|---|
| Manifest missing `id`/`name`/`version` | install fails, generic error | `AddonManifestParser.requiredString` |
| Manifest unreachable / bad JSON | `addon_load_manifest_failed` | `AddonRepository.add` |
| Catalog non-200 | `errorMessage` from `network_request_failed_http`, `nextSkip = null` | `CatalogRepository.fetchPage` onFailure |
| Catalog `metas` empty | pagination ends (`nextSkip = null`); search shows "no results for catalog" | `CatalogData.kt`, `SearchRepository.kt:460` |
| Meta body missing `id`/`type`/`name` | `MetaDetailsParser` throws → addon skipped → next candidate → TMDB fallback | `MetaDetailsRepository.tryFetchMeta` |
| Meta takes > 5 s | `withTimeoutOrNull` → `null` → next candidate | `FETCH_TIMEOUT_MS` |
| Meta returns `{meta:{}}` | handled as "no results", not a crash | `extractMetaObject` |

> **Consequence.** A single malformed item in `metas[]` does **not** break the page
> (items are skipped individually), but a malformed **meta** document silently
> drops the whole details page. Always emit `id`, `type`, `name`.

---

## 13. Nuvio Wiki / docs cross-check

`https://nuvio.wiki/addons/` was **not reachable** from the research environment.

However, `NuvioMobile` ships its **own vendored copy of the Stremio add-on docs**
at `Docs/Stremio addons refer/` (protocol.md, api/responses/meta.md,
api/responses/manifest.md, api/responses/content.types.md, …). These are copies of
the official `stremio-addon-sdk` docs, not Nuvio-specific behaviour, and they
**agree with the source analysis above**.

> **UNVERIFIED:** the content of `nuvio.wiki/addons/` itself. Because the client
> source is fully readable and authoritative, this gap does not block the project.
> Recorded here for transparency.

---

## 14. Nuvio Compatibility Checklist

For Phase 1 acceptance:

- [ ] `GET /manifest.json` returns valid JSON with `id`, `name`, `version`, `logo`
- [ ] `logo` is a resolvable URL (absolute or root-relative)
- [ ] `resources` = `[{name:"meta", types:["anime"], idPrefixes:["anilist:"]}, "catalog"]`
- [ ] Every catalog `extra` entry is non-required → all catalogs appear on Home
- [ ] Catalogs declare `{"name":"skip"}` → infinite scroll works
- [ ] Exactly one catalog declares `{"name":"search"}` → search returns results
- [ ] At least one catalog declares `{"name":"genre","options":[…]}` → genre browse works
- [ ] Catalog items always include `id` (as `anilist:<n>`), `type`, `name`, `poster`
- [ ] `banner` emitted (Nuvio's preferred wide-art field)
- [ ] Catalog pages return **exactly 100 items** per page
- [ ] Empty last page returns `metas: []` to terminate pagination
- [ ] `/meta/anime/anilist%3A<n>.json` responds within **5 s**
- [ ] Meta body is `{meta:{…}}` and includes `id`, `type`, `name`
- [ ] Meta includes both `country` **and** `countryOfOrigin`; both `language` **and** `audioLanguage`
- [ ] `Cache-Control: max-age=…, public` on all catalog/meta responses
- [ ] Malformed/unknown ids produce a clean error, never a hang
- [ ] No `tt`-only, bare-number, or unprefixed ids anywhere in responses

---

## 15. Nuvio Facts That Are *Not* True (Corrections to Earlier Analysis)

Recorded so we do not regress into these mistakes:

| Claim | Verdict |
|---|---|
| "Nuvio needs `idPrefixes` to distinguish anime ID types" | **Half true.** `idPrefixes` is a *routing filter* on the `meta` resource. Without it you are a catch-all, not broken. |
| "Pagination is 100 items/page via `skip`, not `page`" | **True.** `CATALOG_PAGE_SIZE = 100`, `skip`-based. |
| "`types` must include `anime` or `series`" | **`anime` is fine.** Only the deep-link parser restricts to `movie`/`series`. |
| "Nuvio reads `imdb_id`, `releaseInfo`, `genres`, `imdbRating`" | **True**, plus it reads `country`/`language` (not the standard names). |
| "Nuvio expects `director[]` and `cast[]`" | **Optional** — it also derives them from `links[category=…]`. |
| "Nuvio reads `countryOfOrigin` / `audioLanguage`" | **False.** Grep-verified absent. It reads `country` / `language`. |
| "Manifest must include `logo` and `background`" | **False.** Only `id`, `name`, `version` are required. |
| "Jikan is a viable fallback" | **Unverifiable.** `api.jikan.moe` was unreachable (TCP timeout, IPv4 + IPv6) from the research environment on repeated attempts, while its docs host resolved. Cannot be confirmed healthy. |