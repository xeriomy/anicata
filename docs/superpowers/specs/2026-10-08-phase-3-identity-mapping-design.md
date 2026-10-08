# Phase 3 Design — Identity & mapping

**Date:** 2026-10-08
**Status:** Draft for review
**Supersedes:** the Phase 3 section of `docs/roadmap.md` (narrowed where research forced it — see below) and the stale figures in `docs/id-mapping.md` §5.1.
**Research basis:** `.superpowers/sdd/2026-10-08-phase-3-identity-mapping/` — `research-kitsu-mappings.md` (R1), `research-anizip.md` (R2), `research-fribb-dataset.md` (R3), `research-nuvio-ids-links.md` (R4). Every external claim below cites one of those reports plus its measurement, or is marked **UNVERIFIED**. No invented numbers.

**Binding decisions (user, 2026-10-08, not relitigated):**
- **D1:** emit `links[]` (AniList/MAL/Kitsu/AniDB) on meta even though Nuvio never displays it — near-zero cost, other clients render it.
- **D2:** Fribb bundle is **fetched at build time** (download + trim + gzip at docker build/deploy, CI asserts ≤ 500 KB at gzip-9). Nothing vendored — the dataset is unlicensed (`research-fribb-dataset.md` §6: `"license": None` everywhere upstream).

## Goal

Every item carries cross-source ids, from any id we might be handed — inside Nuvio's 5-second meta budget, without ever returning 5xx.

## Scope change from the roadmap

Two corrections, both forced by re-measurement on 2026-10-08:

1. **Bundle size is BORDERLINE, not comfortable.** `docs/id-mapping.md` §5.1 records "32,363 records → 2.85 MB JSON / 459 KB gzip" against a 2026-09-29 snapshot. Recomputed at HEAD (`research-fribb-dataset.md` §4): 39,619 raw entries → 32,381 trimmed rows → 2,986,974 B minified → **470,111 B (~459 KiB) at gzip-9**, but **498,219 B (~487 KiB) at gzip default level 6** — ~2 KB under the 500 KB line with zero headroom. The old 459 KB figure reproduces *only* at gzip-9. The design therefore pins gzip-9, trims harder than the old 10-field rule (see §3), asserts size in CI with a warn margin, and names the fallback (drop `season`/`type`) if growth tips it over.
2. **ID-resolution live budget is 1500 ms, not 1 s.** `docs/architecture.md` §3.4 allots "ID resolution (live) **1 s**". Measured AniZip alone costs 0.36–0.93 s on cache HITs (One Piece 1.87 MB → 0.93 s total, `research-anizip.md` §5), and cache-MISS timing is **UNVERIFIED** — a 1 s total cannot contain a Kitsu tier *and* an AniZip tier. §6 below replaces the 1 s figure with a 1500 ms shared identity deadline, subdivided per tier.

## Verified characteristics of the identity sources

All probed live on 2026-10-08, not taken from documentation:

