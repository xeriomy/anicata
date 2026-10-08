# Phase 3 Implementation Plan — Identity & mapping

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Controller dispatches **sequentially — only one implementer at a time**; each task is independently reviewable and lands green before the next starts.

**Goal:** Every item carries cross-source ids, from any id we might be handed — inside Nuvio's 5-second meta budget, without ever returning 5xx.

**Architecture:** Task 1 extends the identity model. Task 2 adds `parseIncomingId`/`formatId` + bare-number rejection. Task 3 records ALL live fixtures first (no resolver code before captures exist). Task 4 adds the build-time Fribb script (D2). Task 5 adds the bundle loader + 5 reverse indices. Tasks 6–7 add the resolver tier chain with per-tier budgets and every upstream trap as a handled+tested case. Task 8 proves inbound resolution for all six namespaces. Task 9 emits `links[]` (D1). Task 10 adds identity caching. Task 11 wires the resolver into meta + catalogue paths. Task 12 makes the 3 doc corrections. Task 13 is the whole-branch review.

**Tech Stack:** TypeScript 5.x (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node 22, Vitest, ESLint 9 flat config, existing `HttpClient` from `src/net/` + existing cache. No new runtime dependencies — verify `git diff <base>..HEAD -- package.json` is empty on every task.

**Spec:** `docs/superpowers/specs/2026-10-08-phase-3-identity-mapping-design.md` (binding authority — every task cites its spec section; no invented scope).

## Global Constraints

- No `any` in `src/`. No new runtime dependency.
- `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true` are on. **Omit** optional keys; never assign `undefined`.
- **Test fixtures are REAL live captures only, never hand-written bodies.** Offline fakes must assert request params (Phase 2 lesson): a resolver that sends a forbidden form must fail *through the fake*.
- Tests are offline by default. Network calls go in `test/live/` behind `ANICATA_LIVE=1`.
- **Baseline to preserve on every task:** `npm test` = 307 passed + 6 skipped; `npm run typecheck` exit 0 covering `test/`; `npm run lint` exit 0; `unshare -n -- npm test` green. Report `tsc`'s **exit code**, not just absent output.
- **Lint boundaries (load-bearing, spec §Architecture):** `src/identity/**` may import `domain`, `cache`, `net` — **never `sources/*`**. The resolver implements Kitsu/AniZip tiers with the injected `HttpClient` from `net/` directly, never by importing source adapters. `src/sources/**` adapters never import each other. `src/services/**` never imports `**/sources/*/adapter*`. `src/addon/**` imports neither `sources/*/adapter*` nor `net/**`. `src/render/**` imports domain only (unchanged rule).
- Never return a non-200. Identity miss → `null` → handler renders minimal/empty **200** (never a guess, never an invented id).
- Non-goals everywhere: no streaming, no tracking/accounts, no Trakt/Simkl integration, no episode/`videos[]` extraction (Phase 4), no TMDB `/find` tier, no `mal:`/`tmdb:` manifest `idPrefixes` change (ADR-002), no vendoring of Fribb data (D2).

## Review Focus

Five input classes the spec implies that no single task's happy path exercises. Each has a test pinned to the task that owns the code.

1. **A `tmdb:` id that exists as both a TV and a movie entry.** Expected: tv-first wins, movie leg logged, never a wrong title. → Task 8
2. **A Kitsu `myanimelist/manga:1` row returned for an anime-id query.** Expected: rejected by `item.type == "anime"` check, tier continues. → Task 6
3. **An AniZip request with two query params.** Expected: never constructed; the fake returns 500 on duplicate params so a combining resolver fails the test. → Task 7
4. **A 429 from any live tier.** Expected: no next-tier call (ADR-011), stale-or-`null`, never a throw. → Task 7/10
5. **A multi-IMDb Fribb row (47 exist).** Expected: first element indexed, all elements resolvable. → Task 5

---

### Task 1: Identity model extension

Spec §1. The canonical field stays `anilist`; cross-ids are added for resolution and rendering only.

**Files:**
- Modify: `src/domain/anime.ts:9-11,77-82`
- Test: `test/identity-model.test.ts`

**Interfaces:**
- Consumes: existing `Anime` / `AnimeIdentity` union in `src/domain/anime.ts`.
- Produces: extended `AnimeIdentity` with `anilist` (required on emit), optional `mal?`, `kitsu?: string` (strings, e.g. `"12"`), `anidb?`, `tmdb?: { tv?: number; movie?: number }`, `imdb?: string` (`tt…` with prefix), `tvdb?`, `simkl?`. Old XOR union (Kitsu-only branch without `anilist`) retained for the Kitsu-only emission path (ADR-016).

**Lint constraint:** `src/domain/**` imports nothing (unchanged).

**Non-goal:** no parsing/resolution here — type shape only. No streaming/tracking/Trakt.

- [ ] **Step 1: Write the failing test** — `test/identity-model.test.ts`: asserts optional cross-ids accepted, `kitsu` is a string, `tmdb` is `{tv,movie}` object shape, `stremioIdFor`-equivalent still emits `anilist:<n>` when present else `kitsu:<id>`.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/identity-model.test.ts`, expect FAIL (fields missing).
- [ ] **Step 3: Implement** the extended type verbatim per spec §1; keep `formatId`/`stremioIdFor` behaviour unchanged.
- [ ] **Step 4: Run to verify it passes** — `npx vitest run test/identity-model.test.ts`; then full baseline (`npm test`, `npm run typecheck`, `npm run lint`).
- [ ] **Step 5: Commit** — `git add src/domain/anime.ts test/identity-model.test.ts; git commit -m "feat(identity): extend AnimeIdentity with cross-source ids"`

**Exit gate:** typecheck exit 0, lint exit 0, baseline 307+6 preserved. Evidence: test output + `tsc` exit code.
**Reviewer handoff:** diff of `src/domain/anime.ts` + new test; confirm no behaviour change to emit paths.
**Closes roadmap gate:** none (enabler).

---

### Task 2: parse/format + bare-number rejection

Spec §1 (`parseIncomingId`/`formatId` rules) + §3 cross-tier malformed rule + §4 inbound table (parse side).

**Files:**
- Create: `src/identity/ids.ts`
- Test: `test/identity-ids.test.ts`

**Interfaces:**
- Consumes: extended `AnimeIdentity` (Task 1).
- Produces: `parseIncomingId(raw: string): { ns, value } | null`; `formatId(id: AnimeIdentity): string` (canonical `anilist:<n>` else `kitsu:<id>`).

**Lint constraint:** `src/identity/**` imports `domain` only for this task (no `sources/*`, no `net` yet).

**Non-goal:** no network, no bundle, no resolver. No Trakt (bare numbers are Trakt ids → rejected, not resolved).

- [ ] **Step 1: Write the failing test** — accepts `anilist:`, `mal:`, `kitsu:`, `tmdb:`, `tt…`, `imdb:`; **bare numbers → `null` with zero upstream calls** (gate 5); case-insensitive parse (`IMDB:`/`TT`) but lowercase emit; video-id suffixes split from right (`anilist:21:1:5`); `imdb:0213338` → `tt0213338`; `tmdb:` bare digits only (`tv30991` rejected); adversarial malformed set (wrong-namespace values, prefix-less `tt` digits, `S1`-suffix forms) → `null` or correct title, never a wrong one (gate 7).
- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** `src/identity/ids.ts` per spec §1 rules verbatim.
- [ ] **Step 4: Run to verify it passes** + baseline.
- [ ] **Step 5: Commit** — `git add src/identity/ids.ts test/identity-ids.test.ts; git commit -m "feat(identity): parse/format inbound ids, reject bare numbers"`

**Exit gate:** gate-5 parse half (bare → `null`, no calls) + gate-7 adversarial parse cases green. Evidence: vitest output.
**Reviewer handoff:** test list vs spec §1 rule list, one-to-one.
**Closes roadmap gate:** 5 (partial — parse half; handler half in Task 11), 7 (partial — parse half; resolver half in Task 8).

---

### Task 3: Live-capture fixture set

Spec §8 (fixture table). No `src/` change — captures only. Must land before Tasks 6–8 so those tests use real bodies.

**Files:**
- Create: `test/fixtures/identity/kitsu-forward-mal-21.json`, `kitsu-forward-anilist-21.json`, `kitsu-reverse-12.json`, `kitsu-manga-1.json`, `kitsu-unknown.json`, `anizip-21.json`, `anizip-1.json`, `anizip-404.json`, `fribb-rows.json`, plus `test/fixtures/identity/README.md` (capture date 2026-10-08, endpoint + params per file).

**Interfaces:** none (data only).

**Non-goal:** no code, no fabricated bodies. No streaming/tracking/Trakt.

- [ ] **Step 1: Capture Kitsu forward** — `GET /mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=21&include=item` → anime 12; and `externalSite=anilist/anime&externalId=21` → anime 12. Save verbatim with envelope.
- [ ] **Step 2: Capture Kitsu reverse** — `GET /anime/12/mappings` (7 rows incl. both TVDB spellings + `aozora`).
- [ ] **Step 3: Capture Kitsu traps** — `myanimelist/manga:1` (manga row for type filter); unknown id → 200 + `data:[]`; `include=anime` → 400 code 112 (or record assertion via fake if live re-probe not possible — note which in README).
- [ ] **Step 4: Capture AniZip** — `GET /mappings?anilist_id=21` (One Piece mappings block); `?anilist_id=1` (Bebop); unknown/malformed (`=0`, `=-1`, `=abc`) → 404 bodies.
- [ ] **Step 5: Capture Fribb samples** — trimmed-row samples: One Piece entry, one multi-IMDb row, one `{movie:[…]}` row (from trimmed artefact, R3 §2).
- [ ] **Step 6: Write README** — per-file endpoint + params + date; note MISS timing UNVERIFIED, Kitsu global-absence UNVERIFIED.
- [ ] **Step 7: Commit** — `git add test/fixtures/identity/; git commit -m "test(identity): live captures for Kitsu/AniZip/Fribb"`

**Exit gate:** every file is a byte-verbatim live response; README maps file → endpoint → params. Evidence: `ls` + README + curl commands in commit message.
**Reviewer handoff:** spot-check one fixture against a live re-fetch (status + `meta.count`/key shape).
**Closes roadmap gate:** none (enabler for gates 2, 3, 7).

---

### Task 4: build-identity script (D2)

Spec §2 (build script 1–4) + §8 size arithmetic. D2: fetched at build time, nothing vendored.

**Files:**
- Create: `scripts/build-identity.ts`
- Modify: `package.json` scripts (`identity:build`), `.gitignore` (`data/identity.min.json.gz`), CI workflow (size assert ≤ 512,000 B, warn at 480 KB)
- Test: `test/identity-build.test.ts` (trim logic unit test over Task 3 Fribb samples — pure function, offline)

**Interfaces:**
- Consumes: Fribb `https://raw.githubusercontent.com/Fribb/anime-lists/<IDENTITY_PIN>/anime-list-full.json` (commit-pinned; pin recorded in artefact header `{pin, builtAt, rows}`).
- Produces: `data/identity.min.json.gz` (gzip-9 pinned — level 6 lands ~2 KB under the line, never use default) + header.

**Lint constraint:** script is build-time only; imports no `src/` runtime layers.

**Non-goal:** no runtime loader here (Task 5). No `season`/`type`/dead-id columns (`animecountdown_id`, `animenewsnetwork_id`, `anime-planet_id`, `anisearch_id`, `livechart_id`) — deliberately dropped dead weight. No Trakt.

- [ ] **Step 1: Write the failing test** — trim keeps `anilist_id, mal_id, kitsu_id, anidb_id, tvdb_id, imdb_id` (first element), `themoviedb_id` (tv + first movie), `simkl_id`; drops null/empty; drops the ~7,238 rows with neither `anilist_id` nor `mal_id`; expected trimmed rows ≈ 32,381.
- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** fetch (pinned SHA; fetch failure → loud build failure, no silent stale) → trim → gzip-9 → write artefact + header.
- [ ] **Step 4: Run `npm run identity:build`, assert bytes ≤ 512,000** (expect ≈ 470,111 B; warn at 480 KB). Record `IDENTITY_PIN`.
- [ ] **Step 5: Add CI assert** (fail > 512,000 B, warn > 480 KB) + `.gitignore` entry proving artefact not vendored.
- [ ] **Step 6: Commit** — `git add scripts/build-identity.ts test/identity-build.test.ts package.json .gitignore <ci-file>; git commit -m "feat(identity): build-time Fribb fetch/trim/gzip-9 with CI size assert"`

**Exit gate:** ROADMAP GATE 1 — CI log: artefact bytes ≤ 512,000 at pinned gzip-9 + recorded pin; warn at 480 KB.
**Reviewer handoff:** build log with byte count, pin, gzip-level pin line in script, CI config diff.
**Closes roadmap gate:** 1.

---

### Task 5: Bundle loader + 5 reverse indices

Spec §2 (`identity/bundle.ts`) — tier 0. Depends on Tasks 3 (samples) + 4 (artefact shape).

**Files:**
- Create: `src/identity/bundle.ts`
- Test: `test/identity-bundle.test.ts` (loads Task 3/4 artefact or trimmed sample; benchmark asserts tier-0 < 1 ms)

**Interfaces:**
- Consumes: `data/identity.min.json.gz` + `AnimeIdentity` (Task 1); imports domain, cache, net only.
- Produces: `loadBundle()` (once at startup) + 5 indices `byAnilist, byMal, byKitsu, byTmdb, byImdb` mapping one id → compact row tuple. `byTmdb` keys both tv and movie; `byImdb` keys each element of multi-IMDb rows. `anidb_id`/`tvdb_id`/`simkl_id` carried, not indexed.

**Lint constraint:** `identity/` may import `domain`, `cache`, `net` — never `sources/*`. Missing/corrupt bundle at startup → log loudly, serve live tiers only (not a throw).

**Non-goal:** no live tiers here. No episode/image parsing.

- [ ] **Step 1: Write the failing test** — lookups by anilist/mal/kitsu/tmdb-tv/tmdb-movie/imdb (incl. second element of a multi-IMDb row) resolve; benchmark: in-memory resolution < 1 ms (gate 6); missing file → loader degrades, no throw.
- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** loader + indices (in-memory, process lifetime).
- [ ] **Step 4: Run to verify it passes** + baseline.
- [ ] **Step 5: Commit** — `git add src/identity/bundle.ts test/identity-bundle.test.ts; git commit -m "feat(identity): bundle loader with five reverse indices"`

**Exit gate:** ROADMAP GATE 6 — benchmark test on loaded bundle, tier-0 path < 1 ms.
**Reviewer handoff:** index key lists vs spec §2; benchmark numbers.
**Closes roadmap gate:** 6.

---

### Task 6: Resolver — bundle + Kitsu tiers with all Kitsu traps

Spec §3 (budgets + Kitsu trap list) + §6 failure semantics (Kitsu part). Depends on Tasks 1–3, 5.

**Files:**
- Create: `src/identity/resolver.ts` (skeleton with tiers 0–1; tiers 2–3 stubbed to miss), `src/identity/kitsu-tier.ts` (or inline — one file preferred)
- Test: `test/identity-resolver-kitsu.test.ts` (+ offline fakes: Kitsu fake rejects `page[limit]>20` and `include=anime` with real 400 bodies, returns 200+`data:[]` for unknown — never 404)

**Interfaces:**
- Consumes: bundle (Task 5), injected `HttpClient` from `net/` + cache; `IDENTITY_BUDGET_MS = 1500`, Kitsu cap 700 ms, floor: skip tier unless remaining ≥ 200 ms.
- Produces: `resolveToCanonical(input): Promise<AnimeIdentity | null>` (tiers 0–1 working).

**Lint constraint:** resolver imports domain, cache, net only — **MUST NOT import `sources/*` adapters** (assert with `grep -rn 'sources/' src/identity/` → no output; extend `eslint.config.js` with an `src/identity/**` boundary rule in this task).

**Non-goal:** no AniZip/title tiers (Task 7). No streaming/tracking/Trakt.

- [ ] **Step 1: Write the failing tests** — every Kitsu trap as a case through the param-asserting fake: never sends `page[limit]` on single-id lookups; `include=item` only; exact case-sensitive site table (`myanimelist/anime`, `anilist/anime`, bare `anidb`, `thetvdb/series`); unknown → 200+`data:[]` → tier miss; manga-row rejected via `relationships.item.data.type == "anime"`; reverse `/anime/{id}/mappings` dedupes both TVDB spellings on (site,value) and ignores `aozora`; sends `Accept: application/vnd.api+json` + `User-Agent`.
- [ ] **Step 2: Run to verify they fail** — module not found.
- [ ] **Step 3: Implement** tiers 0–1 with shared-deadline accounting (each tier gets remainder, never a fresh clock); Kitsu tier via `HttpClient` directly.
- [ ] **Step 4: Run to verify they pass** + lint boundary check + baseline.
- [ ] **Step 5: Commit** — `git add src/identity/ test/identity-resolver-kitsu.test.ts eslint.config.js; git commit -m "feat(identity): resolver bundle-plus-Kitsu tiers with trap handling"`

**Exit gate:** all Kitsu-trap tests green through param-asserting fakes built from Task 3 captures; `eslint` boundary rule added and green.
**Reviewer handoff:** trap-table checklist (spec §3 Kitsu bullets) vs test names, one-to-one.
**Closes roadmap gate:** 2 (partial — bundle+Kitsu legs of One Piece agreement), 7 (partial — Kitsu-side never-wrong-title).

---

### Task 7: Resolver — AniZip + title tiers, budgets, failure matrix

Spec §3 (AniZip + cross-tier traps, budgets) + §6 (failure semantics, negative caching of 404s). Depends on Task 6.

**Files:**
- Modify: `src/identity/resolver.ts` (+ `src/identity/anizip-tier.ts` or inline)
- Test: `test/identity-resolver-anizip.test.ts`, extend `test/identity-resolver-kitsu.test.ts` for cross-tier/budget cases

**Interfaces:**
- Consumes: same `HttpClient` + cache; caps: AniZip 900 ms, title 700 ms (only if remaining ≥ 200 ms); shared 1500 ms deadline bounds total.
- Produces: full chain bundle → Kitsu → AniZip → title.

**Lint constraint:** still no `sources/*` imports in `identity/` (re-assert via grep + lint).

**Non-goal:** no episode/`images` consumption — truncate after the 12-key `mappings` block (or size cap; One Piece 1.87 MB is why). No TMDB `/find`. No Trakt.

- [ ] **Step 1: Write the failing tests** — AniZip fake: **500 on duplicate params** (resolver must send exactly one per request — precedence combining is unsafe); 404 on unknown/malformed (`0/-1/abc`) → tier miss + negative-cache, zero further calls for that value; 400 on empty/unknown param → loud log, no retry; `tt`-prefix and bare-digits enforced (known-bad forms never sent); only the 12-key `mappings` block consumed; `thetvdb_id: null` stays `undefined` (not a failure). Cross-tier: AniList-contradicting mapping rejected+logged, never cached authoritative; malformed → `null` before tier 0. Budgets: full-cap burn still bounded by 1500 ms; tier skipped when remaining < 200 ms. 429 on any tier → **no next-tier call** (ADR-011), stale-or-`null`; 5xx/timeout/network/parse → next tier; AniZip 500 → client-bug log + tier miss.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** tiers 2–3 + deadline/failure matrix.
- [ ] **Step 4: Run to verify they pass** + baseline.
- [ ] **Step 5: Commit** — `git add src/identity/ test/identity-resolver-anizip.test.ts; git commit -m "feat(identity): AniZip and title tiers with shared 1500ms budget"`

**Exit gate:** One Piece agreement over REAL captures (bundle row + Kitsu forward + Kitsu reverse + AniZip → `anilist:21`, four legs not three — gate 2 full); budget/failure-matrix tests green.
**Reviewer handoff:** trap-table checklist (spec §3 AniZip + cross-tier bullets) vs test names.
**Closes roadmap gate:** 2 (full).

---

### Task 8: Inbound resolution for all six namespaces

Spec §4 (inbound table) + §1 tmdb tv-first heuristic. Depends on Tasks 2, 6, 7.

**Files:**
- Modify: `src/identity/resolver.ts` (inbound dispatch)
- Test: `test/identity-inbound.test.ts` (offline, real captures) + `test/live/identity.live.test.ts` (behind `ANICATA_LIVE=1`)

**Interfaces:**
- Consumes: `parseIncomingId` (Task 2) + full tier chain (Tasks 6–7).
- Produces: paths — `anilist:<n>` direct (+bundle enrich); `mal:<n>` via byMal → Kitsu forward (`myanimelist/anime`) → AniZip `mal_id`; `kitsu:<id>` via byKitsu → Kitsu reverse → AniZip `kitsu_id` (no-AniList → Kitsu-only emission, ADR-016); `tmdb:<n>` via byTmdb tv-first-then-movie → AniZip `themoviedb_id` (never emitted); `tt…`/`imdb:` normalized → byImdb → AniZip `imdb_id` (Kitsu skipped — no IMDb namespace). Unknown `anilist:99999999` → `null` with zero fallback calls; bare numeric → `null` with zero upstream calls.

**Lint constraint:** no `sources/*` imports; no manifest `idPrefixes` change in this phase (ADR-002).

**Non-goal:** no emitting `tmdb:` ids; no manifest change; no Trakt/Simkl resolution.

- [ ] **Step 1: Write the failing offline tests** — `mal:21`, `kitsu:12`, `tmdb:37854`, `tt0388629` → `anilist:21` (gate 3); tv/movie both-present row → tv wins + movie-leg log line; unknown `anilist:99999999` → `null` with fallback spy at 0 calls (gate 4); bare `21` → `null` with 0 upstream calls (gate 5 full).
- [ ] **Step 2: Write the live tests** — One Piece across all four legs (`anilist:21`), Bebop (`anilist:1`), `mal:21`/`kitsu:12`/`tmdb:37854`/`tt0388629` inbound, unknown + bare cases with spies.
- [ ] **Step 3: Run offline to verify they fail.**
- [ ] **Step 4: Implement** inbound dispatch.
- [ ] **Step 5: Run offline to verify they pass** + baseline (do NOT run live suite here — Task 13 runs it once).
- [ ] **Step 6: Commit** — `git add src/identity/ test/identity-inbound.test.ts test/live/identity.live.test.ts; git commit -m "feat(identity): inbound resolution for six namespaces"`

**Exit gate:** ROADMAP GATES 3, 4, 5 (full), 7 (full — adversarial wrong-namespace/tv-prefix cases yield `null` or correct title).
**Reviewer handoff:** inbound table (spec §4) vs test names, one-to-one.
**Closes roadmap gate:** 3, 4, 5, 7.

---

### Task 9: links[] emission (D1)

Spec §5. D1: emit though Nuvio never displays (VERIFIED inert at HEAD `966a52b`; other clients render).

**Files:**
- Modify: `src/render/meta-detail.ts`
- Test: `test/meta-links.test.ts` (golden JSON)

**Interfaces:**
- Consumes: resolved `AnimeIdentity`.
- Produces: `links[]` with exactly three keys per entry (`name`, `category`, `url` — no stray keys); AniList/MAL/Kitsu/AniDB entries; omit when id unknown (never invent); meta `id` stays canonical (`anilist:<n>`, or `kitsu:<id>` on Kitsu-only path); no other cross-ids in meta body.

**Lint constraint:** `src/render/**` imports domain only (unchanged rule).

**Non-goal:** no decorative `PublicIds` fields; no streaming/tracking/Trakt.

- [ ] **Step 1: Write the failing test** — golden JSON matching spec §5 example URLs; unknown-id omission; stray-key rejection (`"type"` key fails the test); canonical id preserved.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** emission.
- [ ] **Step 4: Run to verify it passes** + baseline; confirm existing render tests unmodified and green.
- [ ] **Step 5: Commit** — `git add src/render/meta-detail.ts test/meta-links.test.ts; git commit -m "feat(render): emit links[] for AniList/MAL/Kitsu/AniDB"`

**Exit gate:** golden snapshot green; no stray keys; omission rule proven.
**Reviewer handoff:** golden JSON vs spec §5 example, entry-for-entry.
**Closes roadmap gate:** none (D1 render; supports gate 2's `id` assertion).

---

### Task 10: Identity caching

Spec §6 (cache table + failure semantics). Depends on Tasks 6–8.

**Files:**
- Modify: `src/identity/resolver.ts` (cache integration; uses existing cache store)
- Test: `test/identity-cache.test.ts`

**Interfaces:**
- Consumes: existing cache store.
- Produces: keys `resolve:<ns>:<value>` positive 30 d / 90 d stale; negative (tier miss/unknown) 10 min; title-match `resolve:<title>` 1 h, never promoted to authoritative; L5 raw upstream-URL 10 min / 1 h stale. All-tiers-miss → `null` → 200 minimal/empty. 429 → no next tier, stale-or-`null`.

**Lint constraint:** identity imports cache + net only (no `sources/*`).

**Non-goal:** no TTL tuning from hit rates (Phase 6). No disk cache. No tracking.

- [ ] **Step 1: Write the failing tests** — positive hit serves without upstream (spy 0 calls); negative hit suppresses re-fetch within 10 min but re-resolves after; title-match never overwrites an authoritative entry; stale served on 429/5xx within grace; verify-before-trust rejection never cached as authoritative.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** cache layers with injected clock (deterministic time, no fake-timer dependence).
- [ ] **Step 4: Run to verify they pass** + baseline.
- [ ] **Step 5: Commit** — `git add src/identity/ test/identity-cache.test.ts; git commit -m "feat(identity): positive/negative/title/L5 caching with stale grace"`

**Exit gate:** cache-behaviour tests green; 429-no-next-tier proven with spy.
**Reviewer handoff:** TTL table (spec §6) vs test names, one-to-one.
**Closes roadmap gate:** none directly (supports gates 2–6 under failure).

---

### Task 11: Wire resolver into meta + catalogue paths

Spec §Architecture (`resolve.service` → `identity/resolver`; `addon/meta.ts` calls `parseIncomingId` before cache lookup; §7.2 flow) + §4 unknown/bare rules at handler level.

**Files:**
- Create/modify: `src/services/resolve.service.ts` (or extend meta service — smallest seam that matches architecture §7.2)
- Modify: `src/addon/meta.ts` (parse before cache lookup), catalogue path (identity enrichment on items)
- Test: `test/identity-wiring.test.ts` (handler-level: unknown `anilist:99999999` → `metas: []` zero fallback calls; bare numeric → 200-empty zero upstream calls; namespaced cache keys carry resolved identity)

**Interfaces:**
- Consumes: `parseIncomingId` (Task 2) + `resolveToCanonical` (Tasks 6–8) + existing services.
- Produces: meta path resolves inbound → canonical → `fetchById` + render; catalogue items enriched with cross-ids.

**Lint constraint:** `services/` orchestrates but never imports `sources/*/adapter*`; `addon/` imports neither adapters nor `net/` — resolver is reached via the service, not directly.

**Non-goal:** no source-adapter changes; no manifest change; no streaming/tracking/Trakt.

- [ ] **Step 1: Write the failing tests** — handler asserts gates 4–5 end-to-end (spies show 0 fallback/upstream calls); `anilist:21` meta carries `links[]` + canonical id; catalogue item carries cross-ids.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** wiring (parse before cache lookup per §7.2; identity timeout → `null`, never a guess; composition with chain budget: identity ≤ 1500 leaves ≥ 2500 ms for fetch+render).
- [ ] **Step 4: Run to verify they pass** + `unshare -n -- npm test` green + baseline.
- [ ] **Step 5: Commit** — `git add src/services/ src/addon/ test/identity-wiring.test.ts; git commit -m "feat(identity): wire resolver into meta and catalogue paths"`

**Exit gate:** gates 4–5 proven at handler level (not just unit level); offline suite green under `unshare -n`.
**Reviewer handoff:** request-flow trace (inbound → parse → resolve → fetch → render) with file:line refs.
**Closes roadmap gate:** 4, 5 (handler-level proof).

---

### Task 12: Three doc corrections

Spec §7 (from R4 §Q5). Docs only, no code.

**Files:**
- Modify: `docs/nuvio-compatibility.md` (§8.1 + §14 checklist; tmdb-rewrite VERIFIED), `docs/id-mapping.md` (§7.3 stray key), `docs/roadmap.md` (tick Phase 3 gates proven by Tasks 4–8, 11)

**Interfaces:** none.

**Non-goal:** no behaviour change; no streaming/tracking/Trakt scope creep.

- [ ] **Step 1: Fix compat §8.1 + §14** — `types: ["anime","movie"]`, `idPrefixes: ["anilist:","kitsu:"]` to match `src/addon/manifest.ts:70-73`; mark tmdb-rewrite VERIFIED (unconditional in `fetch()` pre-manifest-selection).
- [ ] **Step 2: Fix id-mapping §7.3** — drop stray `"type": "Kitsu"` key from `links[]` example.
- [ ] **Step 3: Tick roadmap Phase 3 gates** proven by this branch; leave unproven ones unticked.
- [ ] **Step 4: Commit** — `git add docs/nuvio-compatibility.md docs/id-mapping.md docs/roadmap.md; git commit -m "docs(identity): correct manifest duality, links example, tmdb-verified"`

**Exit gate:** all three corrections present; diff is docs-only (`git diff --stat -- src/ test/` empty for this task).
**Reviewer handoff:** before/after quotes for each correction with source line refs.
**Closes roadmap gate:** none (editorial; records gates closed by code tasks).

---

### Task 13: Whole-branch review + live verification

No new feature code. Single live run, then final gate audit.

**Files:** none (verification only; fix-ups if found go through the owning task's shape, one at a time).

**Non-goal:** no new scope; no streaming/tracking/Trakt; no weakening of gate 2 to three legs.

- [ ] **Step 1: Confirm default suite stays offline** — `npm test` with no `ANICATA_LIVE`, plus `unshare -n -- npm test`; record 307+ (new tests added) passed, typecheck exit 0, lint exit 0.
- [ ] **Step 2: Run the live suite ONCE** — `ANICATA_LIVE=1 npx vitest run test/live/identity.live.test.ts` (One Piece four legs, Bebop, `mal:21`/`kitsu:12`/`tmdb:37854`/`tt0388629`, unknown + bare with spies). Record observed results; do not run twice (rate limits).
- [ ] **Step 3: Audit every roadmap Phase 3 gate 1:1** — gate → evidence (CI log bytes, agreement test, inbound tests, spy outputs, benchmark, adversarial tests). Any gap reopens the owning task; do not tick unproven gates.
- [ ] **Step 4: Audit lint boundaries** — `grep -rn 'sources/' src/identity/` empty; `npm run lint` exit 0; `git diff <base>..HEAD -- package.json` empty.
- [ ] **Step 5: Record results in `docs/roadmap.md`** if not already done in Task 12.

**Exit gate:** all 7 roadmap Phase 3 gates ticked with cited evidence, or explicitly left unticked with reason.
**Reviewer handoff:** gate-evidence table + live-run log + boundary-audit output.
**Closes roadmap gate:** all (audit).
