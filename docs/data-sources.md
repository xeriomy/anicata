# Data Sources Reference

> **Verification basis.** Claims marked ✅ were confirmed by live HTTP probes
> (curl, GraphQL introspection, JSON:API queries) executed during the research
> phase on 2026-10-04. Claims marked 📄 come from official documentation. Claims
> marked **UNVERIFIED** could not be confirmed and must not be relied on.

---

## 0. Comparison summary

| | **AniList** | **Jikan** | **Kitsu** | **TMDB** | **AniZip** |
|---|---|---|---|---|---|
| Role | **Primary** | Fallback #1 | Fallback #2 | Enrichment | Episode enrichment |
| API style | GraphQL | REST | JSON:API | REST | REST |
| Auth | none | none | none | **API key required** | none |
| Rate limit (live) | ✅ **30/min** (degraded from 90) | 📄 3/s + 60/min | no limit headers observed | 📄 ~50/s | none observed |
| Reachable from research env | ✅ | ❌ **timeout** | ✅ | ✅ (401 as expected) | ✅ |
| Anime coverage | best | good (MAL-backed) | good | partial | AniDB-backed |
| Cross IDs exposed | `id`, `idMal` **only** | `mal_id` | `mappings[]` | `imdb_id`, `tvdb_id` | **all of them** |
| Episode titles | ❌ | ✅ (English only) | ✅ | ✅ | ✅ localized |
| Maintenance signal | live API | docs only | `updatedAt` current | live | live, Cloudflare-cached |

**Roles after research:**

- **AniList** — primary. Best search, tags, relations, airing schedules, trending.
- **Kitsu** — **promoted to fallback #1.** Its `/mappings` endpoint is a
  first-class, keyless, MAL↔Kitsu↔AniList bridge, and it is verifiably reachable.
- **Jikan** — **demoted to fallback #2, optional.** Documented limits are strict
  (3 req/s) *and* the API host was unreachable from the research environment.
  It must never be able to block or delay a response.
- **TMDB** — optional enrichment only. Keyless operation must never depend on it.
- **AniZip** — optional episode + cross-ID enrichment. High value, no key.

---

## 1. AniList — PRIMARY

### 1.1 Basics

| Property | Value | Status |
|---|---|---|
| Endpoint | `POST https://graphql.anilist.co` | ✅ |
| Docs | `https://anilist.gitbook.io/anilist-apiv2-docs/` | ✅ |
| Auth | none for public data | 📄 |
| `User-Agent` | recommended, not enforced | 📄 |
| CORS | `access-control-allow-origin: *` | ✅ |

### 1.2 Rate limiting — **the single most important constraint**

✅ **Live-probed response headers:**

```
HTTP/2 200
x-ratelimit-limit: 30
x-ratelimit-remaining: 29
cache-control: no-cache, private
access-control-expose-headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, …
```

✅ **Official docs** (`…/docs/guide/rate-limiting.md`) state **both**:

> ⚠ **The API is currently in a degraded state and is limited to 30 requests per
> minute. This is a temporary measure until the API is fully restored.**
>
> The AniList API has a rate limit of 90 requests per minute.

So: **nominal 90/min, currently degraded to 30/min.** Both numbers observed/documented;
the live header agrees with the degraded figure.

Additional documented behaviour:
- On exceeding: HTTP **429** with `Retry-After` (seconds) and `X-RateLimit-Reset`
  (unix timestamp), plus a GraphQL error body:
  `{"data":null,"errors":[{"message":"Too Many Requests.","status":429}]}`
- There is an additional undocumented **burst limiter**.
- 📄 **Rate-limit raises are available** by e-mail to `contact@anilist.co` with
  AniList username, requested limit, app description, links, and justification.
  > **Action item:** request a raise before public launch. At 30/min this add-on
  > is viable only with aggressive caching; at 300/min it is comfortable.

### 1.3 Schema — verified by introspection ✅

`Media` has **55 fields**. Full list:

```
id, idMal, title, type, format, status, description, startDate, endDate, season,
seasonYear, seasonInt, episodes, duration, chapters, volumes, countryOfOrigin,
isLicensed, source, hashtag, trailer, updatedAt, coverImage, bannerImage, genres,
synonyms, averageScore, meanScore, popularity, isLocked, trending, favourites,
tags, relations, characters, staff, studios, isFavourite, isFavouriteBlocked,
isAdult, nextAiringEpisode, airingSchedule, trends, externalLinks,
streamingEpisodes, rankings, mediaListEntry, reviews, recommendations, stats,
siteUrl, autoCreateForumThread, isRecommendationBlocked, isReviewBlocked, modNotes
```

**Enums** ✅ (introspected):