| Property | Value | Source |
|---|---|---|
| Fribb raw file | 7,504,080 B, 39,619 entries, JSON array of flat objects | R3 §1–§2 |
| Fribb stable snapshot | commit-pinned raw URL works (`…/4c3e5ff7/…` → 200) | R3 §1, §5 |
| Fribb cadence | automated commits ~weekly (Tue-ish) | R3 §5 |
| Fribb coverage | mal 77.9%, kitsu 56.4%, anilist 52.7%, tmdb 21.5%, tvdb 18.9%, imdb 20.8%; no Trakt | R3 §3 |
| Fribb identity columns | `anilist_id`, `mal_id`, `kitsu_id`, `anidb_id` all duplicate-free | R3 §7 |
| Fribb quirks | `imdb_id` always an array (47 rows >1); `themoviedb_id` object `{tv: n}` (7,125) or `{movie: […]}` (1,394); `season` on 18.8% only | R3 §2 |
| Kitsu forward lookup | `GET /mappings?filter[externalSite]=…&filter[externalId]=…&include=item` → Kitsu id in `relationships.item.data` | R1 §1–§2 |
| Kitsu reverse lookup | `GET /anime/{kitsuId}/mappings` → all rows (`meta.count=7` for anime 12) | R1 §3 |
| Kitsu anime namespaces | `myanimelist/anime` 21,141 · `anilist/anime` 19,064 · `anidb` (bare) 10,794 · `thetvdb/series` 2,157 · `thetvdb` 2,991 · `trakt` 2,687 rows | R1 §4 |
| Kitsu absent namespaces | TMDB, IMDb, AniSearch, AnimePlanet, LiveChart, NotifyMoe all `count:0` (global-absence strictly **UNVERIFIED** — one filter + one reverse listing, not a table scan) | R1 §4 |
| Kitsu latency | `x-runtime` ~0.07–0.12 s | R1 §6 |
| AniZip params | **7 work**: `anilist_id, mal_id, kitsu_id, anidb_id, thetvdb_id, imdb_id, themoviedb_id` (docs listed 5) | R2 §1 |
| AniZip mapping block | 12 keys; `themoviedb_id` bare string (no tv/movie split); `imdb_id` bare `tt…` string; no trakt/simkl | R2 §2 |
| AniZip timing | 0.36–0.93 s on CF HITs; edge TTL 15 min; 20-burst all 200, no rate-limit headers | R2 §5 |
| Nuvio inbound in practice | only `anilist:` (plus `kitsu:` if such ids circulate); `tmdb:` rewritten to IMDb pre-routing; `mal:`/`tt…`/`imdb:`/bare never routed to us | R4 §Q1–Q2 |
| Nuvio `links[]` | parsed (needs `name`+`category`+`url`) but **never displayed** at HEAD `966a52b`; our categories match no people-mining filter | R4 §Q3 |

## Architecture

New and touched files, placed per the lint-enforced boundaries (`docs/architecture.md` §6.1):

```
scripts/build-identity.ts   ← build-time only: fetch (pinned) → trim → gzip-9 → data/
data/identity.min.json.gz   ← build artefact, NOT vendored (D2); .gitignored
src/identity/ids.ts         ← parseIncomingId / formatId / bare-number rejection (pure; domain only)
src/identity/bundle.ts      ← loader + 5 reverse indices (imports: domain, cache, net only)
src/identity/resolver.ts    ← tier chain (imports: domain, cache, net only — see rule below)
src/render/meta-detail.ts   ← links[] emission (imports: domain only — unchanged rule)
```

**Boundary rule (load-bearing):** `identity/` may import `domain`, `cache`, `net` — never `sources/*` (`docs/architecture.md` §6.1). The resolver's live tiers (Kitsu `/mappings`, AniZip) are therefore implemented with the injected `HttpClient` from `net/` plus `cache`, **not** by importing the Kitsu/AniZip source adapters. The adapters keep their own `resolveIdentity` capability for Phase 4 enrichment use; the identity chain does not call them. `services/` orchestrates (`resolve.service` → `identity/resolver`), `addon/meta.ts` calls `parseIncomingId` before cache lookup, exactly as `docs/architecture.md` §7.2 already draws.

### 1. Identity model (`identity/ids.ts`)

Extends the existing union in `src/domain/anime.ts:9-11` (currently `anilist` XOR `kitsu`) to the full namespace set. `AnimeIdentity.anilist` stays the required canonical field wherever we emit; the extension adds optional cross-ids for resolution and rendering:

```ts
type AnimeIdentity = {
  anilist: number;              // canonical; required on emit
  mal?: number;
  kitsu?: string;               // strings ("12") — Kitsu ids are strings (R1 §2)
  anidb?: number;
  tmdb?: { tv?: number; movie?: number };  // object: Fribb shape (R3 §2); AniZip's bare string folds into it
  imdb?: string;                // "tt…" with prefix, first element on multi rows
  tvdb?: number;
  simkl?: number;
};
```

The old XOR union (`kitsu` branch without `anilist`) is retained for the Kitsu-only emission path (`id-mapping.md` §5.3, ADR-016): a resolved identity with no `anilist` renders from Kitsu and emits `kitsu:<id>`. Nothing else changes about that path.

`parseIncomingId(raw)` accepts `anilist:`, `mal:`, `kitsu:`, `tmdb:`, `tt…`, `imdb:` (§5). Rules:

