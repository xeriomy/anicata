# Phase 2 Implementation Plan — Source abstraction and fallback

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When AniList fails, users still get catalogue and metadata from Kitsu, inside Nuvio's 5-second budget, with no path that returns a non-200.

**Architecture:** Phase 1's `AnimeSource` port leaks AniList — it takes an `AniListPageQuery` whose `sort: string[]` is AniList's `MediaSort` enum, and `CatalogService` does AniList-specific page stitching against `ANILIST_PER_PAGE`. Task 1 replaces that with a source-agnostic port taking `{ catalogId, skip, limit }`, and moves page math into each adapter. Tasks 2–3 add the Kitsu adapter and prove both adapters satisfy one contract suite. Task 4 adds the circuit breaker. Task 5 adds `SourceChain`, which owns source selection, the shared 4000 ms deadline, and the fallback-eligibility rule. Tasks 6–7 add the deadline and the chain itself. Tasks 8–10 migrate caching to source-namespaced keys with a sticky source, implement Kitsu meta resolution (Phase 1 returns `"Unavailable"` for `kitsu:` ids), and rewire the composition root.

**Tech Stack:** TypeScript 5.x (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node 22, Vitest, ESLint 9 flat config, `stremio-addon-sdk` + `@types/stremio-addon-sdk@1.6.12`. No new runtime dependencies — Kitsu is called through the existing `HttpClient`.

**Spec:** `docs/superpowers/specs/2026-10-07-phase-2-source-fallback-design.md`

## Global Constraints

- No `any` in `src/`. No new runtime dependency — verify `git diff <base>..HEAD -- package.json` is empty on every task.
- `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true` are on. **Omit** optional keys; never assign `undefined`.
- **Test fixtures are real API captures only.** Recorded live 2026-10-07. Never hand-write a response body.
- Tests are offline by default. Network calls go in `test/live/` behind `ANICATA_LIVE=1`.
- Every task leaves `npm run typecheck && npm run lint && npm test` green. Report `tsc`'s **exit code**, not just absent output.
- Layer boundaries, enforced by `eslint.config.js`: `src/domain/**` imports nothing; `src/sources/**` adapters never import each other; `src/services/**` never imports `**/sources/*/adapter*`; `src/addon/**` imports neither `sources/*/adapter*` nor `net/**`.
- Never return a non-200. Any upstream failure yields a valid 200 body.
- Nuvio's meta budget is 5000 ms (`MetaDetailsRepository.FETCH_TIMEOUT_MS`). Our total per-request budget is **4000 ms**, leaving 1000 ms for serialization and transit.
- `src/services/**` may import `../sources/types.js` (the port) but never a concrete adapter.

## Review Focus

Five input classes the spec implies that no single task's happy path exercises. Each has a test pinned to the task that owns the code.

1. **A catalogue page requested with `skip` mid-list while the primary is down.** Expected: `limit` items from the fallback, correct offset, no duplicated or skipped titles. → Task 8
2. **The same title requested via `anilist:<id>` and `kitsu:<id>`.** Expected: both resolve, and both produce an identical `Anime` — the snapshot equality gate. → Task 3
3. **A Kitsu title with no AniList equivalent** (Kitsu-only, ADR-016). Expected: `kitsu:` meta resolves fully; `anilist:` for the same title returns `"Unavailable"`. → Task 9
4. **Two concurrent requests during a source's first failure.** Expected: the breaker counts once and no second in-flight call slips past an open breaker. → Task 4
5. **A Kitsu response containing a non-numeric `averageRating`** (it is typed `string`). Expected: the normaliser coerces or rejects without `NaN` reaching `scoreAnilist`. → Task 2

---

### Task 1: Source-agnostic port

Phase 1's port takes an AniList query type, so Kitsu cannot implement it. Fix the seam first; every later task depends on it.

**Files:**
- Create: `src/sources/types.ts`
- Modify: `src/services/catalog.service.ts:1,7-10,64-80,105`
- Modify: `src/sources/anilist/adapter.ts:58,74`
- Test: `test/source-port.test.ts`

**Interfaces:**
- Consumes: `Anime` from `src/domain/anime.js`; `SourceError` from `src/domain/errors.js`; existing `AniListSource`.
- Produces: `src/sources/types.ts` exporting

```ts
export type SourceId = 'anilist' | 'kitsu';
export type SortKey = 'trending' | 'top_rated' | 'search_match';

export interface PageRequest {
  catalogId: string;
  skip: number;      // items to skip, source-agnostic
  limit: number;     // max items wanted
  genre?: string;
}

export interface SourcePage {
  items: Anime[];
  total: number;
}

export interface AnimeSource {
  readonly id: SourceId;
  fetchPage(req: PageRequest): Promise<SourcePage>;
  search(term: string, skip: number, limit: number): Promise<SourcePage>;
  /**
   * Numeric, not string: both id namespaces are integers (AniList `21`, Kitsu
   * `1376`), and `AniListSource.fetchById` already takes a number. The namespace
   * is the chain's concern, not the adapter's.
   */
  fetchById(id: number): Promise<Anime | null>;
}
```

- [ ] **Step 1: Write the failing test** — `test/source-port.test.ts`

Assert the port is source-agnostic: `AniListSource` satisfies `AnimeSource`, `fetchPage` accepts a `PageRequest` with `skip`/`limit` (no AniList `sort`/`perPage`), and it translates `skip` to AniList's own page/offset math internally.

```ts
import { describe, it, expect } from 'vitest';
import type { AnimeSource } from '../src/sources/types.js';
import { AniListSource } from '../src/sources/anilist/adapter.js';

describe('AnimeSource port', () => {
  it('AniListSource satisfies the source-agnostic port', () => {
    const src = new AniListSource({} as never);
    const asPort: AnimeSource = src;
    expect(asPort.id).toBe('anilist');
  });

  it('fetchPage takes skip/limit, not an AniList query', async () => {
    // getJson stubbed to capture the outgoing AniList query
    // skip=60, limit=50 -> AniList page 2, perPage 50, then sliced
    // assert no `sort` leak: the caller never supplied one
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/source-port.test.ts`
Expected: FAIL — `Cannot find module '../src/sources/types.js'`

- [ ] **Step 3: Create `src/sources/types.ts`** with the five exports above, verbatim.

- [ ] **Step 4: Give `AniListSource` an `id` and a `fetchPage(req)`**

`readonly id = 'anilist' as const`. `fetchPage` maps `SortKey` → AniList sort strings internally: `trending` → `['TRENDING_DESC']`, `top_rated` → `['SCORE_DESC']`, `search_match` → `['SEARCH_MATCH']`. It keeps the existing two-request stitching (`skip % 50`, `Math.floor(skip / 50) + 1`) inside the adapter and returns at most `limit` items.

Rename the existing `search(term, page)` → `search(term, skip, limit)`; translate `skip` to AniList's page internally. **`fetchById(anilistId: number)` is left exactly as it is** — the port declares it numeric to match, so `AniListSource` satisfies `AnimeSource` with no cast and `MetaService`'s call site keeps compiling.

- [ ] **Step 5: Update `CatalogService` to the new port**

Delete `import { ANILIST_PER_PAGE }`. Replace the stitching loop with a single `this.source.fetchPage({ catalogId, skip, limit: PAGE_SIZE, genre })`. `PAGE_SIZE` (100) is Nuvio's page size and stays source-agnostic.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/source-port.test.ts test/catalog-service.test.ts test/anilist-adapter.test.ts`
Expected: PASS. The existing 34 tests must be **unmodified and still green** — if any needs editing, the port change broke a contract.

- [ ] **Step 7: Verify no AniList leak remains in services**

Run: `grep -n 'ANILIST_PER_PAGE\|AniListPageQuery' src/services/*.ts`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/sources/types.ts src/services/catalog.service.ts src/sources/anilist/adapter.ts test/source-port.test.ts
git commit -m "refactor: make the AnimeSource port source-agnostic

The port took an AniListPageQuery whose sort is AniList's MediaSort enum,
and CatalogService did AniList page stitching against ANILIST_PER_PAGE, so no
second source could implement it. The port now takes {catalogId, skip, limit}
and each adapter owns its own pagination and sort vocabulary."
```

---

### Task 2: Kitsu adapter — fetch and normalise

**Files:**
- Create: `src/sources/kitsu/types.ts`, `src/sources/kitsu/queries.ts`, `src/sources/kitsu/adapter.ts`
- Create: `test/fixtures/kitsu-page.json`, `test/fixtures/kitsu-anime-1.json`
- Test: `test/kitsu-adapter.test.ts`

**Interfaces:**
- Consumes: `AnimeSource`, `PageRequest`, `SourcePage`, `SortKey`, `SourceId` from `src/sources/types.js` (Task 1); `Anime` from `src/domain/anime.js`; `HttpClient`; `normalizeMedia`-equivalent for Kitsu's shape.
- Produces: `class KitsuSource implements AnimeSource` with `readonly id = 'kitsu' as const`, plus `export function kitsuSort(sort: SortKey): string`.

- [ ] **Step 1: Record real fixtures from the live API**

```bash
curl -s -H 'Accept: application/vnd.api+json' \
  'https://kitsu.io/api/edge/anime?sort=-averageRating&page%5Blimit%5D=3&include=genres' \
  -o test/fixtures/kitsu-page.json
curl -s -H 'Accept: application/vnd.api+json' \
  'https://kitsu.io/api/edge/anime/1?include=genres' \
  -o test/fixtures/kitsu-anime-1.json
```

Both are 200 with real bodies (verified 2026-10-07). Commit them verbatim, envelope included. Record the capture date in a sibling `test/fixtures/README-kitsu.md`.

- [ ] **Step 2: Write the failing test** — `test/kitsu-adapter.test.ts`

Cover: `id === 'kitsu'`; `kitsuSort('top_rated') === '-averageRating'`; `kitsuSort('trending') === '-userCount'` (the documented proxy, **not** a real trending sort); the JSON:API envelope is unwrapped from `data`; genres are read from `included` (not from the record); `averageRating` arrives as the **string** `"82.27"` and becomes the number `82.27`, never `NaN`.

```ts
it('coerces the string averageRating Kitsu sends', () => {
  // fixture has attributes.averageRating === "82.27"
  // assert anime.scoreAnilist === 82.27 and Number.isNaN(...) === false
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/kitsu-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/sources/kitsu/types.ts`**

`KitsuListResponse { data: KitsuAnime[]; included?: KitsuIncluded[]; meta?: { totalCount?: number } }`. `KitsuAnime { id: string; type: 'anime'; attributes: {...} }`. Genre entries in `included` have `type: 'genres'`.

- [ ] **Step 5: Implement `src/sources/kitsu/adapter.ts`**

`fetchPage(req)` maps `SortKey` via `kitsuSort`, converts `skip`/`limit` to Kitsu's `page[offset]`/`page[limit]`, requests `include=genres`, and normalises each record into `Anime`. Genres are joined by matching `relationships.genres.data[].id` against `included` where `type === 'genres'`. `fetchById(id)` returns `null` for a 404 — **never a throw**. `search(term, skip, limit)` uses `?filter[text]=`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/kitsu-adapter.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sources/kitsu/ test/kitsu-adapter.test.ts test/fixtures/kitsu-*.json test/fixtures/README-kitsu.md
git commit -m "feat: Kitsu adapter with real captured fixtures

Kitsu is the sole fallback; Jikan's public API was discontinued 2026-10-01.
Trending maps to sort=-userCount (most-favorited) because Kitsu rejects
trending, recently_popular, relevance, title and favorites with HTTP 400.
averageRating arrives as a string and is coerced."
```

---

### Task 3: Shared contract suite

Proves the two adapters are interchangeable — the gate that makes fallback safe.

**Files:**
- Create: `test/helpers/source-contract.ts`, `test/source-contract.test.ts`
- Test: `test/source-contract.test.ts`

**Interfaces:**
- Consumes: `AnimeSource`, `PageRequest` from `src/sources/types.js`; `AniListSource`; `KitsuSource`.
- Produces: `export function describeSourceContract(name: string, make: () => AnimeSource, fixtures: ContractFixtures): void`

- [ ] **Step 1: Write the contract helper** with one `describe` per adapter, each running the same cases:

`fetchById` returns a populated `Anime` for a known id · returns `null` for an unknown id rather than throwing · `fetchPage` returns at most `limit` items and honours `skip` · `search` finds a known title and returns an empty page for nonsense · every required `Anime` field is present and non-blank · an unreachable host yields a `network` `SourceError`, not an unhandled rejection.

- [ ] **Step 2: Add the snapshot equality test**

For One Piece — present in both sources (`anilist:1` / `kitsu:1`) — normalise through both adapters and assert the `Anime` objects match on `title`, `format`, `status`, `genres` (as sets), `releaseDate`, and `countryOfOrigin`. Any divergence is a normalisation bug in one adapter; the snapshot is what catches it.

- [ ] **Step 3: Run to verify it passes for both adapters**

Run: `npx vitest run test/source-contract.test.ts`
Expected: PASS for both. If snapshot equality fails, fix the **normaliser**, not the assertion — unless the fixture genuinely differs, in which case report it rather than widening the comparison.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/source-contract.ts test/source-contract.test.ts
git commit -m "test: one contract suite both adapters must satisfy

Includes snapshot equality for a title present in both sources, so a
normalisation divergence between them fails the build rather than silently
producing a worse fallback page."
```

---

### Task 4: Circuit breaker

**Files:**
- Create: `src/net/breaker.ts`, `test/breaker.test.ts`

**Interfaces:**
- Consumes: `now: () => number` injected for deterministic time.
- Produces:

```ts
export interface BreakerOptions {
  failureThreshold: number;   // default 5
  cooldownMs: number;         // default 30_000
  now?: () => number;
}
export type BreakerState = 'closed' | 'open' | 'half_open';
export class CircuitBreaker {
  constructor(opts?: BreakerOptions);
  get state(): BreakerState;
  canAttempt(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}
```

- [ ] **Step 1: Write the failing test** — closed → open after 5 failures; `canAttempt()` false while open; after `cooldownMs` the state is `half_open` and one attempt is allowed; success closes it; failure in `half_open` reopens it; **`not_found` and `rate_limited` are not failures** (the caller classifies, so the test drives `recordSuccess` for those).

- [ ] **Step 2: Run to verify it fails** → FAIL, module not found.

- [ ] **Step 3: Implement** the three-state machine. `now` defaults to `Date.now`. All time comparisons use the injected `now` — never `Date.now()` directly, so tests need no fake timers.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/breaker.ts test/breaker.test.ts
git commit -m "feat: per-source circuit breaker

A source failing repeatedly is skipped without a network call, so a dead
primary costs no latency. Matters more now that the chain has one fallback
rather than two: without this, every request would pay a doomed AniList
timeout first."
```

---

### Task 5: Deadline

**Files:**
- Create: `src/net/deadline.ts`, `test/deadline.test.ts`

**Interfaces:**
- Consumes: injected `now`.
- Produces:

```ts
export class Deadline {
  constructor(budgetMs: number, now?: () => number);
  get remainingMs(): number;
  get expired(): boolean;
  /** Resolves `fn`'s result, or rejects with a `timeout` SourceError at the deadline. */
  run<T>(fn: (remainingMs: number) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 1: Write the failing test** — `remainingMs` counts down from `budgetMs`; `run` rejects with a `timeout` `SourceError` when `fn` outlives the budget; `run` resolves normally when it does not; **`run` passes the remaining budget to `fn`** so a source never receives a fresh full budget.

- [ ] **Step 2: Run to verify it fails** → FAIL, module not found.

- [ ] **Step 3: Implement** using `Promise.race` against a timer built from the injected `now`. Clear the timer on settle so a resolved promise does not hold the event loop — otherwise vitest hangs.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/deadline.ts test/deadline.test.ts
git commit -m "feat: shared wall-clock deadline

Nuvio allows 5000ms for meta; our per-source timeout caps at 4000ms, so naive
sequential fallback could take 8000ms and make Nuvio skip the add-on. One
4000ms deadline per request, and each source receives only the remainder."
```

---

### Task 6: Fallback eligibility

**Files:**
- Create: `src/sources/fallback-policy.ts`, `test/fallback-policy.test.ts`

**Interfaces:**
- Consumes: `SourceError` from `src/domain/errors.js`.
- Produces: `export function permitsFallback(kind: SourceErrorKind): boolean`

- [ ] **Step 1: Write the failing test** — pins the spec's table exactly:

| kind | permitsFallback |
|---|---|
| `server_error` | `true` |
| `timeout` | `true` |
| `network` | `true` |
| `parse` | `true` |
| `rate_limited` | **`false`** — our budget is spent; another source cannot help |
| `not_found` | **`false`** — a genuinely absent title is a valid answer |
| `invalid_request` | **`false`** — our bug, not the source's |

- [ ] **Step 2: Run to verify it fails** → FAIL, module not found.

- [ ] **Step 3: Implement** as a frozen `Set` membership test.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/fallback-policy.ts test/fallback-policy.test.ts
git commit -m "feat: fallback eligibility policy

Only transient failures fall back. 429 must not: another source cannot fix
our own rate limit, and calling it wastes the shared deadline. 404 must not:
falling back would resurrect titles that do not exist and fire a pointless
upstream call for every miss."
```

---

### Task 7: SourceChain

The centrepiece — source selection, deadline, eligibility, breaker, and stickiness in one place.

**Files:**
- Create: `src/sources/chain.ts`, `test/chain.test.ts`

**Interfaces:**
- Consumes: `AnimeSource`, `PageRequest`, `SourcePage`, `SourceId`; `CircuitBreaker`; `Deadline`; `permitsFallback`.
- Produces:

```ts
export interface ChainDeps {
  sources: AnimeSource[];             // ordered; index 0 is primary
  breakers: Map<SourceId, CircuitBreaker>;
  budgetMs?: number;                  // default 4000
  now?: () => number;
  stickyTtlMs?: number;               // default 600_000
}
export interface ChainResult {
  items: Anime[];
  total: number;
  sourceId: SourceId;
  fromFallback: boolean;
}
export class SourceChain {
  constructor(deps: ChainDeps);
  fetchPage(catalogId: string, req: PageRequest, stickyKey?: string): Promise<ChainResult>;
  /**
   * Takes a FULL namespaced id (`'anilist:21'`, `'kitsu:1376'`) because the chain
   * must route on the namespace before it knows which source to ask. It parses
   * the namespace, then calls that source's `fetchById(id: number)`. The string
   * here and the number on the port are not a contradiction — they are two
   * different layers.
   */
  fetchById(id: string): Promise<{ anime: Anime | null; sourceId: SourceId }>;
  peekSticky(stickyKey: string): SourceId | undefined;
}
```

- [ ] **Step 1: Write the failing test** — one case per spec scenario, all with injected fakes:

primary healthy → `fromFallback: false`, zero fallback calls · primary 5xx → fallback serves, `fromFallback: true` · primary 429 → **stale or empty, fallback spy shows 0 calls** · primary 404 → **0 fallback calls** · primary returns empty → **0 fallback calls** · open breaker on the primary → **zero network calls to the primary** · both fail → throws a `SourceError` the caller converts to stale/empty, never a raw rejection · **a slow primary cannot push the total past `budgetMs`** (assert elapsed with the injected clock) · a sticky key returns the same source for a second call within `stickyTtlMs`, and a different catalogue has its own stickiness.

- [ ] **Step 2: Run to verify it fails** → FAIL, module not found.

- [ ] **Step 3: Implement** — for each capability: honour the sticky source if set and its breaker is closed; otherwise walk `sources` in order, skipping any whose breaker is open, wrapping each call in `deadline.run` so it receives only `remainingMs`; on throw, classify via `permitsFallback`, record the outcome on that source's breaker, and continue only when permitted; rethrow the last error if every source is exhausted.

Stickiness is an in-process `Map<string, { sourceId, expiresAt }>`, pruned on read.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/chain.ts test/chain.test.ts
git commit -m "feat: SourceChain — source selection, deadline, eligibility, stickiness

One place decides which source answers, whether the deadline allows a second
attempt, and whether a failure permits one at all."
```

---

### Task 8: Source-namespaced cache keys

**Files:**
- Modify: `src/services/catalog.service.ts:59,84,106,109`
- Test: `test/catalog-cache-keys.test.ts`

**Interfaces:**
- Consumes: `ChainResult.sourceId` from `SourceChain`.
- Produces: `export function catalogCacheKey(sourceId: SourceId, catalogId: string, genre: string | undefined, skip: number): string` and `export function searchCacheKey(sourceId: SourceId, term: string, skip: number): string`, both producing the shape `catalog:<sourceId>:<catalogId>:<genre>:<skip>` / `search:<sourceId>:<term>:<skip>`.

- [ ] **Step 1: Write the failing test** — a Kitsu-sourced page and an AniList-sourced page at the same `(catalogId, skip)` occupy **different** keys; the same source is stable across calls; a genre and a different `skip` still separate; `search` keys are namespaced too.

- [ ] **Step 2: Run to verify it fails** — the current key is `catalog:${catalogId}:${genre}:${skip}`, so the two sources collide. Expect FAIL.

- [ ] **Step 3: Implement** the two key builders and route both call sites through them.

- [ ] **Step 4: Prove the collision is real, not theoretical** — before the fix, assert that a Kitsu page overwrites an AniList page at the same key. If it does not, the key function is not the only thing that changed and the test is not proving what it claims.

- [ ] **Step 5: Run to verify it passes** → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/catalog.service.ts test/catalog-cache-keys.test.ts
git commit -m "fix: namespace catalogue cache keys by source

Today's key omits the source, so a cached AniList page and a fresh Kitsu page
merge seamlessly into one scrolling catalogue. Two sources now cannot collide."
```

---

### Task 9: Kitsu meta resolution

Phase 1 returns `"Unavailable"` for `kitsu:` ids on purpose. Without this, a fallback catalogue lists titles whose details pages are empty.

**Files:**
- Modify: `src/addon/meta.ts`, `src/services/meta.service.ts:20,26,47`
- Test: `test/meta-kitsu.test.ts`

**Interfaces:**
- Consumes: `parseMetaId` (existing) returning `{ namespace, value }`; `SourceChain.fetchById`.
- Produces: `MetaService` gains `source: AnimeSource`-shaped `fetchById(id: string)`, routing `anilist:<id>` and `kitsu:<id>` to the chain.

- [ ] **Step 1: Write the failing test** — `kitsu:1` resolves a full `Anime` via Kitsu and makes **zero AniList calls**; `anilist:1` makes **zero Kitsu calls**; an unknown `kitsu:` id returns `null` and not a throw; the minimal `"Unavailable"` shape still carries non-blank `id`, `type`, `name` for both namespaces; a bare numeric id is still rejected (it is a Trakt id).

- [ ] **Step 2: Run to verify it fails** → `kitsu:` currently returns `"Unavailable"` with no service call.

- [ ] **Step 3: Implement** — `parseMetaId` is unchanged. `MetaService` takes `fetchById(id: string)` and dispatches on the namespace; the chain routes to the matching source. **Preserve Phase 1's no-throw guarantee:** every failure path still returns a complete meta object.

- [ ] **Step 4: Run to verify it passes**, and confirm `test/handlers.test.ts` is **unmodified and green** — it pins the Phase 1 contract this task must not regress.

- [ ] **Step 5: Commit**

```bash
git add src/addon/meta.ts src/services/meta.service.ts test/meta-kitsu.test.ts
git commit -m "feat: resolve kitsu: meta ids

Phase 1 declared kitsu: in idPrefixes but deliberately returned Unavailable,
because a fallback catalogue would otherwise list titles with empty detail
pages. Routes by namespace; zero cross-source calls."
```

---

### Task 10: Composition root and integration

**Files:**
- Modify: `src/index.ts:77-117`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `KitsuSource`, `SourceChain`, `CircuitBreaker`, `loadAppConfig`.
- Produces: `createApp(overrides?: Partial<AppDeps>)` unchanged in shape; `AppDeps` gains an optional `chain` for injection.

- [ ] **Step 1: Write the failing test** — the existing suite plus: the app boots with both sources wired; a primary that always throws still yields **200** on every catalogue, search and meta path (the Phase 1 invariant, now under fallback); `/manifest.json` is unchanged and still ≤ 8192 bytes; **every response still arrives inside 4000 ms** when the primary hangs.

- [ ] **Step 2: Run to verify it fails** → the new cases fail; the old ones pass.

- [ ] **Step 3: Wire it** — construct `KitsuSource`, one `CircuitBreaker` per `SourceId`, and `SourceChain([anilist, kitsu], breakers)`, then pass the chain where services previously took a bare source. `budgetMs` comes from `httpTimeoutMs` so the existing config clamp keeps protecting Nuvio's budget.

- [ ] **Step 4: Run the whole suite offline** — `unshare -n -- npm test` must pass, proving the added fallback path introduces no network dependency.

- [ ] **Step 5: Extend the live suite** — `test/live/kitsu.live.test.ts`, skipped unless `ANICATA_LIVE=1`: Kitsu reachable, `sort=-userCount` returns items, `filter[text]=` search returns results.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/integration.test.ts test/live/kitsu.live.test.ts
git commit -m "feat: wire Kitsu fallback into the composition root

budgetMs derives from httpTimeoutMs, so the existing 4000ms clamp keeps
protecting Nuvio's 5s meta budget."
```

---

### Task 11: Docs and live verification

**Files:**
- Modify: `README.md`, `docs/roadmap.md`

**Interfaces:**
- Consumes: nothing — documentation and verification only, no code change.
- Produces: no new exports. Removes the README's "No Kitsu code yet" limitation and records the trending-proxy caveat.

- [ ] **Step 1: Update the README** — the fallback chain is AniList → Kitsu; Jikan is gone (discontinued 2026-10-01); Trending degrades to most-favorited during an AniList outage and that is a deliberate approximation; `kitsu:` ids now resolve. Remove the "No Kitsu code yet" limitation.

- [ ] **Step 2: Run the live suite once** and record the observed results. AniList allows 30 req/min — the live tests make roughly 8 requests total. Do not run it twice.

- [ ] **Step 3: Confirm the default suite stays offline** — `npm test` with no `ANICATA_LIVE`, plus `unshare -n -- npm test`.

- [ ] **Step 4: Tick the roadmap exit gates that are now proven**, and leave the ones that are not.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/roadmap.md
git commit -m "docs: Phase 2 fallback documented and live-verified"
```