| Enum | Values |
|---|---|
| `MediaType` | `ANIME`, `MANGA` |
| `MediaStatus` | `FINISHED`, `RELEASING`, `NOT_YET_RELEASED`, `CANCELLED`, `HIATUS` |
| `MediaFormat` | `TV`, `TV_SHORT`, `MOVIE`, `SPECIAL`, `OVA`, `ONA`, `MUSIC`, `MANGA`, `NOVEL`, `ONE_SHOT` |
| `MediaSort` | `ID`, `ID_DESC`, `TITLE_ROMAJI`, `TITLE_ROMAJI_DESC`, `TITLE_ENGLISH`, `TITLE_ENGLISH_DESC`, `TITLE_NATIVE`, `TITLE_NATIVE_DESC`, `TYPE`, `TYPE_DESC`, `FORMAT`, `FORMAT_DESC`, `START_DATE`, `START_DATE_DESC`, `END_DATE`, `END_DATE_DESC`, `SCORE`, `SCORE_DESC`, `POPULARITY`, `POPULARITY_DESC`, `TRENDING`, `TRENDING_DESC`, `EPISODES`, `EPISODES_DESC`, `DURATION`, `DURATION_DESC`, `STATUS`, `STATUS_DESC`, `CHAPTERS`, `CHAPTERS_DESC`, `VOLUMES`, `VOLUMES_DESC`, `UPDATED_AT`, `UPDATED_AT_DESC`, `SEARCH_MATCH`, `FAVOURITES`, `FAVOURITES_DESC` |

> ⚠ **Corrections to common knowledge:**
> - `MediaStatus` has **`CANCELLED`**, **not** `DELAYED`.
> - There is **no `RELEASING`-adjacent `DELAYED` status**; use `HIATUS`/`CANCELLED`.
> - `MediaSort` has **`SEARCH_MATCH`** — useful for search results.

`Page.media` arguments ✅ (introspected, full list):

```
id, idMal, startDate, endDate, season, seasonYear, type, format, status,
episodes, duration, chapters, volumes, isAdult, genre, tag, minimumTagRank,
tagCategory, onList, licensedBy, licensedById, averageScore, popularity, source,
countryOfOrigin, isLicensed, search, id_not, id_in, id_not_in, idMal_not,
idMal_in, idMal_not_in, startDate_greater, startDate_lesser, startDate_like,
endDate_greater, endDate_lesser, endDate_like, format_in, format_not,
format_not_in, status_in, status_not, status_not_in, episodes_greater,
episodes_lesser, duration_greater, duration_lesser, chapters_greater,
chapters_lesser, volumes_greater, volumes_lesser, genre_in, genre_not, tag_in,
tag_not, tagCategory_in, tagCategory_not, licensedBy_in, licensedById_in,
averageScore_not, averageScore_greater, averageScore_lesser, popularity_not,
popularity_greater, popularity_lesser, source_in, countryOfOrigin_in,
countryOfOrigin_not, sort
```

> ✅ **Only ONE search argument exists: `search`.** There is **no**
> `search_as_broad` and **no** `searchByAlias`. (Both are widely cited in blog
> posts; they are **not in the current schema**.)
>
> ✅ **Batch args that exist: `id_in`, `idMal_in`.** Use these to fetch many items
> in one request — critical at 30 req/min.

`Page` also exposes `airingSchedules` (args include `mediaId`, `episode`,
`airingAt_greater`, `episode_greater`, `sort`) ✅ — useful for airing calendars.

### 1.4 Cross-source IDs — **definitive answer** ✅

| ID | Available from AniList alone? | Evidence |
|---|---|---|
| AniList | ✅ `Media.id` | introspection |
| MAL | ✅ `Media.idMal` | live: One Piece(21) → `idMal: 21` |
| **Kitsu** | ❌ **no `idKitsu` field** | introspection, 55 fields |
| **TMDB** | ❌ | no field, no `externalIds` |
| **IMDb** | ❌ | no field, no `externalIds` |
| **AniDB** | ❌ | no field |

> ⚠ **`Media.externalIds` DOES NOT EXIST.** Introspection returned 55 fields with
> no `externalIds`. Reports claiming AniList added an `externalIds` field are
> **wrong for the current schema**. A query requesting it returns HTTP 400.

⚠ **`Media.externalLinks.site` is a plain `String`, not an enum.** Introspected
type is `List<MediaExternalLink>`; there is no `MediaExternalLinkSite` enum type in
the schema. Live sample `site` values: `"Crunchyroll"`, `"Netflix"`, `"Hulu"`,
`"Official Site"`, `"Twitter"`, `"Instagram"`, `"TikTok"`, `"YouTube"`,
`"Amazon Prime Video"`, `"Adult Swim"`, `"Bilibili TV"`, `"Hoopla"`, `"iQ"`,
`"WeTV"`, `"Tubi TV"`.

> ⚠ **`externalLinks` contain ZERO database IDs.** They are streaming / social /
> info URLs only. Verified on One Piece (13 links, all streaming/social/info) and
> Cowboy Bebop (7 links). **Do not attempt to mine Kitsu/TMDB/IMDb ids from
> `externalLinks`.**

**Consequence:** AniList gives us exactly two identifiers — `id` and `idMal`.
Everything else requires another source. See [`id-mapping.md`](./id-mapping.md).

### 1.5 Verified working queries

> ✅ **Every query below was executed against the live API on 2026-10-04 and
> returned `data` with no errors.** The traps in §1.5.1 were found by running them.

#### 1.5.1 Traps that will 400 if you get them wrong ✅