- **Bare numbers rejected** (established: bare number = Trakt id — `TrackingMedia.kt:99-122`, R4 §Q1d; `id-mapping.md` §2.2). Reject means: return `null`, zero upstream calls, handler serves 200 + empty with short `Cache-Control` (never-5xx posture, ADR-010). Applies only to *unprefixed* input; digits inside a prefix parse normally.
- **Case:** accept prefixes case-insensitively on parse (`imdb:`/`IMDB:`, `tt`/`TT`), but always *emit* lowercase. Rationale: Nuvio routing is case-sensitive `startsWith` while its tracking parse is case-insensitive (R4 §Q1a vs §Q1d) — emitting lowercase satisfies both.
- **Video-id suffixes** (`anilist:21:1:5`): split from the right, prefix intact; tolerate `S1`-style specials keys (`id-mapping.md` §4.2, unchanged).
- **`imdb:` values without `tt`** (e.g. `imdb:0213338`): prepend `tt` — AniZip requires the prefix (`=0213338` → 404, R2 §1) and Fribb stores `tt…` strings (R3 §2).
- **`tmdb:` values:** bare digits only (`tv30991`-style affixes rejected — AniZip `=tv30991` → 404, R2 §1). TV-vs-movie ambiguity: try `tv` first, then `movie` (TV dominates anime; Fribb has 7,125 `{tv}` vs 1,394 `{movie}` rows, R3 §2).
- **`formatId`:** canonical `anilist:<n>` when `anilist` present, else `kitsu:<id>` (existing `stremioIdFor` behaviour, `src/domain/anime.ts:77-82`).

### 2. Bundle (`scripts/build-identity.ts` + `identity/bundle.ts`)

Build script (runs at docker build/deploy, per D2; `Dockerfile` already runs `npm run identity:build` per `docs/architecture.md` §10.3):

1. **Fetch** `https://raw.githubusercontent.com/Fribb/anime-lists/<IDENTITY_PIN>/anime-list-full.json`, where `IDENTITY_PIN` is a commit SHA recorded in the artefact header. Commit-pinned raw URLs verified 200 (R3 §1). If fetch fails, the build fails loudly (no silent stale artefact); the *runtime* degrades to live tiers (§4 failure matrix).
2. **Trim.** Keep per row: `anilist_id, mal_id, kitsu_id, anidb_id, tvdb_id, imdb_id (first element), themoviedb_id (tv + first movie), simkl_id`. Drop null/empty fields. **Drop the 18% unusable rows**: 7,238 entries with neither `anilist_id` nor `mal_id` (R3 §3) — without either key the row is unreachable from every inbound form we accept *and* from everything we emit, so it can never participate in resolution. Deliberately dropped vs kept: `season` (present on 18.8%, R3 §2 — episode-offset data, not identity; Phase 4 concern), `type` (format data derivable from AniList at render; not an id), `animecountdown_id`/`animenewsnetwork_id`/`anime-planet_id`/`anisearch_id`/`livechart_id` (no inbound form, no emitted link, no consumer — dead weight at ~79% of raw bytes).
3. **gzip-9** (pinned level 9 in the script — level 6 lands ~2 KB under the line, R3 §4), write `data/identity.min.json.gz` + header `{pin, builtAt, rows}`.
4. **CI asserts** artefact ≤ 500 KB (512,000 B) with a **warn threshold at 480 KB** so growth is noticed before it binds.

Size arithmetic (measured 2026-10-08, R3 §4 — supersedes `id-mapping.md` §5.1):

| Metric | Value |
|---|---|
| Raw | 7,504,080 B, 39,619 entries |
| Trimmed rows (this §2 rule) | ≈ 32,381 |
| Trimmed minified JSON | 2,986,974 B |
| Trimmed **gzip-9** | **470,111 B (~459 KiB)** |
| Budget line | 512,000 B (500 KB) |
| **Headroom** | **41,889 B (~8.2%)** |

Growth runway (derived, not measured — flagged as estimate): trimmed minified ≈ 92 B/row → ~15 B/row gzipped (÷6.35 observed ratio); ~40–60 new entries/week (R3 §5 cadence + growth note) ≈ **~0.6–0.9 KB/week** → headroom covers **~12–18 months** before the line is reached. If CI warn fires: first fallback is dropping `type` remnants/`simkl_id` (lowest-value kept field — no inbound form, no link emitted); second is splitting indices (ship byAnilist/byMal only, resolve the rest live). Neither is implemented now.

