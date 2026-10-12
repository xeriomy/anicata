# Phase 5 — Catalogue expansion: design

Goal: the full curated catalogue — 15 catalogues, 18 genre filters, and the two
`type: movie` views — all still answering 200, all paginating without overlap.

Authoritative for the *intent* is `docs/roadmap.md` §Phase 5. This document
records the design decisions that the roadmap does not make, plus the AniList
facts each catalogue's query depends on.

## 1. What already exists, and what Phase 5 adds

Phase 1 shipped three catalogues: `anime-trending`, `anime-top-rated`,
`anime-search`. They thin out to one each through
`CatalogService.getCatalogPage` → `SourceChain.fetchPage` → a per-source
`sortForCatalog(catalogId)` that returns an AniList `MediaSort` array.

Today the whole per-catalogue behaviour is that sort. Phase 5 needs more than a
sort: `anime-airing` is a sort *plus a status filter*, `anime-movies` is a sort
*plus a format filter*, `anime-seasonal` is a sort *plus a season+year pair*.

**Decision: replace "one sort per catalogue" with a catalogue → query
descriptor.** A `CatalogQuery` is `{ sort: MediaSortKey; status?: MediaStatus;
format?: MediaFormat; seasonYear?: ... }`. `sortForCatalog` becomes
`queryForCatalog`, returning the descriptor, and the adapter expands it into
AniList variables.

This is deliberately *not* a free-form variable map. A curated descriptor keeps
the adapter's variable expansion in one place, which is where the AniList
clamping traps live (see §3).

## 2. The 15 catalogues and what each actually needs

| id | type | name | query |
|---|---|---|---|
| `anime-trending` | anime | Trending Anime | `TRENDING_DESC` (existing) |
| `anime-top-rated` | anime | Top Rated Anime | `SCORE_DESC` (existing) |
| `anime-search` | anime | Search Anime | `SEARCH_MATCH`, `isRequired` search (existing) |
| `anime-popular` | anime | Popular Anime | `POPULARITY_DESC` |
| `anime-airing` | anime | Airing Now | `POPULARITY_DESC` + `status: RELEASING` |
| `anime-upcoming` | anime | Upcoming | `POPULARITY_DESC` + `status: NOT_YET_RELEASED` |
| `anime-recent` | anime | Recently Added | `START_DATE_DESC` + `status: RELEASING` |
| `anime-movies` | anime | Anime Movies | `POPULARITY_DESC` + `format: MOVIE` |
| `anime-ova` | anime | OVAs & ONAs | `POPULARITY_DESC` + `format_in: [OVA, ONA]` |
| `anime-seasonal` | anime | This Season | `POPULARITY_DESC` + `season` + `seasonYear` (current) |
| `anime-genres` | anime | Browse by Genre | `POPULARITY_DESC` + `genre` |
| `anime-top-genres` | anime | Top by Genre | `SCORE_DESC` + `genre` |
| `movie-trending` | movie | Trending Movies | `TRENDING_DESC` + `format: MOVIE` |
| `movie-top-rated` | movie | Top Rated Movies | `SCORE_DESC` + `format: MOVIE` |
| `movie-search` | movie | Search Movies | `SEARCH_MATCH` + `format: MOVIE`, `isRequired` search |

### Why two `type: movie` catalogues get their own ids rather than reusing `anime-movies`

Nuvio requests `/catalog/{type}/{id}` and routes on **both**. A catalogue
declared `type: movie` is only ever requested under `/catalog/movie/…`, so a
catalogue cannot be shared across the two types. Two movie-type catalogues are
therefore *required* by the protocol, not a duplication:
`movie-trending` and `movie-top-rated`. (`movie-search` exists so movie search
is routed at all.)

### Why `anime-ova` is one catalogue, not two

The roadmap names `anime-ova`. `OVA` and `ONA` are separate AniList formats but
the same user-facing bucket; `format_in: [OVA, ONA]` covers both in one
catalogue without doubling the request count.

## 3. AniList facts these queries depend on

Already recorded and re-verified in `docs/data-sources.md`:

- `perPage` is **silently clamped to 50**. A 100-item Nuvio page is two
  AniList requests — already handled by the existing two-page fetch.
- `Page.media.pageInfo.total` is **capped at 5000** and is not the true count
  (`catalog-design.md`). **Never derive page counts from it**; pagination is
  driven by `skip`, which the service already does.
- `SEARCH_MATCH` sort requires a `search` argument and behaves differently from
  the ordered sorts.

## 4. Genre filters

18 curated options, declared in the manifest `extra` rather than invented at
request time:

- `extra: [{ name: 'genre', options: [...18...] }]` on `anime-genres` and
  `anime-top-genres` (and the two movie rows), so Nuvio renders a picker instead
  of a free-text field.
- **AniList `genre` is an exact, case-insensitive match, not a substring.** A
  genre string Nuvio sends that AniList does not have returns an empty page —
  a 200, not an error. So the 18 options must be the exact spellings AniList
  accepts. Getting this wrong is silent-empty, not a crash.

**Decision: the 18 options are the exact AniList genre strings.** They are
captured from AniList's own `GenreCollection` where possible so the list is not
guessed. Any option added later must be verified against that collection, and a
test pins the list so a typo cannot ship.

**Ruling (2026-10-13, controller): the genre picker ships on exactly
`anime-genres` and `anime-top-genres`.** The "(and the two movie rows)"
parenthetical in the first bullet above is resolved against the roadmap's
§Scope ("Genre catalogs: `anime-genres`, `anime-top-genres`") and
`docs/catalog-design.md` §3.2, which deliberately keeps the picker to two
genre-bearing catalogues so Discover cannot burn one request per catalogue
browse. The size arithmetic points the same way: a genre extra on both movie
rows would add ~460 B to a manifest that is 2276 B of the 8192 B budget
(~5.9 kB headroom) — affordable, but never intended. The shipped manifest test
pins exactly two genre-bearing catalogues; the movie rows carry no genre
extra. This resolves the ambiguity rather than restating the spec: the
parenthetical is superseded.

## 5. The seasonal catalogue and the season boundary

`anime-seasonal` needs the *current* season. AniList accepts `season` +
`seasonYear`, and the current pair is computed from the wall clock.

**Decision: compute the season pair at request time, never cache it inside a
catalogue key.** A season catalogue keyed on a stale pair silently serves the
previous season for a quarter of the year. The cache key already carries the
catalogue id, so the pair must be part of the *query* the key is built from —
which means it belongs in `catalogCacheKey`, and the existing key shape
(`catalog:<source>:<id>:<genre>:<skip>`) does not carry it.

The cleanest fix is to make the seasonal catalogue id itself carry the pair
(`anime-seasonal-2026-fall`), so the existing key, rendezvous and manifest shapes
stay unchanged. The manifest then lists only the current one — a client that
installs in October sees `anime-seasonal-2026-fall` and keeps working until the
boundary, then receives the next pair on its next manifest fetch.

**Rollover is therefore not automatic.** It happens on the next manifest fetch
after the boundary, which for a long-lived install is at most one day. That is
an honest, documented limit — the alternative (a stable id with a
clock-dependent query) breaks caching instead.

## 6. Non-goals

- No change to pagination, caching, or the fallback chain. Phase 5 adds query
  shapes only.
- No new source. Kitsu fallback for the new catalogues is a separate,
  explicitly-tracked gap: a Kitsu-only user loses the new catalogues until
  their Kitsu equivalents exist. This is acceptable because the fallback is
  about *resilience of the same catalogue*, not parity of every catalogue.