| Trap | Wrong | Right |
|---|---|---|
| `sort` is a **list** | `query($sort: MediaSort)` | `query($sort: [MediaSort])` |
| `MediaTag.category` is a **String** | `category { id }` | `category` |
| tag spoiler flag was **renamed** | `isSpoiler`, `isMediaRelevant` | `isMediaSpoiler` (or `isGeneralSpoiler`) |
| `studios` edges are `StudioEdge` | `isMainStudio` | `isMain` |
| `relations` edges are `MediaEdge` | — | `relationType`, `node` (no `isMain` here) |
| `AiringScheduleConnection` field name | `airingSchedules` | `nodes` (and `edges`, `pageInfo`) |
| `airingSchedule` has no `sort` arg | `airingSchedule(sort: …)` | `airingSchedule(perPage: 1)` → `nodes` |

✅ `MediaRelation` enum values: `ADAPTATION`, `PREQUEL`, `SEQUEL`, `PARENT`,
`SIDE_STORY`, `CHARACTER`, `SUMMARY`, `ALTERNATIVE`, `SPIN_OFF`, `OTHER`,
`SOURCE`, `COMPILATION`, `CONTAINS`, `SAME_UNIVERSE`.

✅ `MediaTag` fields: `id: Int!`, `name: String!`, `description`, `category: String`,
`rank: Int`, `isGeneralSpoiler`, `isMediaSpoiler`, `isAdult`, `userId`.

✅ `AiringSchedule` fields: `id`, `airingAt: Int!`, `timeUntilAiring: Int!`,
`episode: Int!`, `mediaId: Int!`, `media`.

#### 1.5.2 `perPage` is clamped to 50 ✅

```
perPage=50  →  pageInfo.perPage: 50
perPage=100 →  pageInfo.perPage: 50   ← silently clamped, no error
```

> **Consequence:** one Nuvio catalogue page (100 items) costs **2 AniList
> requests**. This resolves an open question and is a permanent 2× floor on our
> request budget. Always read `pageInfo.perPage` rather than assuming.

#### 1.5.3 Catalogue page (✅ verified)

```graphql
query ($perPage: Int, $page: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(sort: $sort, type: ANIME, isAdult: false) {
      id idMal
      title { romaji english native }
      format status episodes duration averageScore popularity
      coverImage { extraLarge large medium color }
      bannerImage
      genres season seasonYear
      startDate { year month day }
      isAdult
      nextAiringEpisode { episode airingAt timeUntilAiring }
    }
  }
}
```

Variables: `{"perPage":50,"page":1,"sort":["TRENDING_DESC"]}`

Live response (`pageInfo`): `{"total":5000,"currentPage":1,"lastPage":2500,"hasNextPage":true,"perPage":2}`

⚠ **`duration` is an `Int` (minutes)** — not a `"24 min per ep"` string.
⚠ **`averageScore` is an `Int` 0–100** — divide by 10 for a 0–10 display.
⚠ **`nextAiringEpisode` is `null`** for finished titles.
⚠ `Page.media` returns `total: 5000`, a **capped** total, not the real count.

#### 1.5.4 Full metadata by ID (✅ verified, 29 fields)

```graphql
query ($id: Int) {
  Media(id: $id) {
    id idMal
    title { romaji english native }
    synonyms
    description(asHtml: false)
    format status episodes duration averageScore meanScore popularity favourites
    isAdult source countryOfOrigin hashtag
    startDate { year month day }
    endDate { year month day }
    season seasonYear
    coverImage { extraLarge large medium color }
    bannerImage
    genres
    tags { id name rank category isMediaSpoiler isAdult }
    studios { edges { isMain node { id name } } }
    relations { edges { relationType node { id type title { romaji english } format status } } }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    siteUrl
  }
}
```

Live values for One Piece (`id: 21`) confirming shapes:

```
description  : "Gold Roger was known as the Pirate King…"   (plain text, asHtml:false works)
synonyms     : ["ワンピース", "海賊王", "ואואנ פירס", …]
source       : "MANGA"
countryOfOrigin : "JP"
hashtag      : "#ONEPIECE"
siteUrl      : "https://anilist.co/anime/21"
favourites   : 109530
meanScore    : 87
duration     : 24
genres       : ["Action","Adventure","Comedy","Drama","Fantasy"]
tags[0]      : {"id":201,"name":"Pirates","rank":98,"category":"Cast-Traits","isMediaSpoiler":false,"isAdult":false}
studios.edges[0] : {"isMain":true,"node":{"id":18,"name":"Toei Animation"}}
relations.edges[0]: {"relationType":"SIDE_STORY","node":{"id":466,"type":"ANIME","title":{…},"format":…}}
nextAiringEpisode: {"episode":1181,"airingAt":1798985760,"timeUntilAiring":7859052}
```

#### 1.5.5 Search (✅ verified shape)

```graphql
query ($search: String, $perPage: Int, $page: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: $sort, isAdult: false) {
      id idMal title { romaji english native }
      coverImage { extraLarge large medium color }
      format status episodes averageScore genres
    }
  }
}
```

#### 1.5.6 Batch (✅ verified)

```graphql
query ($ids: [Int], $malIds: [Int]) {
  byIds: Media(id_in: $ids)     { id idMal title { romaji english } }
  byMal: Media(idMal_in: $malIds) { id idMal title { romaji english } }
}
```