`identity/bundle.ts` loads the artefact once at startup and builds **5 reverse indices** — `byAnilist, byMal, byKitsu, byTmdb, byImdb` — each mapping one id → the compact row tuple (one title = one entry regardless of entry id, `id-mapping.md` §5.1). In-memory for process lifetime; resolution served from memory in < 1 ms (roadmap gate). `byTmdb` keys both `tv` and `movie` values; `byImdb` keys each element of multi-IMDb rows (47 rows, R3 §2). `anidb_id`/`tvdb_id`/`simkl_id` are carried on the row, not indexed (no inbound form for them in scope).

### 3. Resolver (`identity/resolver.ts`)

`resolveToCanonical(input): Promise<AnimeIdentity | null>` — tier order **bundle → Kitsu `/mappings` → AniZip → title**, per roadmap scope and correctness rule 4 (`id-mapping.md` §9: prefer bundle → Kitsu → AniZip → title).

**Budgets (exact).** One shared identity deadline per resolution, **`IDENTITY_BUDGET_MS = 1500`**, subdivided as per-tier caps against *remaining* budget (Phase 2 pattern: each tier gets the remainder, never a fresh clock). This supersedes the 1 s figure in `docs/architecture.md` §3.4:

| Tier | Cap | Covers (measured) |
|---|---|---|
| 0. Bundle (in-memory) | 0 ms (synchronous, < 1 ms gate) | free |
| 1. Kitsu `/mappings` | **700 ms** | `x-runtime` 0.07–0.12 s observed (R1 §6) + network headroom; single-row lookup, not a 20-item page |
| 2. AniZip `/mappings` | **900 ms** | 0.36–0.93 s on CF HITs (R2 §5); MISS timing UNVERIFIED, hence cap + degrade |
| 3. Title match (Kitsu `filter[text]`, last resort) | **700 ms**, only if remaining ≥ 200 ms | same Kitsu cost class as tier 1 |
| Floor | **a live tier is skipped unless remaining ≥ 200 ms** | prevents a doomed call burning the source-fetch window |

Worst case: 700 + 900 is unreached in sequence only if tier 1 burns its full cap; the shared 1500 ms deadline bounds the total regardless. Composition with the existing chain: `HTTP_TIMEOUT_MS` default 3500 (clamped ≤ 4000, `src/config/index.ts:57`), chain budget `min(http+500, 4500)` (`src/index.ts:99`) → identity ≤ 1500 leaves ≥ 2500 ms for `fetchById` + render inside Nuvio's 5000 ms (`MetaDetailsRepository.FETCH_TIMEOUT_MS`, compat §8.1). Identity resolution runs *before* source fetch (`docs/architecture.md` §7.2); on identity timeout → return `null` (unknown), never a guess.

**Every upstream trap from research, as a handled case:**

*Kitsu tier* (R1):
- `page[limit]` hard cap 20 — **never send `limit` at all** on single-id lookups (default 10 suffices; the query is keyed by site+id). Fakes must assert this (see §8).
- `include=item`, never `include=anime` (→ 400 code 112, R1 §2/§6).
- Site names exact and case-sensitive: `myanimelist/anime`, `anilist/anime`, `anidb` (bare — `anidb/anime` → 0 rows), `thetvdb/series`; short/bare forms (`tvdb`, `anilist`, `myanimelist`) → 0 rows with no error (R1 §4, §6). The site-name table is a constant, not constructed from input.
- Unknown site/id → **HTTP 200 + `data:[]`, never 404** (R1 §1, §6). Check `data.length`, not status; empty → tier miss, not error.
- **Manga-row filtering:** `externalId`-only queries mix anime+manga rows (R1 §2). Always send both filters (site+id) AND assert `relationships.item.data.type == "anime"` before accepting.
- Reverse direction (`/anime/{kitsuId}/mappings`) for `kitsu:` inbound: dedupe the duplicate TVDB spellings (`thetvdb` vs `thetvdb/series`, same id, R1 §3) on (site,value); ignore `aozora` rows (opaque token ids, semantics UNVERIFIED, R1 §3/UNVERIFIED).
- No auth; send `Accept: application/vnd.api+json` + a `User-Agent` anyway (R1 §5).

