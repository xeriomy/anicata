# AniList catalog fixtures

Real captures from `POST https://graphql.anilist.co`, committed verbatim
with the GraphQL envelope (`{"data":{"Page":{…}}}`) included. Do not
hand-edit: re-capture with the commands below instead.

**Trim rule:** 10 media max, envelope verbatim — `pageInfo` is kept
exactly as returned (including `perPage: 50`), `media` is sliced to its
first 10 items. Serialization is single-line JSON with `", "` / `": "`
separators and `\uXXXX`-escaped non-ASCII (Python `json.dumps` style),
no trailing newline.

## `catalog-airing.json` — HTTP 200, captured 2026-10-11

The Phase 5 `anime-airing` catalogue: `POPULARITY_DESC` +
`status: RELEASING`. Live verification of the Task-2 `CATALOG_QUERY`
string: HTTP 200, no `errors[]`, and **all 50 returned items carried
`status: "RELEASING"`** (0 exceptions). `pageInfo` at capture:
`{"total":5000,"currentPage":1,"lastPage":100,"hasNextPage":true,"perPage":50}`.

Query (the Task-2 `CATALOG_QUERY`, byte-for-byte) and variables:

```bash
curl -s -X POST https://graphql.anilist.co \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: anicata-anime-addon/0.1' \
  -d '{"query":"query($perPage:Int,$page:Int,$sort:[MediaSort],$status:MediaStatus,$format:MediaFormat,$formatIn:[MediaFormat],$season:MediaSeason,$seasonYear:Int,$genre:String){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(sort:$sort,type:ANIME,isAdult:false,status:$status,format:$format,format_in:$formatIn,season:$season,seasonYear:$seasonYear,genre:$genre){id idMal title{romaji english native} format status episodes duration averageScore popularity coverImage{extraLarge large medium color} bannerImage genres season seasonYear startDate{year month day} isAdult nextAiringEpisode{episode airingAt timeUntilAiring}}}}","variables":{"perPage":50,"page":1,"sort":["POPULARITY_DESC"],"status":"RELEASING"}}'
```

Only the variables above are sent; the other declared variables are
absent, which AniList treats as `null` = no filter (verified, see
`docs/data-sources.md` §1.3).

## `catalog-trending.json` — HTTP 200, captured 2026-10-04

The `anime-trending` catalogue page 1: `{"perPage":50,"page":1,"sort":["TRENDING_DESC"]}`.

## `catalog-trending-p2.json` — HTTP 200, captured 2026-10-04

The `anime-trending` catalogue page 2: `{"perPage":50,"page":2,"sort":["TRENDING_DESC"]}`
(`currentPage: 2`) — used to test the two-page stitching loop.

## `catalog-search.json` — HTTP 200, captured 2026-10-04

A small real search result set (`pageInfo.total: 4`, all 4 items kept —
under the 10-item cap) via `SEARCH_QUERY`; the search field selection is
the narrower one (`id idMal title{…} coverImage{…} format status
episodes averageScore genres`).