### 1.6 Images ✅

- `coverImage`: `extraLarge`, `large`, `medium`, `color`
- ⚠ **Field names do not match real sizes.** ✅ Verified: for One Piece,
  `coverImage.large` is `…/cover/medium/bx21-….jpg` and `coverImage.medium` is
  `…/cover/small/bx21-….jpg`. **Use `extraLarge` for posters** and ignore the
  naming. `color` is a hex string (e.g. `"#fe5093"`), not a URL.
- `bannerImage`: single wide image URL
- CDN host observed in `externalLinks[].icon`: `s4.anilist.co/file/anilistcdn/…`
- Resize suffixes: 📄 documented as `?x-large` / `?x-medium` (not live-verified here)
- **UNVERIFIED:** explicit hotlinking / caching terms in AniList's ToS. Treat
  hotlinking as permitted (the official web player does it) but keep usage polite
  and cache aggressively on our side.

### 1.7 What AniList does **not** have

| Missing | Consequence |
|---|---|
| Episode titles | needs AniZip or Kitsu/Jikan |
| Cast / voice actors / staff roles | `characters`/`staff` exist but are large; use sparingly |
| Kitsu / TMDB / IMDb / AniDB ids | needs Kitsu `/mappings`, AniZip, or a bulk mapping file |
| Broadcast schedule in a specific timezone | `airingSchedule` is UTC-based |
| Logos / clear text | needs TMDB or AniZip TVDB artwork |
| MAL score (AniList has its own `averageScore`) | scores are not comparable across sites |

---

## 2. Jikan — FALLBACK #2 (optional)

### 2.1 Status: **⚠ API HOST UNREACHABLE — UNVERIFIED**

`docs.api.jikan.moe` resolved and served documentation, but repeated requests to
`https://api.jikan.moe/v4/...` **timed out at the TCP layer** on both IPv6 and IPv4
from the research environment, while AniList / Kitsu / AniZip / TMDB all succeeded
concurrently.

```
* Trying [2a01:4f9:c010:b863::1]:443...
* Trying 135.181.39.91:443...
* Connection timed out after 25002 milliseconds
```

> ✅ **RESOLVED 2026-10-07 — and the answer is worse than "down".**
> Re-probed: `api.jikan.moe` is TCP-silent on 80 and 443, over IPv4 *and* IPv6, and
> by direct IP (`135.181.39.91`) with DNS bypassed. Meanwhile `jikan.moe` and
> `docs.api.jikan.moe` both answer HTTP 200 — so the *website and docs are up* and
> only the API host is gone. That rules out a local network fault.
>
> The cause: **Jikan's public API was discontinued on 2026-10-01**, announced in
> June 2026 on their Discord, corroborated by multiple independent reports in
> `jikan-me/jikan-rest`. It is not coming back.
>
> **Jikan is removed from the fallback chain (ADR-004).** The Phase 0 note "design
> for it being absent" was the right call from an unresolved symptom, but the
> implied cause — transient outage — was wrong, and would have argued for retrying
> later rather than never building it.
>
> **Successor:** Tenrai (`https://api.tenrai.org/v1`), the announced continuation,
> is alive and Jikan-v4-shaped — verified HTTP 200 in ~460 ms with `{data:{…}}` and
> snake_case `mal_id`. Not adopted for Phase 2 (young, no uptime record, redundant
> with Kitsu) but recorded as the candidate if a third source is ever justified.

### 2.2 Documented characteristics 📄

From `docs.api.jikan.moe` / `github.com/jikan-me/jikan`:

- Base URL `https://api.jikan.moe/v4`
- **No auth** required.
- **Rate limit: 3 requests/second, 60 requests/minute.** Documented recommendation:
  sleep ≥ 1 s between requests.
- 429 responses carry `Retry-After`.
- Special, stricter limits on expensive endpoints (`/anime/{id}/full`,
  `/anime/{id}/episodes`, `/anime/{id}/characters`, `/anime/{id}/staff`).
- **It is an unauthorized third-party wrapper around MyAnimeList, not affiliated
  with MAL.** Its own docs carry this disclaimer. We must never describe it as
  "the official MAL API".

### 2.3 Endpoints we would use 📄 (not live-verified — host unreachable)

| Endpoint | Purpose |
|---|---|
| `/anime/{id}` | full detail |
| `/anime?q=&limit=&page=&order_by=&sort=` | search (`order_by`: `mal_id`,`title`,`start_date`,`score`,`member`,`popularity`) |
| `/top/anime?filter=` | top (`filter`: `airing`,`upcoming`,`bypopularity`,`favorite`) |
| `/seasons/now`, `/seasons/upcoming`, `/seasons/{year}/{season}` | seasonal |
| `/genres/anime` | genre list |
| `/anime/{id}/episodes` | episode list + titles |
| `/anime/{id}/relations`, `/anime/{id}/recommendations` | relations |
| `/anime/{id}/external` | external links |

### 2.4 Normalisation burden

MAL-derived responses need heavy normalisation: numeric `status`
(1=airing, 2=completed, 3=upcoming, 4=paused, 5=discontinued), `duration` as
`"24 min per ep"`, `aired.{from,to}` as ISO strings, `genres[]` as objects.