*AniZip tier* (R2):
- **Exactly one query param per request** — duplicate same param → HTTP 500 (R2 §1). Never combine; precedence order beyond anilist>mal is UNVERIFIED so combining is also semantically unsafe.
- **404 = absent** (unknown id AND malformed values `0/-1/abc` all → 404 `Not Found`, R2 §1): 404 → tier miss, zero further calls for that value (negative-cache, §6). 400 (empty value / unknown param) is a *client bug* → log loudly, do not retry.
- `imdb_id` needs the `tt` prefix; `themoviedb_id` bare digits (R2 §1/§6) — enforced in `ids.ts` so the tier never sends a known-bad form.
- Consume only the 12-key `mappings` block; ignore `episodes`/`images` here (Phase 4 territory; also avoids parsing 1.87 MB One Piece payloads on the identity path — note the largest sampled payload, R2 §3, as the reason the tier response is truncated after the mappings block or fetched with a size cap).
- `thetvdb_id: null` / `images: []` on titles without TVDB entry (R2 §4) is *not* a failure — null ids stay `undefined` (correctness rule 1).

*Cross-tier:*
- **Verify before trusting** (`id-mapping.md` §9 rule 5): a mapping whose AniList id resolves to a `Media` whose `idMal` contradicts our `mal` is rejected + logged, never cached as authoritative.
- **Malformed id → never maps to a *different* title** (roadmap gate): invalid namespace/blank value → `null` before tier 0, no retries (§9 rule: never invent an id).

### 4. Inbound (§5 of this spec covers handling; routing reality from R4)

