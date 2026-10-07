# Kitsu fixtures

Real API captures from `https://kitsu.io/api/edge`, recorded 2026-10-07.
Committed verbatim, JSON:API envelope included. Do not hand-edit: re-capture
with the commands below instead.

All requests carry `Accept: application/vnd.api+json` (required; without it
Kitsu answers 406).

## `kitsu-page.json` — HTTP 200

Top-rated page, 3 records, genres sideloaded:

```bash
curl -s -H 'Accept: application/vnd.api+json' \
  'https://kitsu.io/api/edge/anime?sort=-averageRating&page%5Blimit%5D=3&include=genres' \
  -o test/fixtures/kitsu-page.json
```

Notes: `data[].attributes.averageRating` is a string (`"88.94"`), not a
number. These records carry an empty `relationships.genres.data` array, so
there is no `included` section — the genre join must yield `[]`, not
`undefined`. `meta.count` (22494 at capture) is the collection total.

## `kitsu-anime-1.json` — HTTP 200

Single anime (Cowboy Bebop, Kitsu id 1) with genres:

```bash
curl -s -H 'Accept: application/vnd.api+json' \
  'https://kitsu.io/api/edge/anime/1?include=genres' \
  -o test/fixtures/kitsu-anime-1.json
```

Notes: `attributes.averageRating === "82.27"` (string). Genre names
(`Action`, `Comedy`, …) live in `included` where `type === 'genres'` and are
joined via `relationships.genres.data[].id`; the record itself has no genre
names. `titles` holds `{ en, en_jp, ja_jp }` alongside `canonicalTitle`.
