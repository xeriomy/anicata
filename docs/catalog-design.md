# Catalog Design

> Driven by three hard constraints:
> 1. **AniList's 30 req/min budget** — every catalog page costs ≥ 1 request, so
>    catalog count × Nuvio's home-row refresh × user count is the real budget.
> 2. **The SDK's 8 KB manifest limit** — bounds how many catalogs we can declare
>    and how many genre options we can attach.
> 3. **Nuvio's `extra` gating** — the `extra` array silently decides whether a
>    catalog appears on Home, paginates, is searchable, or offers genre filtering.
>
> See [`nuvio-compatibility.md`](./nuvio-compatibility.md) §7 for the exact
> Nuvio gating logic this design depends on.

---

## 1. Content types

| Stremio `type` | Used for | Rationale |
|---|---|---|
| `anime` | everything episodic **and** films that live in the anime lineage (ONA, OVA, TV, specials) | Nuvio labels it "Anime" (`LocalizedUiText.kt`) and classifies it as `TrackingMediaKind.ANIME`, so watch-state sync works natively |
| `movie` | anime films (AniList `format = MOVIE`) | matches Stremio convention for single films |

> **Why not `series` for everything?** Nuvio would classify it as `SHOW`, and its
> Simkl anime tracking would not engage. `anime` is the correct type.
>
> ⚠ **Known Nuvio limitation:** `stremio://meta/anime/…` deep links are rejected
> by `normalizeDeepLinkMediaType` (it only accepts `movie`/`series`). In-app
> navigation from a catalog row is unaffected. Nothing we can do about it;
> recorded so it isn't mistaken for a bug in our addon.

---

## 2. The catalog list

### 2.1 Curated browse catalogs (Phase 1/5) — `type: anime`

