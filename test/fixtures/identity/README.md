# Identity Fixtures — Phase 3 Task 3

Real API captures from live endpoints, recorded 2026-10-08. Committed verbatim, JSON:API envelope included. Do not hand-edit: re-capture with the commands below instead.

## Capture conventions, per the existing `test/fixtures/README-kitsu.md`

- Every file is a byte-verbatim live response. Save the full envelope exactly as returned — do not trim, reformat, pretty-reorder keys, or hand-edit.
- No fabricated bodies, ever. If a capture cannot be made, leave it out, record why in the README, and state it in the report.
- The README maps each file → exact endpoint + params + capture date, and states which claims remain UNVERIFIED.

---

## `kitsu-forward-mal-21.json`

- **Endpoint:** `GET /mappings?filter[externalSite]=myanimelist%2Fanime&filter[externalId]=21&include=item`
- **Params:** `filter[externalSite]=myanimelist/anime`, `filter[externalId]=21`, `include=item`
- **Capture date:** 2026-10-08
- **Notes:** Forward direction: myanimelist/anime id=21 → mapping 1175 → anime 12 (One Piece). `include=item` embeds the full anime record in `included[]`. `data[0].relationships.item.data = {"type":"anime","id":"12"}`. `meta.count=1`.

## `kitsu-forward-anilist-21.json`

- **Endpoint:** `GET /mappings?filter[externalSite]=anilist%2Fanime&filter[externalId]=21&include=item`
- **Params:** `filter[externalSite]=anilist/anime`, `filter[externalId]=21`, `include=item`
- **Capture date:** 2026-10-08
- **Notes:** Forward direction: anilist/anime id=21 → mapping 254544 → anime 12 (One Piece). Same shape as myanimelist forward. `meta.count=1`.

## `kitsu-reverse-12.json`

- **Endpoint:** `GET /anime/12/mappings`
- **Params:** none (reverse lookup by Kitsu anime id 12)
- **Capture date:** 2026-10-08
- **Notes:** Reverse direction: Kitsu anime id=12 (One Piece) → 7 mapping rows. `meta.count=7`. Rows: `myanimelist/anime:21`, `thetvdb/series:81797`, `anidb:69`, `thetvdb:81797`, `aozora:UJAusIBpD8`, `trakt:37696`, `anilist/anime:21`. Note the duplicate TVDB coverage under two site spellings (`thetvdb/series` and `thetvdb`). No `item` linkages in reverse context (implicit). `aozora` row has opaque token id — semantics UNVERIFIED.

## `kitsu-manga-1.json`

- **Endpoint:** `GET /mappings?filter[externalSite]=myanimelist%2Fmanga&filter[externalId]=1&include=item`
- **Params:** `filter[externalSite]=myanimelist/manga`, `filter[externalId]=1`, `include=item`
- **Capture date:** 2026-10-08
- **Notes:** Trap: returns a manga row (`item.data.type = "manga"`), NOT an anime row. Always check `relationships.item.data.type == "anime"` when querying by externalId — manga rows will otherwise mix in. `meta.count=1`, `data.length=1`.

## `kitsu-unknown.json`

- **Endpoint:** `GET /mappings?filter[externalSite]=unknown%2Fsitename&filter[externalId]=99999999&include=item`
- **Params:** `filter[externalSite]=unknown/sitename`, `filter[externalId]=9. 5. 4. 3. 2. 1
   >         keys. 4. Commit. 5. Verify everything works: `npm test`, `npm run typecheck`, `npm run lint`. 6. Report status, commit SHA + subject, final file count + total bytes, which shortfalls you closed, spot-check result, concerns.
<tool_call>
<function=shell>
<parameter=command>
ls -la /tmp/ 2>/dev/null | head -5