### 2.5 Known weaknesses 📄

- Coverage gaps and long ingestion backlog for older titles.
- Occasional 5xx and stale records.
- High latency relative to AniList/Kitsu.

---

## 3. Kitsu — FALLBACK #1 (promoted)

### 3.1 Basics ✅

| Property | Value |
|---|---|
| Endpoint | `https://kitsu.io/api/edge` |
| `Accept` header | **`application/vnd.api+json` — required** |
| Auth | none |
| Docs | `https://kitsu.docs.apiary.io/` (may lag; client is authoritative) |
| Protocol | JSON:API |

**Live response headers ✅** (note what is *absent*):

```
HTTP/2 200
content-type: application/vnd.api+json
cache-control: max-age=0, private, must-revalidate
etag: W/"5de585082995d69c444711d44f5da965"
x-request-id: d95cc1…
x-runtime: 0.072005
server: cloudflare
```

> ⚠ **No `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers were
> present.** Kitsu historically documented a ~90 req/hour budget and blocked
> requests without a `User-Agent`; **the current numeric limit is
> UNVERIFIED.** Always send a descriptive `User-Agent`. Our own client-side
> rate limiter must not rely on reading Kitsu's headers.

### 3.2 Freshness ✅

Cowboy Bebop (`anime/1`) returned `updatedAt: 2026-10-04T12:00:44Z` on a probe at
`2026-10-04T13:04Z`. **Kitsu is actively maintained.**

### 3.3 `/mappings` — the cross-database bridge ✅ **VERIFIED WORKING**

```
GET /mappings?filter[externalSite]=<site>&filter[externalId]=<id>&include=item
```

**Valid `externalSite` vocabulary ✅ (probed):**

| `externalSite` | mapping count ✅ |
|---|---|
| `myanimelist/anime` | **21,129** |
| `anilist/anime` | **19,061** |
| `myanimelist/manga` | 55,464 |
| `thetvdb/series` | 2,157 |
| `tvdb` | 0 |
| `anilist` | 0 |

> ⚠ **`include=anime` is invalid** (`400: "anime is not a valid relationship of
> mappings"`). The correct relationship is **`include=item`** ✅.

Live proof — MAL → Kitsu and AniList → Kitsu both resolve:

```
externalSite=myanimelist/anime externalId=21     → mapping 1175 → anime 12 "One Piece"
externalSite=myanimelist/anime externalId=1      → mapping 64108 → anime 1  "Cowboy Bebop"
externalSite=anilist/anime     externalId=21     → mapping 254544 → anime 12 "One Piece"
externalSite=myanimelist/anime externalId=31608  → mapping 1     → anime 11392 "Teekyuu 4 Specials"
```

> **Kitsu IDs are NOT equal to MAL IDs** (MAL 21 → Kitsu 12; MAL 31608 → Kitsu
> 11392). This endpoint is a genuine first-class mapping service, keyless and
> fast (~70 ms server-side runtime).
>
> ⚠ **No TMDB mappings exist in Kitsu.** Only MAL, AniList, AniDB, TVDB-family.

### 3.4 Anime response shape ✅ (live, `/anime/1`)

`data.attributes` (abridged, real values):

```json
{
  "slug": "cowboy-bebop",
  "titles": { "en": "Cowboy Bebop", "en_jp": "Cowboy Bebop", "ja_jp": "カウボーイビバップ" },
  "canonicalTitle": "Cowboy Bebop",
  "abbreviatedTitles": ["COWBOY BEBOP"],
  "synopsis": "In the year 2071, humanity has colonized…",
  "description": "…same text…",
  "averageRating": "82.27",
  "ratingFrequencies": { "10": 38218, … },
  "userCount": 162390,
  "favoritesCount": 5169,
  "startDate": "1998-04-03",
  "endDate": "1999-04-24",
  "popularityRank": 44,
  "ratingRank": 201,
  "ageRating": "R",
  "ageRatingGuide": "17+ (violence & profanity)",
  "subtype": "TV",
  "showType": "TV",
  "status": "finished",
  "nsfw": false,
  "episodeCount": 26,
  "episodeLength": 25,
  "totalLength": 626,
  "youtubeVideoId": "qig4KOK2R2g",
  "coverImageTopOffset": 400,
  "posterImage": {
    "tiny": "…/tiny.jpg", "small": "…/small.jpg", "medium": "…/medium.jpg",
    "large": "…/large.jpg", "original": "…/original.jpg",
    "meta": { "dimensions": { "large": { "width": 550, "height": 780 }, … } }
  },
  "coverImage": { "tiny"|"small"|"medium"|"large"|"original", "meta": {…} }
}
```

Image CDN: **`media.kitsu.app`** ✅. `posterImage` has explicit dimensions ✅ —
useful for choosing a poster size.

`data.relationships` includes ✅: `genres`, `categories`, `mappings`, `episodes`,
`castings`, `animeCharacters`, `animeStaff`, `animeProductions`, `productions`,
`installments`, `streamingLinks`, `mediaRelationships`, `reviews`, `quotes`,
`episodes`.