| # | `id` | `name` | AniList query | `extra` |
|---|---|---|---|---|
| 1 | `anime-trending` | Trending | `sort: TRENDING_DESC` | `skip` |
| 2 | `anime-popular` | Popular | `sort: POPULARITY_DESC` | `skip` |
| 3 | `anime-top-rated` | Top Rated | `sort: SCORE_DESC` | `skip` |
| 4 | `anime-airing` | Currently Airing | `status: RELEASING`, `sort: POPULARITY_DESC` | `skip` |
| 5 | `anime-upcoming` | Upcoming | `status: NOT_YET_RELEASED`, `sort: POPULARITY_DESC` | `skip` |
| 6 | `anime-recent` | Recently Finished | `status: FINISHED`, `startDate_greater`, `sort: START_DATE_DESC` | `skip` |
| 7 | `anime-movies` | Movies | `format: MOVIE`, `sort: POPULARITY_DESC` | `skip`` |
| 8 | `anime-ova` | OVAs | `format_in: [OVA, ONA]`, `sort: POPULARITY_DESC` | `skip` |
| 9 | `anime-search` | Search | `search: $q`, `sort: SEARCH_MATCH` | `skip`, **`search`** |

Plus a season catalog, handled specially in §4.

### 2.2 `type: movie` catalogs

| `id` | `name` | AniList query | `extra` |
|---|---|---|---|
| `anime-movie-trending` | Trending Movies | `format: MOVIE`, `sort: TRENDING_DESC` | `skip` |
| `anime-movie-popular` | Popular Movies | `format: MOVIE`, `sort: POPULARITY_DESC` | `skip` |

> **Rationale.** Movies get their own `type: movie` rows because Nuvio's
> `TrackingMediaKind` maps `movie` → `MOVIE` and Simkl's anime list wants films
> registered as movies. Mixing them into `type: anime` would misclassify them.

### 2.3 Genre catalogs — see §3

### 2.4 Manifest size estimate ✅

| Component | Bytes (approx) |
|---|---|
| envelope + `resources` + `types` + `behaviorHints` | ~380 |
| 11 `anime` catalogs @ ~110 B | ~1,210 |
| 2 `movie` catalogs @ ~110 B | ~220 |
| genre extras (2 × 20 options) | ~400 |
| **total** | **~2.2 KB** |
| **budget** | **8,192 B** |
| **headroom** | **~6 KB** |

Comfortable. CI asserts the limit.

---

## 3. Genres

### 3.1 Option list

Must **exactly** match AniList `Genre` enum strings, because Nuvio validates
selection against the declared `options` and then sends the string verbatim:

```
Action, Adventure, Comedy, Drama, Ecchi, Fantasy, Horror, Mahou Shoujo,
Mecha, Music, Mystery, Psychological, Romance, Sci-Fi, Slice of Life,
Sports, Supernatural, Thriller
```

> 18 options, deliberately curated. The brief asked us not to create catalogs
> "just because an API allows it". These are the genres Nuvio users actually
> browse; `Ecchi` and `Psychological` are included because they are meaningful
> AniList distinctions that collapse into "other" elsewhere.
>
> ⚠ Adult content is excluded from the option list and filtered from all queries
> (`isAdult: false`, hard-coded, not configurable in v1).

### 3.2 Two genre-bearing catalogs, not N

Nuvio's Discover screen builds a genre filter from
`extra.firstOrNull { it.name == "genre" }?.options`. If *every* catalog carried
genres, Discover would list 13 near-identical sources and burn 13 requests per
browse. So:

| `id` | `name` | AniList query |
|---|---|---|
| `anime-genres` | Genres | `genre: $genre` (default: popularity) |
| `anime-top-genres` | Top Rated Genres | `genre: $genre`, `sort: SCORE_DESC` |

### 3.3 Genre request semantics ✅

Nuvio sends **no** `genre` extra when the user has not chosen one
(`genreOptions.isEmpty() → null`, else `null` when not required). Our handler:

- **no `genre`** → the catalog's default ordering (popularity / score)
- **`genre` present** → filter by it

Both cases return a full page, so Discover always has content.

---

## 4. Seasonal catalog

`Page.media(season:, seasonYear:)` needs a season + year, but Nuvio sends **no
extras we can trust** for it — there is no date-picker extra in Nuvio's UI.

**Decision: seasonal is computed server-side, not exposed as a browsable extra.**

```
currentSeason  = derived from Date.now()        // WINTER/SPRING/SUMMER/FALL
currentYear    = new Date().getUTCFullYear()
Page(media: { season: $season, seasonYear: $year, sort: POPULARITY_DESC })
```

We still ship an `anime-seasonal` catalog whose contents **roll over
automatically** as the calendar turns. `skip` pagination still works.

> Rationale: a "Season" catalog the user cannot choose is still useful (it is the
> current season, and it changes 4× a year), and it avoids inventing a `date`
> extra that no client will ever send.
>
> ⚠ **UNVERIFIED:** whether any Stremio client sends a `date` extra in a form worth
> supporting. Not implemented in v1.

---

## 5. Pagination

### 5.1 The contract

```
GET /catalog/anime/anime-trending.json/skip=100
→ { metas: [ … 100 items … ] }
```

- `skip` arrives as a **string** (`querystring.parse`).
- Handler requests upstream window `[skip, skip + 100)`.
- Return **exactly 100** items when available; fewer when exhausted.
- Return `metas: []` to end pagination.

### 5.2 Why exactly 100

Nuvio advances `skip` by **the number of items we returned** and treats a page
of ≥ 100 as evidence of pagination support even without a `skip` declaration.
Two consequences we must respect:

1. **Never repeat items for the same `skip`.** Nuvio tracks
   `consecutiveDuplicatePages` and stops after 3 (`DUPLICATE_CATALOG_PAGE_ADVANCE_LIMIT`).
   With AniList's default ranking being time-sensitive, `TRENDING_DESC` pages
   can shift under us. Mitigation: cache the page **by `skip`** (see
   [`architecture.md`](./architecture.md)) so the same `skip` always returns the
   same items for the cache TTL.
2. **Empty `metas` is the termination signal** — not an error, not a short page
   mid-stream.

### 5.3 AniList `perPage` — ✅ verified: clamped to 50

```
perPage=50  →  pageInfo.perPage: 50
perPage=100 →  pageInfo.perPage: 50   ← silently clamped, no error
```

> One Nuvio page of 100 items therefore costs **2 AniList requests**. This is a
> permanent 2× floor on our request budget and closes the "does `perPage: 100`
> work?" question — it does not.
>
> Read `pageInfo.perPage` from the response rather than assuming it.

---

## 6. Search

### 6.1 Declared on exactly one catalog

```json
{ "type": "anime", "id": "anime-search", "name": "Search",
  "extra": [ { "name": "skip" }, { "name": "search" } ] }