Accept `anilist:`, `mal:`, `kitsu:`, `tmdb:`, `tt…`, `imdb:` in `parseIncomingId` even though Nuvio routes only `anilist:`/`kitsu:` to us today (manifest `idPrefixes`, R4 §Q1a–Q2). Rationale (unchanged from `id-mapping.md` §4): other Stremio clients + future-proofing + defence-in-depth (foreign add-ons' `anilist:`/`kitsu:` items fan out to every matching manifest, R4 §Q2). No manifest change in this phase — adding `mal:`/`tmdb:` to `idPrefixes` would pull unrelated traffic (ADR-002) for zero Nuvio benefit.

| Inbound | Resolution path |
|---|---|
| `anilist:<n>` | direct — `Media(id:)`; bundle enriches cross-ids |
| `mal:<n>` | bundle `byMal` → canonical; miss → Kitsu forward (`myanimelist/anime`, §3 traps) → AniZip `mal_id` |
| `kitsu:<id>` | bundle `byKitsu` → canonical; miss → Kitsu **reverse** (`/anime/{id}/mappings`, §3 traps) → AniZip `kitsu_id`; no-AniList outcome → Kitsu-only emission (§1, ADR-016) |
| `tmdb:<n>` | **If one arrives directly** (only possible from non-Nuvio clients — Nuvio rewrites `tmdb:`→IMDb pre-routing, R4 §Q1b, VERIFIED): bundle `byTmdb` (tv first, then movie) → canonical; miss → AniZip `themoviedb_id`. Never emit `tmdb:` (Nuvio would rewrite it; `id-mapping.md` §7.1). |
| `tt…` / `imdb:<…>` | normalize to `tt…` (§1) → bundle `byImdb` → canonical; miss → Kitsu has no IMDb namespace (R1 §4 — skip Kitsu) → AniZip `imdb_id` |

Unknown-but-valid `anilist:99999999` → AniList `data.media = null` → `metas: []` with **zero** fallback calls (roadmap gate; architecture §3.2 — invalid id is not transient). Bare numeric → rejected pre-parse, zero upstream calls (roadmap gate).

### 5. Render: `links[]` + id carriage (D1)

Emit on every full meta (D1 — Nuvio-inert, VERIFIED at HEAD `966a52b`, R4 §Q3; other Stremio clients render them; URLs-as-data survive for a future streaming layer). Exactly three keys per entry — `name`, `category`, `url` — all required by `MetaDetailsParser.links()` (R4 §Q3); no stray keys:

```json
"links": [
  { "name": "AniList",     "category": "AniList",     "url": "https://anilist.co/anime/21" },
  { "name": "MyAnimeList", "category": "MyAnimeList", "url": "https://myanimelist.net/anime/21" },
  { "name": "Kitsu",       "category": "Kitsu",       "url": "https://kitsu.app/anime/12" },
  { "name": "AniDB",       "category": "AniDB",       "url": "https://anidb.net/anime/69" }
]
```

Rules: omit an entry when its id is unknown (never invent — §9 rule 1); categories are database names so they never collide with Nuvio's people-mining filters (R4 §Q3). Meta `id` stays canonical (`anilist:<n>`, or `kitsu:<id>` on the Kitsu-only path); cross-ids other than `links[]` are not added to the meta body in this phase (the `PublicIds` decorative fields in `id-mapping.md` §3 remain a future option — no consumer needs them yet, and every byte ships on every meta).

### 6. Caching

Consistent with the never-5xx + stale-while-broken posture (ADR-010/ADR-012, architecture §4):

| Layer | Key | TTL | Stale grace | Notes |
|---|---|---|---|---|
| Reverse indices | in-memory | process lifetime | — | built once from bundle (§2); L4 in architecture §4.1 |
| Resolved identity (positive) | `resolve:<ns>:<value>` | **30 d** | 90 d | ids are stable (architecture §4.1 L4) |
| Negative (tier miss / unknown) | `resolve:<ns>:<value>` | **10 min** | — | newly-added titles appear promptly (`id-mapping.md` §8) |
| Low-confidence (title match) | `resolve:<title>` | **1 h** | — | never promoted to authoritative (`id-mapping.md` §5.2 step 6) |
| Live tier responses (L5 raw) | upstream URL | 10 min | 1 h | shields transient failures (architecture §4.1 L5) |

Failure semantics: all-tiers-miss → `null` → handler renders minimal/empty **200** (architecture §7.3 Minimal level). Bundle missing/corrupt at startup → log loudly, serve live tiers only (`id-mapping.md` §12). 429 on a live tier → **no next-tier call** (ADR-011 — rate-limit is not a fallback trigger); serve stale identity cache if present, else `null`. 5xx/timeout/network/parse → next tier. AniZip 500 (the duplicate-param trap, R2 §1) must never occur by construction (§3: exactly one param); if seen, log as client bug + treat as tier miss.

### 7. Docs corrections (from R4 §Q5 — in scope for this phase)

1. **`docs/nuvio-compatibility.md` §8.1 + §14 checklist** show meta `types: ["anime"]`, `idPrefixes: ["anilist:"]`. Reality (`src/addon/manifest.ts:70-73`): `types: ["anime","movie"]`, `idPrefixes: ["anilist:","kitsu:"]`. Update both to the dual form (R4 §Q5.1–Q5.2). Behavioural impact: none (superset routing); editorial.
2. **`docs/id-mapping.md` §7.3** example has a stray `"type": "Kitsu"` key on one `links[]` entry. Drop it (R4 §Q5.4; §5 of this spec is the conforming example).
3. **`docs/nuvio-compatibility.md` §8.1** "UNVERIFIED whether this [tmdb rewrite] runs for our addon specifically" → mark **VERIFIED**: runs unconditionally in `fetch()` before manifest selection (R4 §Q1b).

### 8. Test strategy

**Contract tests with REAL captures only** (Phase 2 lesson stands: fixtures are recorded live API responses, never fabricated). Fixtures that must be captured live, and from where:

| Fixture | Source | Why |
|---|---|---|
| Kitsu forward `myanimelist/anime:21` + `include=item` → anime 12 | `GET /mappings?…` (R1 §2 capture) | canonical agreement leg |
| Kitsu forward `anilist/anime:21` → anime 12 | same endpoint | second agreement leg |
| Kitsu reverse `/anime/12/mappings` (7 rows incl. both TVDB spellings + `aozora`) | R1 §3 capture | dedupe + ignore-aozora rules |
| Kitsu `myanimelist/manga:1` → `item.type: manga` | R1 §2 capture | manga-row filter |
| Kitsu unknown id → 200 + `data:[]` | R1 §1 capture | empty-vs-404 rule |
| Kitsu `include=anime` → 400 code 112 (or asserted via fake — live re-probe optional) | R1 §2 | regression on the trap |
| AniZip `anilist_id=21` (One Piece mappings block) | `GET /mappings` (R2 §2) | agreement leg + tv/movie-split absence |
| AniZip `anilist_id=1` (Bebop) | same | second title |
| AniZip unknown/malformed → 404 bodies | R2 §1 | 404-as-absent |
| Fribb trimmed-row samples (One Piece entry, multi-IMDb row, `{movie:[…]}` row) | trimmed artefact (R3 §2) | first-element / tv-first policies |
| One Piece agreement set: bundle row + Kitsu + AniZip all → anilist 21 | composed from above | the unweakened gate |

**Offline fakes must assert request params** (Phase 2 lesson: fakes that ignore params hide cap bugs). Concretely: the Kitsu fake rejects `page[limit]>20` and `include=anime` with the real 400 bodies, returns `data:[]` (200) for unknown — not 404 — and the AniZip fake returns **500 on duplicate params**, 404 on bad values, 400 on empty/unknown params (R2 §1 table). A resolver that sends a forbidden form must fail the test *through the fake*, proving the trap is handled in code, not in prose.

**Live tests use production values** (`ANICATA_LIVE=1` suite): One Piece across all four legs (`anilist:21`), Bebop (`anilist:1`) for a small-payload title, `mal:21`/`kitsu:12`/`tmdb:37854`/`tt0388629` inbound resolution, unknown `anilist:99999999` → empty with zero fallback calls (spy), bare `21` → rejected with zero upstream calls.

### 9. Exit gates (1:1 with roadmap Phase 3 gates, with closing evidence)

| # | Roadmap gate | Evidence that closes it |
|---|---|---|
| 1 | `npm run identity:build` reproduces a ≤ 500 KB gzipped artefact | CI log: artefact bytes ≤ 512,000 at pinned gzip-9 + recorded `IDENTITY_PIN`; warn at 480 KB |
| 2 | One Piece: all four sources agree; `id` = `anilist:21` | agreement test over REAL captures: bundle row + Kitsu forward + Kitsu reverse + AniZip all resolve to `anilist:21` (**not weakened** — four legs, not three) |
| 3 | `mal:21`, `kitsu:12`, `tmdb:37854`, `tt0388629` all resolve to `anilist:21` | inbound resolution test per §4 (live suite uses these production values) |
| 4 | Unknown-but-valid `anilist:99999999` → `metas: []`, **zero** fallback calls | test with fallback spy showing 0 calls (architecture §3.2) |
| 5 | Bare numeric id → rejected, no upstream call | parse test + handler test asserting 0 upstream calls |
| 6 | Mapping resolution served from memory in < 1 ms | benchmark test on loaded bundle (tier 0 path only) |
| 7 | Malformed id → never maps to a *different* title | adversarial parse tests (wrong-namespace values, `tv`-prefixed tmdb, prefix-less `tt` digits, `S1`-suffix forms) — every case yields `null` or the correct title, never a wrong one |

## Out of scope

Streaming, tracking, accounts, Trakt/Simkl integrations — restated, unchanged. Also out of scope in this phase: episode/`videos[]` extraction from AniZip (Phase 4 — the resolver truncates after the mappings block), TMDB `/find` as a tier (key-gated, enrichment-only per architecture §3.3), `mal:`/`tmdb:` manifest `idPrefixes` (ADR-002), and vendoring the Fribb data (D2).

## Open questions for implementation

1. **TMDB tv/movie disambiguation beyond tv-first.** tv-first is a frequency heuristic (7,125 vs 1,394 rows, R3 §2), not a correctness proof. A `tmdb:` id that exists as *both* a TV and a movie entry could misresolve. Non-Nuvio volume for direct `tmdb:` inbound is expected near-zero (R4 §Q2) — acceptable residual, worth a log line when the movie leg is taken.
2. **AniZip cache-MISS latency** is UNVERIFIED (all samples were CF HITs, R2 §7). The 900 ms tier cap assumes MISSes are rare (15 min edge TTL, R2 §5); if production shows frequent MISS overruns, lower the cap and let Kitsu carry more.
3. **Kitsu numeric rate limit** is UNVERIFIED (no headers; only a 10-req burst tested, R1 §5/UNVERIFIED). The tier relies on existing limiters + the 10 min L5 raw cache (§6); sustained-abuse behaviour unknown.
4. **Fribb current-season completeness** is UNVERIFIED (R3 §7/UNVERIFIED). New-season titles missing from the bundle resolve via live tiers; no action unless the negative-cache churn becomes visible in logs.