> ✅ **Correction to earlier analysis:** Kitsu **does** expose genres — as a
> *relationship*, i.e. via `include=genres`. Earlier notes claiming "Kitsu has no
> genres in JSON:API" were wrong.

### 3.5 Pagination ✅ — `page[limit]` caps at **20 (hard)**

`page[limit]` / `page[offset]`, with JSON:API `meta` and `links`
(`first`/`last`/`next`). Default limit observed: **10**
(`…&page[limit]=10&page[offset]=0` appears in returned links).

> ✅ **Maximum `page[limit]` is 20 — measured live 2026-10-08, not
> documentation-derived.** `limit=10 → 200`, `limit=20 → 200`,
> `limit=21 → 400`, `limit=50 → 400`, `limit=100 → 400`;
> search `limit=100 → 400` but search `limit=20 → 200`. A single fetch with
> no limit param (`/anime/1 → 200`) is unaffected. Requests above the cap
> must be stitched from multiple ≤20-item upstream calls (`KITSU_MAX_LIMIT`
> in `src/sources/kitsu/adapter.ts`) — never a single call with the full
> page size. This undocumented cap previously broke the whole fallback
> (the adapter requested 100, so `fetchPage` and `search` 400'd while only
> `fetchById` worked); record any future Kitsu limit here before relying
> on it.
>
> ✅ **Page size is latency-bound, not limit-bound.** A 20-item call costs
> **1.1–1.6 s** measured 2026-10-08, and concurrency does not help (1
> concurrent: 1.1–1.6 s; 2 concurrent: 2.5 s wall; 3 concurrent: 5.7 s
> wall; 5 concurrent: 7.1–8.4 s wall — slower than sequential). A full
> 100-item Nuvio page would cost ~5–7 s against a 4.5 s chain budget, so
> the adapter fills what the remaining budget allows and stops early
> rather than starting a call it cannot finish
> (`KITSU_PER_CALL_RESERVE_MS` in `src/sources/kitsu/adapter.ts`). Observed
> end to end: **40–60 items per fallback page** against 100 from AniList.
> Nuvio advances `skip` by `metas.length`, so short pages paginate
> correctly — they are permanent degradation, not an error.

### 3.6 Search ✅ (shape)

```
/anime?filter[text]=<q>&page[limit]=20&page[offset]=0&include=genres,episodes
```

Available filters include `filter[text]`, `filter[slug]`, `filter[ids]`,
`filter[season]`, `filter[seasonYear]`, `filter[status]`, `filter[rating]`,
`filter[categories]`, `filter[ageRating]`, `filter[sort]`.

### 3.7 Strengths / weaknesses for us

**Strengths** ✅
- `/mappings` gives us MAL↔Kitsu↔AniList for free, keyless, fast.
- Rich poster/cover images with known dimensions.
- Episode titles and counts.
- Ratings with `ratingFrequencies` (distribution, not just mean).
- Actively maintained.
- Reachable and fast.

**Weaknesses**
- ⚠ No rate-limit headers → we must self-limit defensively.
- Relations require multiple `include`s / follow-ups.
- Slightly less rich tagging than AniList.
- No TMDB/IMDb ids.

---

## 4. TMDB — OPTIONAL ENRICHMENT ONLY

### 4.1 Auth

📄 Both mechanisms are supported:

- **v3:** `?api_key=<KEY>` query parameter.
- **v4:** `Authorization: Bearer <v4 read access token>` (current recommended).

✅ Verified: `https://api.themoviedb.org/3/` returns **401** without credentials —
host is live and requires a key.

**Image CDN is fully public** (no auth): `https://image.tmdb.org/t/p/{size}{path}`
with sizes `w92`, `w154`, `w185`, `w342`, `w500`, `w780`, `original`. ✅

### 4.2 Anime coverage — **partial and curated** ✅ verdict

- TMDB is a general film/TV database, not an anime database.
- Anime entries require filtering by **genre 16 (Animation)** plus
  **`origin_country: JP`** and/or **`original_language: ja`**, often with
  anime-specific **keywords**.
- 📄 `/discover/tv` supports `with_genres`, `with_original_language`,
  `with_keywords`, `with_status`, `with_type`, `with_origin_country`.
- **Concrete counts UNVERIFIED** (needs a key).

> **Verdict:** TMDB must **never** be a hard dependency. Its unique value for anime
> is **`logos[]`** (clear-text title cards) and high-quality backdrops, neither of
> which AniList or Kitsu provides.

### 4.3 Endpoints we would use 📄

| Endpoint | Value for us |
|---|---|
| `GET /tv/{id}` | `poster_path`, `backdrop_path`, `overview`, `first_air_date`, `number_of_seasons`, `number_of_episodes`, `episode_run_time`, `genres`, `status`, `origin_country`, `original_language` |
| `GET /tv/{id}/images` | **`logos[]`** `{iso_639_1, file_path, vote_average, width, height}` — pick highest `vote_average`, tie-break on width |
| `GET /tv/{id}/external_ids` | `imdb_id` (often `null`), `tvdb_id`, `wikidata_id`, `facebook_id`, `instagram_id`. ⚠ **No `anilist_id`, no `mal_id`.** |
| `GET /search/tv?query=` | title-variant matching |