```

> **Why only one?** Nuvio fans a search query out to **every** catalog declaring
> `search` (`SearchRepository.buildSearchRequests`). At 30 req/min, 13 searchable
> catalogs = 13 requests per keystroke-driven search, from a single user.
> One search catalog = one AniList request per search.

### 6.2 Search query

```graphql
Page(page: $page, perPage: $n, media: { search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH })
```

`SEARCH_MATCH` ✅ exists in `MediaSort` (introspected) — it is AniList's relevance
ranking, which is what we want.

> ⚠ There is exactly **one** search argument in the current schema: `search`.
> No `search_as_broad`, no `searchByAlias`. Both are frequently cited online and
> are **not real**.

### 6.3 Behaviour

| Input | Behaviour |
|---|---|
| 1–2 chars | still queries; AniList returns few/no results. No artificial gate. |
| blank / whitespace | return `metas: []` with short `Cache-Control`; **no upstream call** |
| no results | `metas: []`; Nuvio shows "no results for catalog" |
| very long query | truncate to 200 chars before sending (cache-key hygiene) |

### 6.4 Stability guarantee

Every search result carries `id: "anilist:<n>"`. Because meta lookups key off
that id and never off the title, a user's subsequent `/meta` request is
independent of how they found the item. **Search never becomes a metadata
dependency.** This satisfies the brief's requirement.

---

## 7. Response shape we emit

### 7.1 Catalog item

```jsonc
{
  "id": "anilist:21",                  // required
  "type": "anime",                     // required
  "name": "ONE PIECE",                 // required
  "poster": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21-…jpg",
  "posterShape": "poster",
  "banner": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-….jpg",  // Nuvio-preferred
  "background": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-….jpg",
  "description": "…plain text, HTML stripped…",
  "releaseInfo": "1999-10-20",
  "released": "1999-10-20T00:00:00Z",
  "imdbRating": "8.7",                 // AniList averageScore/10, as a STRING
  "genres": ["Action", "Adventure", "Comedy"],
  "logo": null
}
```

> `banner` and `background` are the same AniList `bannerImage` today. Keeping both
> means Nuvio uses `banner` and Stremio uses `background`, with one upstream field.
>
> ⚠ `imdbRating` is a misnomer inherited from Stremio — it carries AniList's
> score. Nuvio reads it as a display string. Fine, but document it so nobody
> "fixes" it into an AniList-specific field later.

### 7.2 Title selection

```
english  →  romaji  →  native  →  "Untitled"
```

Rationale: English first for the widest audience; `romaji` covers titles with no
official English name; `native` is the last resort. `synonyms` are **not** used
for display — they exist for search matching only.

### 7.3 Non-negotiable fields

`id`, `type`, `name` are always present, even under total upstream failure
(with `name: "Unavailable"`). Nuvio drops any item missing them
**silently** (`nuvio-compatibility.md` §6.2).

---

## 8. Catalog design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| 13–15 catalogs | 40+ (one per genre × format) | request budget; Nuvio Home would be unusable |
| `search` on 1 catalog | `search` on all | Nuvio fans out per searchable catalog |
| `genre` on 2 catalogs | `genre` on all | Nuvio Discover duplicates rows; request budget |
| Server-derived season | `date` extra | no Nuvio UI sends it |
| Genres as one filtered catalog | 18 separate catalogs | 18 home rows is absurd |
| `type: anime` | all `series` | enables Nuvio's native anime tracking |
| `anilist:` IDs | `tt…`/`tmdb:` IDs | only ~25% IMDb coverage; Nuvio rewrites `tmdb:`→IMDb anyway |
| `isAdult: false` hard-coded | configurable | adult content is a policy decision, not a v1 feature |
| Curated 18 genres | all ~50 AniList genres | most are meaningless to end users |

---

## 9. Acceptance criteria per catalog

Every catalog must satisfy all of:

- [ ] Responds 200 with `{ metas: [...] }` on a cold cache
- [ ] `skip=0` returns exactly 100 items (or all available)
- [ ] `skip=100` returns items `[100,200)` — **no overlap with `skip=0`**
- [ ] `skip=<past end>` returns `metas: []`
- [ ] Every item has `id`, `type`, `name`
- [ ] Every item has a non-empty `poster`
- [ ] `Cache-Control` present, TTL appropriate to volatility
- [ ] No item has an unprefixed `id`
- [ ] No item's `id` differs between `skip=0` and `skip=100` (for the same title)
- [ ] `banner` present (or explicitly `null`, never the wrong image)
- [ ] Under AniList 429 → stale cache served, or graceful empty, never a 500
- [ ] Cold response < 5 s (Nuvio's meta budget; keep catalog under it too)