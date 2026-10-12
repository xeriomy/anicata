# Phase 5 Implementation Plan — Catalogue expansion (query behaviour)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Controller dispatches **sequentially — only one implementer at a time**; each task is independently reviewable and lands green before the next starts.

**Goal:** all 15 catalogues answer with their intended query — sorts, status/format/season filters, and genre — with the two `type: movie` rows and the generated seasonal id routed correctly, still 200 at every `skip`.

**Architecture:** the registry increment already landed (`src/sources/catalog-def.ts`, commit `dfc49a9`). This plan is the query-behaviour increment the design names as next: replace `sortForCatalog(catalogId)` with `queryForCatalog(catalogId) -> CatalogQuery` in the AniList adapter, where every catalogue's sort *and* its status/format/season filters live as one curated descriptor expanded into AniList variables. Then fix the three wiring gaps the increment exposes: the search path must carry the catalogue id (so `movie-search` filters `format: MOVIE`), the service must resolve generated seasonal ids through `catalogDefFor` (today they fall through to an empty page), and the handler must route both search catalogues.

**Tech Stack:** TypeScript 5.x (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node 22, Vitest, ESLint 9 flat config. No new runtime dependencies — verify `git diff <base>..HEAD -- package.json` is empty on every task.

**Spec:** `docs/superpowers/specs/2026-10-11-phase-5-catalogue-expansion-design.md` (binding authority — every task cites its spec section; no invented scope). Authoritative intent: `docs/roadmap.md` §Phase 5.

## Global Constraints

- No `any` in `src/`. No new runtime dependency. `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true` are on: **omit** optional keys, never assign `undefined`.
- **Baseline to preserve on every task:** `npm test` = 483 passed + 6 skipped; `npm run typecheck` exit 0 (covers `test/`); `npm run lint` exit 0; `unshare -n -- npm test` green. Report exit codes, not just absent output.
  - The 8 identity-bundle failures seen before `data/identity.min.json.gz` was built are environmental, not baseline: the artefact is gitignored and produced by `npm run identity:build`. If it is missing, rebuild it first (`IDENTITY_PIN=<a real Fribb commit> node scripts/build-identity.mjs`); the suite is green with it present.
- **AniList query strings are live-verified, copied verbatim, never reformatted** (`queries.ts` header rule). Every string this plan adds was executed against `https://graphql.anilist.co` and returned `data` with no errors — Task 1 records the evidence.
- Tests are offline by default. Network calls go in `test/live/` behind `ANICATA_LIVE=1`. AniList's degraded live limit is **30 req/min**: pace probes ~2.2 s apart; the whole live suite stays under ~10 requests.
- Lint boundaries (unchanged): `src/sources/**` adapters never import each other; `src/services/**` never imports a concrete adapter (the port is `AnimeSource`); `src/addon/**` imports neither `sources/*/adapter*` nor `net/**`. `src/sources/catalog-def.ts` is registry data, not an adapter — services and the addon layer may import it (manifest.ts already does).
- Never return a non-200. An unknown catalogue id, an unknown genre, or an unparsable seasonal id yields an empty page with a short `cacheMaxAge`, never an exception.
- Non-goals everywhere (design §6): no change to pagination arithmetic, cache TTLs, or the fallback chain; **no Kitsu work** — Kitsu keeps answering the new ids with its Phase 1/2 sort mapping, which is the documented parity gap ("fallback is about resilience of the same catalogue, not parity of every catalogue"); no manifest `idPrefixes` change.

## Review Focus

Five input classes the spec implies that no single task's happy path exercises. Each has a test pinned to the task that owns the code.

1. **A GraphQL variable that is declared but not wired into `media(...)`.** AniList answers 400 `Variable "$x" is never used` (verified live, Task 1) — so a catalogue added later with a half-wired descriptor takes the whole row down. Expected: the exact query string on every request equals the `queries.ts` constant, pinning declaration and wiring together. → Task 2
2. **A genre string AniList does not know** (e.g. a hand-crafted `?genre=Mahou Shoujo` on a free-text client). Expected: forwarded verbatim, empty page 200, never a crash — the silent-empty is AniList's documented behaviour, not ours to second-guess. → Task 2
3. **A seasonal id that is not the current pair** (`anime-seasonal-2027-winter` requested from 2026, e.g. a client that installed earlier). Expected: resolves and serves that pair — the id carries the season, so no clock check may reject it. → Task 4
4. **A search term on `movie-search`.** Expected: routed to the search path with `format: MOVIE`; if it fell through to the page path it would send `SEARCH_MATCH` with no `search` arg and AniList 400s into a degraded empty page. → Task 3
5. **A genre extra on a catalogue that does not declare one** (off-manifest filter, e.g. `/catalog/anime/anime-trending?genre=Action`). Expected: ignored — the manifest is the contract, and a catalogue that never offered a picker cannot have its contents silently narrowed. → Task 4

---

### Task 1: Live-verify the Phase 5 query shapes; capture fixtures and record the traps

Spec §2, §3, §4, §5. No `src/` change — captures and documentation only. Must land before Tasks 2–3 so those tasks' query strings and tests build on verified facts.

**Files:**
- Create: `test/fixtures/catalog-airing.json` (real capture, trimmed to 10 media like the existing catalog fixtures)
- Create: `test/fixtures/README-catalog.md` (capture provenance)
- Modify: `docs/data-sources.md` §1.3 (record the verified shapes + the three traps below)
- Modify: `test/live/anilist.live.test.ts:6-9` (the request-budget comment)

**Interfaces:** none (data and docs only).

> **Controller ruling (pre-flight): the live filter smoke tests are NOT in this task.** They assert that `fetchPage` sends and receives each filter (`every(i => i.status === 'RELEASING')` etc.), and those filters do not exist until Task 2 lands the descriptor — run before Task 2 they would either fail or pass vacuously. The capture in Step 1 doubles as this task's live verification of the airing shape (it must return 200 with all-RELEASING items), and `test/live/phase5-filters.live.test.ts` is Task 2's final step instead.

**Facts already verified live on 2026-10-11 against `https://graphql.anilist.co`** (probe scripts in `/tmp/opencode/probe-anilist-*.mjs` during planning; record these in `docs/data-sources.md`):

| shape | result |
|---|---|
| `sort: ['POPULARITY_DESC']` | 200, 50 items |
| `POPULARITY_DESC` + `status: RELEASING` | 200 |
| `POPULARITY_DESC` + `status: NOT_YET_RELEASED` | 200 |
| `START_DATE_DESC` + `status: RELEASING` | 200 |
| `POPULARITY_DESC` + `format: MOVIE` | 200, every item `format: MOVIE` |
| `POPULARITY_DESC` + `format_in: ['OVA','ONA']` | 200, only `OVA`/`ONA` |
| `POPULARITY_DESC` + `season: FALL` + `seasonYear: 2026` | 200, every item `season: FALL/2026` |
| `POPULARITY_DESC` + `genre: 'Action'` | 200, every item carries `Action` |
| `TRENDING_DESC`/`SCORE_DESC` + `format: MOVIE` | 200 |
| `SEARCH_MATCH` + `search` + `format: MOVIE` | 200, every item `MOVIE` |

The three traps the probes caught, to be recorded verbatim in the doc:

1. **The GraphQL arg is `format_in`, not `formatIn`.** `formatIn: $formatIn` returned 400 `Unknown argument "formatIn" on field "media" of type "Page". Did you mean "format", "format_in", …`.
2. **A declared variable must be wired into `media(...)`, or AniList 400s** (`Variable "$genre" is never used`) — and, worse, an *undeclared* variable is silently ignored: the old `CATALOG_QUERY` never declared `$genre`, so sending `genre: 'Action'` returned the **unfiltered** page (probe: first page of `POPULARITY_DESC`, no item necessarily carrying `Action`). Genre filtering has therefore never worked end-to-end; Task 2's query string is the fix.
3. **An absent variable is `null` = no filter.** `$format` declared+wired but not passed returned all 40 search results across every format; all six contradictory filters at once returned `total: 0`, a 200, not an error. So one query string may declare every optional arg and the adapter passes only the descriptor's present fields.
4. Also confirmed: `pageInfo.total` is 5000 on every filtered query (design §3 — never derive page counts from it).

- [ ] **Step 1: Capture the airing fixture** — POST to `https://graphql.anilist.co` with the Task-2 `CATALOG_QUERY` string and `{"perPage":50,"page":1,"sort":["POPULARITY_DESC"],"status":"RELEASING"}`, then trim `data.Page.media` to its **first 10 items** (the existing `catalog-trending.json` convention — 10 media, `pageInfo` verbatim). Save as `test/fixtures/catalog-airing.json`. **This POST is a live verification, not just a capture**: it must return HTTP 200 with no `errors[]`, and every item in it must have `status: "RELEASING"` — a 400 here means the query string is wrong and the task stops until the string is re-verified live.
- [ ] **Step 2: Write `test/fixtures/README-catalog.md`** — per-file endpoint, variables, capture date (2026-10-11), and the trim rule ("10 media max, envelope verbatim; do not hand-edit — re-capture").
- [ ] **Step 3: Write the doc section** in `docs/data-sources.md` §1.3 — the verified-shape table and the three traps (numbered 1–3 in the facts block above), each with the observed AniList message where there is one.
- [ ] **Step 4: Update the budget comment** in `test/live/anilist.live.test.ts:6-9` — the live suite will be ~9 AniList requests total (~5 existing + 4 new in Task 2), still well under 30/min; keep the "do not add more tests here" rule and note the new file's name.
- [ ] **Step 5: Commit** — `git add test/fixtures/catalog-airing.json test/fixtures/README-catalog.md docs/data-sources.md test/live/anilist.live.test.ts; git commit -m "test(phase5): live-verified query shapes and the airing capture fixture"`

**Exit gate:** fixture is a byte-verbatim capture (trim rule applied) with all-RELEASING items; doc carries the verified-shape table and the three traps; live suite green. Evidence: test output + the doc section.
**Reviewer handoff:** diff of `docs/data-sources.md` + fixture provenance README; spot-check one fixture against a live re-fetch.
**Closes roadmap gate:** "Genre filter populated with 18 options and filters correctly" (upstream half — live only, opt-in).

---

### Task 2: `CatalogQuery` descriptor + `queryForCatalog` + the wired query strings

Spec §1 (the descriptor decision), §2 (the 15-row table), §3 (the AniList facts). This is the core of the phase.

**Files:**
- Modify: `src/sources/anilist/queries.ts` (replace `CATALOG_QUERY`, extend `SEARCH_QUERY`)
- Modify: `src/sources/anilist/adapter.ts` (descriptor + `queryForCatalog` + variable expansion)
- Modify: `src/sources/catalog-def.ts` (export the seasonal-id parser)
- Modify: `src/sources/types.ts` (`SortKey` gains `'popular'` and `'recent'`)
- Create: `test/live/phase5-filters.live.test.ts` (opt-in, 4 tests, 1 request each — this task's live verification)
- Test: `test/anilist-adapter.test.ts` (new describes + one rewrite)

**Interfaces:**
- Consumes: `SortKey` from `src/sources/types.ts`; `Season`/`currentSeason` from `catalog-def.ts`; `catalog-airing.json` fixture (Task 1).
- Produces:
  ```ts
  // src/sources/anilist/adapter.ts
  export type CatalogStatus = 'RELEASING' | 'NOT_YET_RELEASED';
  export type CatalogFormat = 'MOVIE' | 'OVA' | 'ONA';
  export type AniListSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  export interface CatalogQuery {
    sort: SortKey;
    status?: CatalogStatus;
    format?: CatalogFormat;
    formatIn?: readonly CatalogFormat[];
    /** Always sent as a pair; the seasonal catalogue id is their transport. */
    season?: AniListSeason;
    seasonYear?: number;
  }
  export function queryForCatalog(catalogId: string): CatalogQuery;
  // src/sources/catalog-def.ts
  export function parseSeasonalCatalogId(id: string): { season: Season; year: number } | undefined;
  ```
  `SortKey` grows two members: `'popular'` (→ `POPULARITY_DESC`) and `'recent'` (→ `START_DATE_DESC`), because `TRENDING_DESC` is a different AniList sort from `POPULARITY_DESC`.
- The descriptor table (design §2), verbatim:
  `anime-trending` → `{sort:'trending'}`; `anime-top-rated` → `{sort:'top_rated'}`; `anime-search` → `{sort:'search_match'}`; `anime-popular` → `{sort:'popular'}`; `anime-airing` → `{sort:'popular',status:'RELEASING'}`; `anime-upcoming` → `{sort:'popular',status:'NOT_YET_RELEASED'}`; `anime-recent` → `{sort:'recent',status:'RELEASING'}`; `anime-movies` → `{sort:'popular',format:'MOVIE'}`; `anime-ova` → `{sort:'popular',formatIn:['OVA','ONA']}`; `anime-genres` → `{sort:'popular'}`; `anime-top-genres` → `{sort:'top_rated'}`; `movie-trending` → `{sort:'trending',format:'MOVIE'}`; `movie-top-rated` → `{sort:'top_rated',format:'MOVIE'}`; `movie-search` → `{sort:'search_match',format:'MOVIE'}`; `anime-seasonal-<year>-<season>` → `{sort:'popular',season:<SEASON from id>,seasonYear:<year from id>}`. Any id that matches none of these (including an unparsable `anime-seasonal-*`) → `{sort:'trending'}`, the Phase 1 default; the service gate makes this unreachable in production, so it must stay dumb rather than consult a clock.
- New query strings, **verified live in Task 1** and copied verbatim into `queries.ts`:
  ```ts
  export const CATALOG_QUERY: string =
    'query($perPage:Int,$page:Int,$sort:[MediaSort],$status:MediaStatus,$format:MediaFormat,$formatIn:[MediaFormat],$season:MediaSeason,$seasonYear:Int,$genre:String){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(sort:$sort,type:ANIME,isAdult:false,status:$status,format:$format,format_in:$formatIn,season:$season,seasonYear:$seasonYear,genre:$genre){id idMal title{romaji english native} format status episodes duration averageScore popularity coverImage{extraLarge large medium color} bannerImage genres season seasonYear startDate{year month day} isAdult nextAiringEpisode{episode airingAt timeUntilAiring}}}}';

  export const SEARCH_QUERY: string =
    'query($search:String,$perPage:Int,$page:Int,$sort:[MediaSort],$format:MediaFormat){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(search:$search,type:ANIME,sort:$sort,isAdult:false,format:$format){id idMal title{romaji english native} coverImage{extraLarge large medium color} format status episodes averageScore genres}}}';
  ```
  Note `format_in` (Trap 1) and that **every** declared variable is wired into `media(...)` (Trap 2). Query-string verification note for the comment block: the declared-and-unused 400 was observed 2026-10-11.
- `fetchPage` builds variables from the descriptor plus `req.genre`; a field is **omitted** (not sent as null) unless the descriptor has it. `parseSeasonalCatalogId` moves `SEASONAL_ID_RE` out of `catalog-def.ts` as an exported function (the regex itself stays private there); the adapter uppercases the `Season` to the `AniListSeason` spelling.

**Non-goal:** no change to the two-page stitching loop, `toPageResult`, or `search`'s term handling (its `format` arrives in Task 3). No genre *validation* — AniList's exact-match silent-empty is the documented behaviour (spec §4).

- [ ] **Step 1: Write the failing tests** — in `test/anilist-adapter.test.ts`, a table-driven describe `queryForCatalog` asserting the descriptor for **all 15 ids** (assert the object, not the expanded variables), plus: `anime-seasonal-2026-fall` → `{sort:'popular',season:'FALL',seasonYear:2026}`; `anime-seasonal-2027-winter` → `{sort:'popular',season:'WINTER',seasonYear:2027}`; `'nope'` → `{sort:'trending'}`.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/anilist-adapter.test.ts`; expect FAIL (module has no such export).
- [ ] **Step 3: Implement** `queryForCatalog`, `CatalogQuery`, the two new `SortKey` cases in `sortForKey` (delete `sortForCatalog`), `parseSeasonalCatalogId`, and the new query strings verbatim above.
- [ ] **Step 4: Write the failing request-shape tests** — one describe `fetchPage variables`, table-driven over the same 15 ids: queue one fixture response, call `fetchPage({ catalogId, skip: 0, limit: 10 })`, parse `init.body`, assert `sent.variables` **deep-equals** the expected object (e.g. `anime-airing` → `{perPage:50,page:1,sort:['POPULARITY_DESC'],status:'RELEASING'}`; `anime-ova` → `{...,formatIn:['OVA','ONA']}`; `anime-genres` → `{perPage:50,page:1,sort:['POPULARITY_DESC']}`) and `sent.query === CATALOG_QUERY`. `anime-genres` with `genre:'Action'` adds `genre:'Action'`; without one, no `genre` key at all.
- [ ] **Step 5: Run to verify they fail, then they pass** — `npx vitest run test/anilist-adapter.test.ts`.
- [ ] **Step 6: Add the guard tests**: (a) parse the real `catalog-airing.json` fixture through `fetchPage({catalogId:'anime-airing',skip:0,limit:100})` → 10 items, every one `status === 'RELEASING'`, ids are numbers; (b) a filtered catalogue at `skip: 100` still issues **exactly two** upstream requests, pages 3 and 4 (`page = floor(100/50)+1 = 3` — the request-count budget and the offset rule are catalogue-independent). **Controller note: an earlier draft of this plan said "the second is page 2", which is arithmetically impossible at `ANILIST_PER_PAGE = 50`; the implementer pinned pages 3/4, which is the truth this step intends.**; (c) an unknown genre string (`'Not A Genre'`) is forwarded verbatim in `variables.genre` (Review Focus 2); (d) rewrite the old `forwards genre to the AniList query…` test — same assertion, now the wiring makes it real, and keep `expect(sent.query).toBe(CATALOG_QUERY)` in it (Review Focus 1).
- [ ] **Step 7: Write the live filter smoke tests** — `test/live/phase5-filters.live.test.ts`, same `ANICATA_LIVE === '1' ? describe : describe.skip` gate as `anilist.live.test.ts`, 4 tests, each **1 upstream request** (`perPage: 50`, `limit: 50`):
  - `anime-airing` (sort `POPULARITY_DESC`, `status: RELEASING`): `items.every(i => i.status === 'RELEASING')`
  - `anime-movies` (`format: MOVIE`): `items.every(i => i.format === 'MOVIE')`
  - `anime-genres` with `genre: 'Action'`: `items.every(i => i.genres.includes('Action'))`
  - the current `seasonalCatalogId()`: every item's `season`+`seasonYear` matches the id's pair
  These assert the filter **applies upstream** — the roadmap's "filters correctly" gate in its only honest form, and the reason this file lives in this task rather than Task 1 (the filters must exist before they can be verified).
- [ ] **Step 8: Verify the full baseline** — `npm test`, `npm run typecheck`, `npm run lint`; report exit codes. Then, with the human partner's OK on AniList's 30 req/min budget, `ANICATA_LIVE=1 npm run test:live` as the live evidence; if that budget is off-limits, record it in the report and Task 5 Step 3 owns the live run. (**Controller ruling: use `npm run test:live`, not `npx vitest run --dir test/live` — the repo's vitest config finds no files under `--dir`, so the `--dir` form in the Task 1 budget comment fails; the comment itself is a deferred minor for the final review.**)
- [ ] **Step 9: Commit** — `git add src/sources/anilist/ src/sources/catalog-def.ts src/sources/types.ts test/anilist-adapter.test.ts test/live/phase5-filters.live.test.ts; git commit -m "feat(phase5): catalogue -> query descriptor with status, format and season filters"`

**Exit gate:** the 15-row descriptor table is pinned in tests; every declared variable is wired (pinned by the whole-query assertion); genre is a real filter for the first time. Evidence: vitest + tsc + eslint output.
**Reviewer handoff:** descriptor table vs design §2, row by row; the two query strings vs the live-verified text in Task 1 (byte-identical).
**Closes roadmap gate:** every catalogue's *query* exists (the "appear on Home" half is Phase 7 Nuvio verification).

---

### Task 3: Thread the catalogue id through the search path so `movie-search` filters `format: MOVIE`

Spec §2 (`movie-search` row) + §1 (expansion stays in the adapter). Without this, a search term on `movie-search` falls into the page path, sends `SEARCH_MATCH` with no `search` arg, and AniList 400s the request into a degraded empty page — a silent dead row, not a 5xx.

**Files:**
- Modify: `src/sources/types.ts` (port: `search` gains a trailing `catalogId?`)
- Modify: `src/sources/chain.ts:71-80`
- Modify: `src/sources/anilist/adapter.ts:112-123` (search builds variables from `queryForCatalog(catalogId)`)
- Modify: `src/sources/kitsu/adapter.ts` (accept and ignore the new param — design §6 non-goal)
- Modify: `src/services/catalog.service.ts:135, 205-217` (search args + cache/rendezvous keys)
- Modify: `src/addon/catalog.ts:52-53` (route via the def, pass the id)
- Test: `test/anilist-adapter.test.ts`, `test/catalog-service.test.ts`, `test/catalog-cache-keys.test.ts`, `test/handlers.test.ts`, `test/chain.test.ts:39-56,351-360`

**Interfaces:**
- Consumes: `queryForCatalog` (Task 2), `catalogDefFor` (existing).
- Produces:
  ```ts
  // AnimeSource / SourceChain / CatalogService.search — trailing optional param
  search(term: string, skip: number, limit: number, timeoutMs?: number, catalogId?: string): Promise<SourcePage>;   // port + adapters
  search(term: string, skip: number, limit: number, catalogId?: string): Promise<CatalogPageResult>;                  // service
  // keys (catalog now travels with the term — otherwise an anime-search hit
  // and a movie-search hit for the same term would share one entry)
  searchCacheKey(sourceId, catalogId, term, skip) -> `search:${sourceId}:${catalogId ?? ''}:${term}:${skip}`
  searchRendezvous(catalogId, term, skip)     -> `search-req:${catalogId ?? ''}:${term}:${skip}`
  ```
  The sticky key stays `search:${term}` on purpose — the *source* that served may be shared across catalogues; only the cached *results* must not be. When `catalogId` is undefined the call must **omit** the trailing argument, not pass `undefined` (existing 4-arg assertions in `chain.test.ts`/`catalog-service.test.ts` stay green without edits).
- Adapter search: `const q = catalogId !== undefined ? queryForCatalog(catalogId) : { sort: 'search_match' as const }`, then `variables = { search: term, perPage, page, sort: sortForKey(q.sort) }` plus `format: q.format` when present (absent ⇒ null ⇒ no filter — Task 1 Trap 3). `SEARCH_QUERY` already declares and wires `$format`.
- Handler: `const def = catalogDefFor(args.id); if (search !== undefined && def?.supportsSearch === true) { … search({ term: search, skip, catalogId: args.id }) }`.

**Non-goal:** Kitsu search gains no format filter (Kitsu parity gap, design §6); the sticky key and TTLs are unchanged; no change to `fetchPage`.

- [ ] **Step 1: Write the failing tests** — (a) handler: `movie-search` + `search` term routes to `catalogService.search` with `{term, skip, catalogId:'movie-search'}` and renders its items; `anime-search` unchanged; a non-search catalogue with a stray term still goes to `getCatalogPage`. (b) service: `searchCacheKey('anilist','anime-search','bebop',0) !== searchCacheKey('anilist','movie-search','bebop',0)`, both stable, both distinct from the old exact shape `search:anilist::bebop:0` when no catalog is given; two `getCatalogPage`-free service searches for the two catalogues with the same term store **two** cache entries (2 chain calls on repeat with a cold cache). (c) adapter: `search('one piece', 0, 10)` with `catalogId:'movie-search'` sends `sent.query === SEARCH_QUERY` and `variables.format === 'MOVIE'`; with `catalogId:'anime-search'` no `format` key is present; with no `catalogId` (legacy call) variables are exactly `{search,perPage,page,sort}`.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/handlers.test.ts test/catalog-service.test.ts test/catalog-cache-keys.test.ts test/anilist-adapter.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the port/chain/adapter/service/handler changes above, omitting the trailing arg when `catalogId` is undefined at every call site.
- [ ] **Step 4: Update the existing pins** that the key-shape change necessarily touches: `catalog-cache-keys.test.ts:73-77` (add the catalog dimension), `catalog-service.test.ts:144` (sticky key unchanged — `'search:cowboy bebop'` still holds), `chain.test.ts:39-56` (extend the fake source to forward the 5th arg so a new test can assert it) and any chain test asserting `search` call arity.
- [ ] **Step 5: Run to verify they pass** — the four test files above, then the full baseline.
- [ ] **Step 6: Commit** — `git add src/sources/ src/services/catalog.service.ts src/addon/catalog.ts test/; git commit -m "feat(phase5): route movie search with a movie format filter"`

**Exit gate:** `movie-search` sends `SEARCH_MATCH` + `format: MOVIE`; anime and movie searches never share a cache entry; every legacy 4-arg call site unchanged. Evidence: vitest + tsc + eslint output.
**Reviewer handoff:** call-site list for the new param (grep `\.search(`) — every site either passes a real catalogId or omits the arg; no `undefined` positions.
**Closes roadmap gate:** the two `type: movie` rows work end-to-end (Nuvio half is Phase 7).

---

### Task 4: Resolve every catalogue id through `catalogDefFor`, and honour the manifest's genre contract

Spec §5 (the seasonal id is the cache-key transport) + §4 (the picker is declared per catalogue). Today `getCatalogPage` reads `CATALOG_DEFS` directly, so the generated seasonal id — the one catalogue whose id exists at request time — is rejected and the row serves an empty page forever.

**Files:**
- Modify: `src/services/catalog.service.ts:88-100` (lookup + genre gating)
- Test: `test/catalog-service.test.ts`

**Interfaces:**
- Consumes: `catalogDefFor` (existing, now used by all three layers as spec §5 intends).
- Produces: no new exports. Inside `getCatalogPage`, after the existing type check:
  ```ts
  // The manifest declares the genre picker per catalogue, so a genre on a
  // catalogue that never offered one is off-contract client behaviour: drop it
  // rather than silently narrowing a row that advertised no filter.
  const effectiveGenre = def.supportsGenre === true ? args.genre : undefined;
  ```
  `effectiveGenre` — never the raw `args.genre` — feeds the `PageRequest`, the sticky key, and both cache/rendezvous keys.

**Non-goal:** no change to the key *shapes* (`catalog:<source>:<id>:<genre>:<skip>` — spec §5); no clock check on the seasonal pair (Review Focus 3); no genre *validation* against `GENRE_OPTIONS` (spec §4: a miss is AniList's silent-empty 200).

- [ ] **Step 1: Write the failing tests** — (a) the current seasonal id (`seasonalCatalogId(new Date())`) resolves: one source call, forwarded with `catalogId: <that id>`, `type: 'anime'`; (b) a **non-current** pair (`anime-seasonal-2027-winter`, requested in 2026) also resolves — no clock rejection; (c) `anime-seasonal-2026-monsoon` and `anime-seasonal-2026` are rejected without a source call; (d) a genre on `anime-trending` is dropped: **one** source call, forwarded request has no `genre`, sticky key is `anime-trending:`; (e) a genre on `anime-genres` is forwarded (rewrite the old `keys the cache by genre…` test to use `anime-genres` — its intent, cache-key separation, is unchanged); (f) the type-mismatch and unknown-id rejections still hold.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/catalog-service.test.ts`; expect FAIL on (a)–(d).
- [ ] **Step 3: Implement** — replace the `CATALOG_DEFS` lookup with `catalogDefFor(args.catalogId)` (drop the now-unused `CATALOG_DEFS` import) and apply the genre gate.
- [ ] **Step 4: Run to verify they pass** — the file, then the full baseline with exit codes.
- [ ] **Step 5: Commit** — `git add src/services/catalog.service.ts test/catalog-service.test.ts; git commit -m "fix(phase5): resolve seasonal catalogue ids in the service, gate genre to the manifest"`

**Exit gate:** all 15 catalogue ids plus any valid seasonal pair are served; off-manifest genres cannot narrow a row. Evidence: vitest + tsc + eslint output.
**Reviewer handoff:** the `effectiveGenre` threading — every use of genre below line 100 is `effectiveGenre`, never `args.genre` (grep).
**Closes roadmap gate:** "Seasonal catalog rolls over correctly across a season boundary" (id half — the rollover *limit* is the documented manifest-fetch delay, design §5).

---

### Task 5: Pin the manifest genre picker; full Phase 5 verification

Spec §4 (18 options declared in `extra`) + the Phase 5 exit gate's offline-provable half.

**Files:**
- Test: `test/manifest.test.ts`
- Modify: `docs/roadmap.md` (record which exit-gate lines are now provable offline/live vs. deferred to Phase 7's Nuvio verification — do **not** tick gates that need a real Nuvio install)

**Interfaces:** consumes `GENRE_OPTIONS` and `buildManifest` as they stand.

- [ ] **Step 1: Write the failing test** — `test/manifest.test.ts`: exactly two catalogues carry a `genre` extra, `anime-genres` and `anime-top-genres`, and each extra's `options` deep-equals `GENRE_OPTIONS` (the 18 exact AniList spellings, `'Sci-Fi'`/`'Slice of Life'`/`'Mahou Shoujo'` included); every other catalogue has no `genre` extra; the seasonal catalogue has `skip` and nothing required.
- [ ] **Step 2: Run to verify it fails** — if it passes immediately, say so in the commit body rather than padding; otherwise implement the minimal manifest fix that makes it pass (expected: it passes, because the registry increment already wired `buildExtra` — the test is the pin).
- [ ] **Step 3: Run the full gate set** — `npm test`, `npm run typecheck`, `npm run lint`, `unshare -n -- npm test` (offline proof), and — with the human's OK on AniList's 30 req/min budget — `ANICATA_LIVE=1 npx vitest run --dir test/live`. Verify the manifest stayed ≤ 8192 B (it is asserted in `assertManifestFits`, and the suite proves it).
- [ ] **Step 4: Update `docs/roadmap.md` §Phase 5** — annotate each exit-gate line: provable-in-CI (manifest size, no-overlap pagination, genre pinning), provable live opt-in (filters), deferred to Phase 7 (Nuvio Home, request-budget measurement). One line each; no tick boxes for anything a real Nuvio install must confirm.
- [ ] **Step 5: Commit** — `git add test/manifest.test.ts docs/roadmap.md; git commit -m "test(phase5): pin the manifest genre picker; annotate the exit-gate status"`
- [ ] **Step 6: Whole-branch review handoff** — dispatch the code review over the whole Phase 5 increment (spec → review focus → the five tasks above), per the phase plan's closing step.

**Exit gate:** suite green in all four modes; live suite green; the picker is pinned; the roadmap says honestly what remains unproven. Evidence: command outputs with exit codes.
**Reviewer handoff:** `git diff dfc49a9..HEAD` against the design, with Review Focus items 1–5 walked one by one.

---

## Self-review notes (2026-10-11, against the design)

- **Spec coverage:** §1 → Task 2. §2 table → Task 2 (all 15 rows), Task 3 (`movie-search`). §3 → Task 1 (facts + traps), Task 2 (variable omission). §4 → Tasks 1–2 (live pin), 5 (manifest pin). §5 → Task 4 (id resolution) + the registry increment's `seasonalCatalogId`. §6 → non-goals in Global Constraints (no Kitsu, no pagination/cache changes) and Task 3's boundary.
- **Deliberate decisions the design leaves open:** (a) `SortKey` grows `popular`/`recent` because `POPULARITY_DESC ≠ TRENDING_DESC` (design §2's `POPULARITY_DESC` rows demand it); (b) genre is gated to catalogues that declare it (Review Focus 5); (c) `searchCacheKey`/`searchRendezvous` gain the catalogue id — the one key-shape change in the plan, forced by two searchable catalogues sharing a term namespace, and outside the design §5 freeze which governs the *catalogue* key; (d) the search sticky key deliberately does **not** gain the id.
- **Type consistency:** `CatalogQuery.season` is the uppercase AniList spelling; `parseSeasonalCatalogId` returns the lowercase `Season` from `catalog-def.ts`; the adapter uppercases at one line (Task 2). `AnimeSource.search`, `SourceChain.search`, `CatalogService.search` all take the same trailing `catalogId?`.