---

## 5. AniZip — EPISODE + CROSS-ID ENRICHMENT

> ⚠ **The host in the project brief is wrong.** `https://anizipapi.com/` and
> `https://api.anizipapi.com/` both failed (empty response). The **live service is
> `https://api.ani.zip`** ✅.

### 5.1 Verified endpoints ✅

**One endpoint**, five accepted parameters:

```
GET https://api.ani.zip/mappings?{anilist_id|mal_id|kitsu_id|imdb_id|themoviedb_id}=<id>
```

All five verified returning identical, consistent payloads for Cowboy Bebop
(28,832 bytes each):

| URL | Result ✅ |
|---|---|
| `/mappings?anilist_id=1` | 200, 28,832 b |
| `/mappings?mal_id=1` | 200, 28,832 b |
| `/mappings?kitsu_id=1` | 200, 28,832 b |
| `/mappings?imdb_id=tt0213338` | 200, 28,832 b |
| `/mappings?themoviedb_id=30991` | 200, 28,832 b |
| `/mappings?anilist_id=99999999` | **404**, 11 b |

⚠ `GET /episodes?anilist_id=1` → **404**. There is no separate episode endpoint;
episode data comes bundled in `/mappings`.

**No API key. No rate limiting observed.** Response headers ✅:

```
cache-control: public, max-age=900, s-maxage=900
cf-cache-status: HIT
access-control-allow-origin: *
```

> Response for One Piece was **1.87 MB** — AniZip payloads can be very large for
> long-running series. Cache aggressively; do not fetch per render.

### 5.2 Response shape ✅ (Cowboy Bebop)

```json
{
  "titles":       { "en": "Cowboy Bebop", "ru": "…", "x-jat": "CowBe", … },
  "episodes":     { "1": { … }, "2": { … }, …, "S1": { … } },
  "episodeCount": 26,
  "specialCount": 14,
  "images": [
    { "coverType": "Banner", "url": "https://artworks.thetvdb.com/banners/v4/series/76885/banners/688bfe4e8451b.jpg" },
    { "coverType": "Poster", "url": "https://artworks.thetvdb.com/banners/posters/76885-4.jpg" },
    { "coverType": "Fanart", "url": "https://artworks.thetvdb.com/banners/fanart/original/76885-20.jpg" }
  ],
  "mappings": {
    "animeplanet_id": "cowboy-bebop",
    "kitsu_id": 1,
    "mal_id": 1,
    "anilist_id": 1,
    "anisearch_id": 1572,
    "anidb_id": 23,
    "notifymoe_id": null,
    "livechart_id": 3418,
    "thetvdb_id": 76885,
    "imdb_id": "tt0213338",
    "themoviedb_id": "30991"
  }
}
```

**Episode object** ✅:

```json
{
  "tvdbShowId": 76885, "tvdbId": 219123,
  "seasonNumber": 1, "episodeNumber": 14, "absoluteEpisodeNumber": 4,
  "title": { "ja": "アステロイド・ブルース", "en": "Asteroid Blues", "de": …, "es": …, "hu": …, "x-jat": … },
  "airDate": "1998-11-13", "airDateUtc": "1998-11-13T08:00:00Z",
  "runtime": 25, "overview": "Faye teams up with Spike and Jet…",
  "image": "https://artworks.thetvdb.com/banners/episodes/76885/219123.jpg",
  "episode": "1", "anidbEid": 881, "length": 25, "airdate": "1998-10-24",
  "rating": "7.02", "summary": "Spike and Jet head to Tijuana…"
}
```

> ⚠ **Episode numbering is source-dependent and does NOT line up.** Cowboy Bebop's
> AniList episode `"1"` maps to `seasonNumber: 1, episodeNumber: 14, absoluteEpisodeNumber: 4`.
> AniList, MAL and TVDB number episodes differently for some titles.
> **We must expose AniList-relative numbering as canonical** (our ids are AniList
> ids) and never assume `episodeNumber` from AniZip equals our episode index.
>
> Episode keys include `"S1"`, `"S2"` … for specials ✅.

### 5.3 Image hotlinking ✅

```
GET https://artworks.thetvdb.com/banners/posters/76885-4.jpg
→ 200, content-type: image/jpeg, 380,540 bytes
```

**TVDB artwork hotlinks successfully without auth.** This is our source for
`logo`-style artwork and episode thumbnails.

### 5.4 Verdict

**Optional enrichment.** High value (localized episode titles + every cross-DB id
in one call), but:

- Community-run, single maintainer — availability risk.
- Very large payloads for long series.
- AniDB-derived, so coverage is excellent for Japanese-origin titles and poor for
  Western / Chinese / Korean animation.

**Never on the critical path.** Meta must render fully without it.

---

## 6. Bulk mapping dataset — `Fribb/anime-lists`

Not mentioned in the brief, but research turned up the single best cross-ID
dataset available. Verified live.

> ⚠ **`AniList/anime-lists` is GONE** — `raw.githubusercontent.com/AniList/anime-lists/master/anime-list-full.json`
> returns `404`, and `api.github.com/repos/AniList/anime-lists` returns 404.
> The reference add-on `demdex/nuvio-anime` builds its mapping from this dead URL.

**Live location** ✅: **`https://github.com/Fribb/anime-lists`** — "Anime-Mapping
Project", last pushed **2026-09-29**.

### 6.1 `anime-list-full.json` ✅ (downloaded and parsed: 7.49 MB, 39,577 records)

```json
{
  "type": "TV",
  "anidb_id": 1,
  "anilist_id": 290,
  "animecountdown_id": 36462,
  "animenewsnetwork_id": 14,
  "anime-planet_id": "crest-of-the-stars",
  "anisearch_id": 3039,
  "imdb_id": ["tt0286390"],
  "kitsu_id": 265,
  "livechart_id": 4157,
  "mal_id": 290,
  "season": { "tvdb": 1, "tmdb": 1 },
  "simkl_id": 36462,
  "themoviedb_id": { "tv": 26209 },
  "tvdb_id": 72025
}
```

Note `imdb_id` is an **array** and `themoviedb_id` is an **object** with `tv`/`movie`
distinction.

### 6.2 Trimmed-bundle feasibility ✅ (computed locally)

Keeping `[anilist_id, mal_id, kitsu_id, imdb_id, themoviedb_id, type, season, anidb_id, tvdb_id, simkl_id]`
and dropping null/empty values:

| Metric | Value |
|---|---|
| Records with anilist_id or mal_id | **32,363** |
| JSON (minified) | **2.85 MB** |
| **Gzip** | **459 KB** |
| | |
| `mal_id` coverage | 30,841 (95.3%) |
| `anilist_id` coverage | 20,840 (64.4%) |
| `kitsu_id` coverage | 20,761 (64.2%) |
| `anidb_id` coverage | 14,183 (43.8%) |
| `simkl_id` coverage | 14,138 (43.7%) |
| `themoviedb_id` coverage | 8,326 (25.7%) |
| `tvdb_id` coverage | 7,344 (22.7%) |
| `imdb_id` coverage | 8,024 (24.8%) |

> **A 459 KB gzipped mapping covering 32k titles with all cross-IDs is an
> extremely strong Phase-3 asset** — better than per-title API resolution for
> coverage, and free at request time.
>
> ⚠ Coverage caveats: `anilist_id` 64% means ~1/3 of entries lack an AniList id
> (mostly manga/older or less-linked titles). For anything we can't find there,
> fall back to **Kitsu `/mappings`** (live, keyless) and then **AniZip**.

### 6.3 `anime-lists-reduced.json` — not what we want

✅ Parsed: 10,767 records, 1.28 MB, fields `anidb_id`, `season`,
`themoviedb_id`, `tvdb_id`. It is an **AniDB→TMDB/TVDB** map (episode-level
numbering), **keyed only by `anidb_id`**. It does **not** provide
AniList↔Kitsu↔MAL mapping. Not useful for our identity layer.

---

## 7. Sources deliberately NOT used

| Source | Why not |
|---|---|
| **Simkl** | watch state — Nuvio owns it. Out of scope by brief. |
| **Trakt** | watch state — Nuvio owns it. Out of scope by brief. |
| **MDBList** | user lists — Nuvio owns it. Out of scope by brief. |
| **ARM API** (`arm.haglund.dev`) | third-party ID resolver used by AniSync; adds an untrusted dependency. We have Fribb + Kitsu + AniZip. |
| **Jikan's `/anime/{id}/full`** | expensive, strictest rate limit, host unverified. |

---

## 8. Evidence log

| Claim | Command / source |
|---|---|
| AniList 30/min | `curl -i -X POST https://graphql.anilist.co -d '{"query":"{Media(id:1){id}}"}'` → `x-ratelimit-limit: 30` |
| AniList no `externalIds` | `{__type(name:"Media"){fields{name}}}` → 55 fields, absent |
| AniList one search arg | `{__type(name:"Page"){fields{name args{name}}}}` |
| AniList `externalLinks` have no ids | live query on `Media(id:21)`, `Media(id:1)` |
| Kitsu no rate-limit headers | `curl -i https://kitsu.io/api/edge/anime/1` |
| Kitsu `include=item` correct | `400` on `include=anime`; `200` on `include=item` |
| Kitsu mapping counts | `?filter[externalSite]=…&page[limit]=1` → `meta.count` |
| MAL 21 → Kitsu 12 | `/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=21&include=item` |
| Kitsu fresh | `updatedAt: 2026-10-04T12:00:44Z` |
| Jikan unreachable | `curl -m 25` → `Connection timed out`, exit 28, IPv4 + IPv6 |
| AniZip host | `api.anizipapi.com` empty; `api.ani.zip` 200 |
| AniZip all 5 params | 5 URLs → all 200, 28,832 b |
| TVDB art hotlinks | `curl -o /dev/null -w %{http_code}` on `artworks.thetvdb.com` → 200 |
| `AniList/anime-lists` dead | `raw.githubusercontent.com` → `404: Not Found` |
| Fribb dataset | downloaded 7,494,695 b, parsed 39,577 records |
| Fribb trimmed size | local compute: 2.85 MB raw / 459 KB gzip |
| TMDB requires key | `curl https://api.themoviedb.org/3/` → 401 |