# Phase 1 — Minimal AniList Add-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable Stremio add-on that serves a manifest, two AniList-backed
catalogues with correct `skip` pagination, and one search catalogue, plus a `meta`
endpoint — good enough to install into real Nuvio and browse anime.

**Architecture:** A single Node process. `addon/` owns the Stremio protocol shapes
via `stremio-addon-sdk`; `services/` orchestrates; `sources/anilist/` is the only
data adapter and translates AniList GraphQL responses **into** our own
`domain/anime.ts` types; `render/` converts our domain into Stremio JSON; `cache/`
is a TTL + stale-while-revalidate + single-flight store; `net/` owns fetch,
timeouts and the rate limiter. No framework, no database.

**Tech Stack:** TypeScript 5 · Node.js 22 · `stremio-addon-sdk` 1.6.10 ·
Vitest 3 · ESLint 9 (flat config) · Prettier 3 · Node 22 native `fetch` (no HTTP client dep)

**Spec:** [`docs/architecture.md`](../../architecture.md) ·
[`docs/nuvio-compatibility.md`](../../nuvio-compatibility.md) ·
[`docs/catalog-design.md`](../../catalog-design.md) ·
[`docs/id-mapping.md`](../../id-mapping.md) ·
[`docs/sdk-reference.md`](../../sdk-reference.md) ·
[`docs/data-sources.md`](../../data-sources.md) ·
[`docs/decisions.md`](../../decisions.md)

This is **Phase 1 only** of the roadmap in [`docs/roadmap.md`](../../roadmap.md).
Kitsu, Jikan, TMDB, AniZip, the identity bundle, genre catalogues and `videos[]`
are Phase 2–5 and are explicitly **out of scope here**.

---

## Global Constraints

These apply to every task. Values are copied verbatim from the spec.

**Protocol**
- Canonical id is `anilist:<anilistId>`. Never emit an unprefixed id — Nuvio reads bare numbers as **Trakt** ids.
- `meta` resource MUST be the object form with `idPrefixes: ["anilist:", "kitsu:"]` and `types: ["anime", "movie"]`. Empty `idPrefixes` makes us a catch-all for every other add-on's content.
- Every catalogue `extra` entry MUST omit `isRequired`. Any `isRequired: true` silently deletes that catalogue from Nuvio's Home screen.
- Every response is HTTP 200 with a valid Stremio body. **There is no code path from an upstream failure to a non-200.**
- Catalogue pages return **exactly 100 items** when available; `metas: []` terminates pagination.
- Every emitted `metas[]` item has non-blank `id`, `type`, `name`.
- Meta must emit **both** `country` and `countryOfOrigin`, and **both** `language` and `audioLanguage`.

**Content types**
- Episodic content uses `type: "anime"`. `format == "MOVIE"` uses `type: "movie"`.
- `isAdult: false` is hard-coded in every AniList query. Not configurable in Phase 1.

**AniList (all verified live 2026-10-04 — see `docs/data-sources.md` §1.5)**
- `Page.media`'s `sort` argument is `[MediaSort]` — a **list**. A single value returns HTTP 400.
- `perPage` is **silently clamped to 50**. One Nuvio page of 100 = **2** AniList requests.
- Only one search argument exists: `search`. There is no `search_as_broad`, no `searchByAlias`.
- `MediaTag.category` is a **String**. `MediaTag` has `isMediaSpoiler`, **not** `isSpoiler`; `isMediaRelevant` does not exist.
- `studios.edges` are `StudioEdge` → field is `isMain`. Only `relations.edges` uses `MediaEdge`.
- Use `coverImage.extraLarge` for posters. `coverImage.large` is a medium-sized URL and `medium` is small; the names lie. `color` is a hex string.
- `duration` is an `Int` in minutes. `averageScore` is an `Int` 0–100. `nextAiringEpisode` may be `null`.
- `Page.media` `pageInfo.total` is capped at 5000 — never treat it as the true total.
- `Media(id:)` for a nonexistent id returns HTTP 200 with **both** an `errors` array
  (`status: 404`, message `"Not Found."`) **and** `data.Media: null` — verified live.
  Discriminate on `data.Media`, never on `errors` alone: a malformed query instead returns
  `data: null` with `status: 400` and no `Media` key.
- Rate limit is **30 req/min** (`x-ratelimit-limit: 30`). Client limiter defaults to 25/min.

**Nuvio (all verified from client source)**
- Meta request budget is **5 s** (`FETCH_TIMEOUT_MS`). Catalogue must be faster.
- Nuvio honours `Cache-Control` via a 50 MB OkHttp disk cache — this is the single cheapest performance lever.
- Nuvio advances `skip` by `metas.length` **as received**, and stops after 3 consecutive pages containing no new ids. A given `skip` must therefore always return the same items for the cache TTL.
- `banner` is Nuvio's preferred wide-art field, taking precedence over `background`.
- `imdbRating` is read as a **string**.
- `links[]` entries need all three of `name`, `category`, `url`.

**Engineering**
- `domain/` imports nothing. Adapters never import each other. `services/` never imports an adapter directly.
- No `any` in `src/`. Unknown upstream payloads are typed interfaces with optional fields, not `any`.
- Node 22 native `fetch` only. No `node-fetch`, no axios, no HTTP client dependency.
- Tests use recorded fixtures; no network calls in `npm test`. Live checks live behind `npm run test:live`.
- Log one JSON line per request to stdout. Never log secrets (Phase 1 has none).

---

## Review Focus

Five input classes or failure modes the spec implies that a naive implementation
would get wrong. Each has a test pinned to the task that owns the code.

1. **`skip` past the end, or a short upstream page.** A reasonable person expects pagination to stop cleanly. Naive code loops forever or returns duplicates, and Nuvio kills the row after 3 duplicate pages. → Task 8
2. **AniList returning `{"data":{"Media":null}}` with HTTP 200** for an unknown id. Naive code checks `resp.ok` and treats this as success, rendering a meta with `name: null`. → Task 7 (adapter) and Task 9 (service)
3. **`pageInfo.total` capped at 5000.** Code that computes page count from `total / perPage` will offer ~100 pages for every catalogue and silently truncate. → Task 8 (the service must never derive pages from `total`)
4. **Concurrent identical requests to the same uncached key.** Without single-flight, a cold cache under Nuvio's parallel Home-row fetch issues N identical AniList requests and burns the 30/min budget instantly. → Task 4
5. **Title with all three AniList titles null-ish / whitespace-only.** Naive `title.english ?? title.romaji` yields `undefined`, and Nuvio **silently drops** any item with a blank `name`. → Task 5 (`resolveDisplayTitle`) and Task 6 (`normalizeMedia`)

---

## File Structure

```
anicata/
├── package.json                  npm scripts, deps
├── tsconfig.json                 strict, NodeNext
├── vitest.config.ts
├── eslint.config.js              layer boundary rules added in Task 5
├── .prettierrc.json
├── .gitignore
├── .env.example
├── README.md
├── docs/                         (already written by the research phase)
├── public/logo.png               1×1 transparent PNG placeholder (Task 1), served by Task 15
│
├── test/
│   ├── fixtures/
│   │   ├── catalog-trending.json    recorded AniList Page response (Task 2)
│   │   ├── catalog-search.json      recorded AniList search response (Task 2)
│   │   ├── meta-21.json             recorded AniList Media(id:21) response (Task 2)
│   │   └── meta-null.json          recorded 404 errors[] + Media:null (Task 2)
│   ├── helpers/serve.ts            boot the HTTP server on an ephemeral port
│   ├── manifest.test.ts
│   ├── cache.test.ts
│   ├── http.test.ts
│   ├── limiter.test.ts
│   ├── anilist-adapter.test.ts
│   ├── catalog-service.test.ts
│   ├── meta-service.test.ts
│   └── handlers.test.ts
│
└── src/
    ├── index.ts                 composition root: build source → services → addon → serveHTTP
    │
    ├── domain/                  no imports
    │   ├── anime.ts             Anime, AnimeIdentity, Title, Images, Tag, Studio, Relation
    │   └── errors.ts            SourceError taxonomy
    │
    ├── config/index.ts          env parsing + request config (titleLang)
    │
    ├── util/logger.ts           JSON line logger
    │
    ├── cache/store.ts           TTLCache: get/set/wrap, stale window, single-flight
    │
    ├── net/
    │   ├── http.ts              getJson: timeout, User-Agent, header capture
    │   └── limiter.ts           TokenBucket
    │
    ├── sources/
    │   ├── anilist/
    │   │   ├── queries.ts       GraphQL documents (verified in research)
    │   │   ├── types.ts         AniList response interfaces
    │   │   └── adapter.ts       AniListSource: fetchCatalogPage / search / fetchById
    │   └── catalog-def.ts       catalog id → AniList query translation
    │
    ├── normalize/
    │   ├── text.ts              stripHtml, stripAttribution, collapse, truncate
    │   └── anime.ts             AniListMedia → Anime
    │
    ├── render/
    │   ├── types.ts             StremioMetaPreview, StremioMetaDetail (extended)
    │   ├── preview.ts           Anime → StremioMetaPreview
    │   └── detail.ts            Anime → StremioMetaDetail
    │
    ├── services/
    │   ├── catalog.service.ts   catalogue page + search orchestration, paging
    │   └── meta.service.ts      meta orchestration
    │
    └── addon/
        ├── manifest.ts          buildManifest()
        ├── catalog.ts           defineCatalogHandler + extras parsing
        └── meta.ts              defineMetaHandler + id parsing
```

Task order follows the dependency chain. Each task ends with a green suite and a commit.

---

### Task 1: Project scaffold and build pipeline

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `.env.example`, `public/logo.png`, `src/util/logger.ts`, `test/logger.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `logger.info(msg: string, fields?: Record<string, unknown>): void`
  - `logger.error(msg: string, fields?: Record<string, unknown>): void`
  - npm scripts: `build`, `dev`, `start`, `test`, `test:watch`, `test:live`, `lint`, `typecheck`, `format`
  - A passing `npm test` and `npm run build` that later tasks depend on.

- [ ] **Step 1: Initialise git and install dependencies**

```bash
cd /root/anicata
git init
npm init -y
npm pkg set name="anicata" version="0.1.0" private=true type="module" engines.node=">=22"
npm i stremio-addon-sdk@1.6.10
npm i -D typescript@5 vitest@3 @vitest/coverage-v8@3 supertest@7 \
         @types/node@22 @types/supertest@6 eslint@9 @eslint/js typescript-eslint@8 prettier@3
```

If `stremio-addon-sdk@1.6.10` fails to resolve, install without the pin and record
the resolved version in `package.json` — do not vendor the package.

- [ ] **Step 2: Write the failing logger test**

`test/logger.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../src/util/logger.js';

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line to stdout with level, message and fields', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    createLogger('info').info('catalog.page', { items: 100, skip: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(write.mock.calls[0]![0]));
    expect(line).toMatchObject({ level: 'info', msg: 'catalog.page', items: 100, skip: 0 });
    expect(line.ts).toBeTypeOf('number');
  });

  it('serialises an Error without throwing', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(() => createLogger('info').info('boom', { err: new Error('nope') })).not.toThrow();
    expect(String(write.mock.calls[0]![0])).toContain('nope');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/logger.test.ts`
Expected: FAIL — `Cannot find module '../src/util/logger.js'`

- [ ] **Step 4: Implement the logger**

`src/util/logger.ts` — signature fixed by the test:

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
export function createLogger(minLevel: LogLevel = 'info'): Logger
```

`Error` values in `fields` become `{ name, message, stack }` via a `JSON.stringify`
replacer. A `LEVELS: Record<LogLevel, number>` map gates output. No colours, no
timestamps other than `ts: Date.now()`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/logger.test.ts` → Expected: 2 passed

- [ ] **Step 6: Add config files**

`tsconfig.json` — `"strict": true`, `"target": "ES2023"`, `"module": "NodeNext"`,
`"moduleResolution": "NodeNext"`, `"outDir": "dist"`, `"rootDir": "src"`,
`"declaration": false`, `"noUncheckedIndexedAccess": true`,
`"exactOptionalPropertyTypes": true`, `"verbatimModuleSyntax": true`,
`"skipLibCheck": true`.

Note `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are deliberate:
they are what force explicit handling of AniList's many nullable fields.

`vitest.config.ts` — `test: { environment: 'node', include: ['test/**/*.test.ts'] }`.

`eslint.config.js` — flat config from `@eslint/js` + `typescript-eslint`
recommended. Layer boundary rules are added in Task 5, which owns the boundary.

`.prettierrc.json` — `{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }`.

`.gitignore` — `node_modules/`, `dist/`, `coverage/`, `.env`, `*.log`.

`.env.example`:
```
PORT=7000
LOG_LEVEL=info
ANILIST_RATE_LIMIT=25
HTTP_TIMEOUT_MS=3500
CACHE_MAX_ENTRIES=10000
```

`public/logo.png` — a 1×1 transparent PNG (base64 of the standard 1×1 transparent
GIF is not acceptable; write a minimal valid PNG via `Buffer.from('<hex>','hex')`).

npm scripts in `package.json`:
`build`: `tsc -p tsconfig.json` · `dev`: `tsc -w` · `start`: `node dist/index.js` ·
`test`: `vitest run` · `test:watch`: `vitest` · `test:live`: `vitest run --dir test/live` ·
`lint`: `eslint src test` · `typecheck`: `tsc --noEmit` · `format`: `prettier --write .`

- [ ] **Step 7: Verify the build pipeline end to end**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: all four succeed; `dist/util/logger.js` exists.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with vitest, eslint, prettier"
```

---

### Task 2: AniList recorded fixtures and typed responses

**Files:**
- Create: `test/fixtures/catalog-trending.json`, `test/fixtures/catalog-search.json`, `test/fixtures/meta-21.json`, `test/fixtures/meta-null.json`
- Create: `src/sources/anilist/types.ts`, `src/sources/anilist/queries.ts`
- Create: `test/anilist-types.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 except the test runner
- Produces (used by Tasks 5, 6, 7, 8, 9):
  - `src/sources/anilist/queries.ts`:
    - `CATALOG_QUERY: string`
    - `SEARCH_QUERY: string`
    - `META_QUERY: string`
  - `src/sources/anilist/types.ts`:
    - `AniListTitle { romaji: string | null; english: string | null; native: string | null }`
    - `AniListCover { extraLarge: string | null; large: string | null; medium: string | null; color: string | null }`
    - `AniListFuzzyDate { year: number | null; month: number | null; day: number | null }`
    - `AniListNextEpisode { episode: number; airingAt: number; timeUntilAiring: number }`
    - `AniListTag { id: number; name: string; rank: number; category: string | null; isMediaSpoiler: boolean | null; isAdult: boolean | null }`
    - `AniListStudioEdge { isMain: boolean; node: { id: number; name: string } }`
    - `AniListRelationEdge { relationType: string; node: { id: number; type: string; title: AniListTitle; format: string | null; status: string | null } }`
    - `AniListMedia` — every field §1.5.4 returns, all nullable except `id`
    - `AniListPage<T> { pageInfo: { total: number; currentPage: number; lastPage: number; hasNextPage: boolean; perPage: number }; media: T[] }`
    - `AniListGraphQLResponse<T> { data?: T | null; errors?: Array<{ message: string; status: number }> }`

- [ ] **Step 1: Record the fixtures from the live API**

Create a throwaway script (not committed) and run it. Rate-limit yourself: AniList
is 30 req/min, so sleep between calls.

```bash
mkdir -p test/fixtures
UA='User-Agent: anicata-anime-addon/0.1 (+https://github.com/nuvio-anime-addon)'
CATALOG='query($perPage:Int,$page:Int,$sort:[MediaSort]){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(sort:$sort,type:ANIME,isAdult:false){id idMal title{romaji english native} format status episodes duration averageScore popularity coverImage{extraLarge large medium color} bannerImage genres season seasonYear startDate{year month day} isAdult nextAiringEpisode{episode airingAt timeUntilAiring}}}}'
META='query($id:Int){Media(id:$id){id idMal title{romaji english native} synonyms description(asHtml:false) format status episodes duration averageScore meanScore popularity favourites isAdult source countryOfOrigin hashtag startDate{year month day} endDate{year month day} season seasonYear coverImage{extraLarge large medium color} bannerImage genres tags{id name rank category isMediaSpoiler isAdult} studios{edges{isMain node{id name}}} relations{edges{relationType node{id type title{romaji english} format status}}} nextAiringEpisode{episode airingAt timeUntilAiring} siteUrl}}'
```

Post `CATALOG` with variables `{"perPage":50,"page":1,"sort":["TRENDING_DESC"]}` →
`test/fixtures/catalog-trending.json`.
Post `CATALOG` with variables `{"perPage":50,"page":2,"sort":["TRENDING_DESC"]}` →
append as `catalog-trending-p2.json` (needed to prove `skip=100` differs).
Post `SEARCH_QUERY` with `{"search":"cowboy bebop","perPage":50,"page":1,"sort":["SEARCH_MATCH"]}` →
`test/fixtures/catalog-search.json`.
Post `META` with `{"id":21}` → `test/fixtures/meta-21.json` (One Piece).
Post `META` with `{"id":99999999}` → `test/fixtures/meta-null.json`.
**Verified live shape** (this is what AniList actually returns — keep the real bytes):
```json
{"errors":[{"message":"Not Found.","status":404,"locations":[{"line":1,"column":16}]}],"data":{"Media":null}}
```
It carries BOTH an `errors` array and `data.Media: null`. That combination is the
fixture that pins Review Focus #2.

Also record one **live edge case** for later: an id whose `title.english`,
`title.romaji` and `title.native` are all null, if you can find one by scanning a
catalogue page. If none exists in the first page, skip it and note that
Review Focus #5 is covered by a synthetic fixture in Task 6 instead.

Trim each fixture to a small size (5–10 media entries) with `json.dumps`, keeping
full fidelity of every field. Do not hand-edit field values.

- [ ] **Step 2: Write `src/sources/anilist/queries.ts`**

Copy the three verified query strings verbatim from Step 1. Do not reformat them —
they are known-good against the live schema.

Add a compile-time-ish guard comment recording the verified traps:
`sort` is `[MediaSort]`; `MediaTag.category` is a String; `isMediaSpoiler` not
`isSpoiler`; `StudioEdge.isMain`.

- [ ] **Step 3: Write the failing fixture-shape test**

`test/anilist-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AniListPage, AniListMedia } from '../src/sources/anilist/types.js';

const load = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('recorded AniList fixtures', () => {
  it('catalog fixture parses and has the verified shape', () => {
    const page = load<AniListPage<AniListMedia>>('./fixtures/catalog-trending.json');
    expect(page.pageInfo.perPage).toBeLessThanOrEqual(50); // clamp verified
    expect(page.media.length).toBeGreaterThan(0);
    const m = page.media[0]!;
    expect(m.id).toBeTypeOf('number');
    expect(m.title.romaji ?? m.title.english ?? m.title.native).toBeTruthy();
    expect(typeof m.duration === 'number' || m.duration === null).toBe(true);
  });

  it('meta fixture has all 29 requested fields for One Piece', () => {
    const { data } = load<{ data: { Media: AniListMedia } }>('./fixtures/meta-21.json');
    expect(data.Media!.id).toBe(21);
    expect(data.Media!.idMal).toBe(21);
    expect(data.Media!.source).toBe('MANGA');
    expect(data.Media!.genres!.length).toBeGreaterThan(0);
    expect(data.Media!.tags![0]!.category).toBeTypeOf('string'); // String, not object
  });

  it('unknown id fixture carries BOTH a 404 errors array and Media: null', () => {
    const res = load<{
      data?: { Media: AniListMedia | null };
      errors?: Array<{ message: string; status: number }>;
    }>('./fixtures/meta-null.json');
    expect(res.data?.Media).toBeNull();
    // AniList reports "not found" as BOTH an error entry and a null Media.
    expect(res.errors?.[0]?.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run test/anilist-types.test.ts`
Expected: FAIL — `Cannot find module '../src/sources/anilist/types.js'`

- [ ] **Step 5: Implement `src/sources/anilist/types.ts`**

Every field from §1.5.3/§1.5.4, typed exactly as the interfaces above. Rule: any
field AniList can return `null` for is `| null`. `Media.id` alone is `number`
(non-null per introspection). No index signatures, no `any`, no `unknown` blobs.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/anilist-types.test.ts` → Expected: 3 passed

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: record AniList fixtures and add typed GraphQL responses"
```

---

### Task 3: HTTP client with timeout, User-Agent and header capture

**Files:**
- Create: `src/net/http.ts`
- Create: `test/http.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface HttpResult<T> { data: T; headers: Record<string,string>; status: number }`
  - `interface GetJsonOptions { timeoutMs?: number; headers?: Record<string,string> }`
  - `class HttpClient { constructor(opts?: { timeoutMs?: number; userAgent?: string }); getJson<T>(url: string, init?: RequestInit & GetJsonOptions): Promise<HttpResult<T>> }`
  - Throws `SourceError` with `kind: 'timeout' | 'network' | 'server_error' | 'invalid_request' | 'parse'` (see Task 4's taxonomy — declare `SourceError` in `src/domain/errors.ts` **in this task** so Task 4 can build on it)

- [ ] **Step 1: Write the failing tests**

`test/http.test.ts`, using a real local `node:http` server as the upstream so no
network is involved:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { HttpClient } from '../src/net/http.js';

let server: Server; let base: string;
afterEach(() => { server?.close(); });

async function serve(handler: (req, res) => void): Promise<void> {
  server = createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
}
const body = (o: unknown) => JSON.stringify(o);

it('returns parsed JSON and lower-cased response headers', async () => {
  await serve((_q, res) => { res.setHeader('x-ratelimit-remaining', '17'); res.end(body({ ok: 1 })); });
  const r = await new HttpClient().getJson<{ ok: number }>(`${base}/x`);
  expect(r.data).toEqual({ ok: 1 });
  expect(r.headers['x-ratelimit-remaining']).toBe('17');
  expect(r.status).toBe(200);
});

it('throws kind=timeout when the upstream exceeds timeoutMs', async () => {
  await serve(() => { /* never responds */ });
  await expect(new HttpClient({ timeoutMs: 150 }).getJson(`${base}/slow`))
    .rejects.toMatchObject({ kind: 'timeout' });
});

it('throws kind=parse on a non-JSON body', async () => {
  await serve((_q, res) => { res.setHeader('content-type', 'application/json'); res.end('<html>nope'); });
  await expect(new HttpClient().getJson(`${base}/x`)).rejects.toMatchObject({ kind: 'parse' });
});

it('throws kind=server_error on 5xx', async () => {
  await serve((_q, res) => { res.statusCode = 503; res.end('{}'); });
  await expect(new HttpClient().getJson(`${base}/x`)).rejects.toMatchObject({ kind: 'server_error', status: 503 });
});

it('throws kind=invalid_request on 4xx and carries the status', async () => {
  await serve((_q, res) => { res.statusCode = 400; res.end(body({ errors: [{ message: 'bad', status: 400 }] })); });
  await expect(new HttpClient().getJson(`${base}/x`)).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
});

it('sends the configured User-Agent', async () => {
  let seen = '';
  await serve((q, res) => { seen = q.headers['user-agent'] ?? ''; res.end(body({})); });
  await new HttpClient({ userAgent: 'anicata-test/1.0' }).getJson(`${base}/x`);
  expect(seen).toBe('anicata-test/1.0');
});

it('aborts and throws kind=network when the connection is refused', async () => {
  await serve(() => {});
  const dead = base; server.close();
  await expect(new HttpClient({ timeoutMs: 500 }).getJson(`${dead}/x`)).rejects.toMatchObject({ kind: 'network' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/http.test.ts`
Expected: FAIL — `Cannot find module '../src/net/http.js'`

- [ ] **Step 3: Implement `src/domain/errors.ts`**

```ts
export type SourceErrorKind =
  | 'not_found' | 'invalid_request' | 'rate_limited'
  | 'server_error' | 'timeout' | 'network' | 'parse';

export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) { super(message); this.name = 'SourceError'; }
}
```

- [ ] **Step 4: Implement `src/net/http.ts`**

Native `fetch` only. Per call: `AbortController` + `setTimeout(…, timeoutMs)`,
`clearTimeout` in `finally`, `User-Agent` default `anicata-anime-addon/0.1`.
Iterate `res.headers` into a plain object with lower-cased keys. Map failures:

| Condition | `kind` |
|---|---|
| `AbortError` from our own timer | `timeout` |
| other `fetch` rejection | `network` |
| status 429 | `rate_limited`, `retryAfterSeconds` from `Retry-After` |
| status ≥ 500 | `server_error` |
| status ≥ 400 | `invalid_request` |
| body is not JSON | `parse` |

Always include the numeric `status` when there was a response. Include at most
500 characters of the response body in the message so logs stay bounded.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/http.test.ts` → Expected: 7 passed

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: HTTP client with timeout, header capture and error taxonomy"
```

---

### Task 4: Rate limiter and TTL cache with stale-while-revalidate + single-flight

**Files:**
- Create: `src/net/limiter.ts`, `src/cache/store.ts`
- Create: `test/limiter.test.ts`, `test/cache.test.ts`

**Interfaces:**
- Consumes: `SourceError` from Task 3
- Produces:
  - `class TokenBucket { constructor(opts: { capacity: number; refillPerMinute: number; now?: () => number }); tryAcquire(): boolean; available(): number; msUntilNextToken(): number }`
  - `interface CacheEntry<T> { value: T; freshUntil: number; staleUntil: number }`
  - `interface CacheStats { hits: number; misses: number; stale: number }`
  - `type Freshness = 'fresh' | 'stale'`
  - `class TTLCache { constructor(opts?: { maxEntries?: number; now?: () => number }); get<T>(key: string): { value: T; freshness: Freshness } | undefined; set<T>(key: string, value: T, opts: { ttlMs: number; staleMs: number }): void; wrap<T>(key: string, opts: { ttlMs: number; staleMs: number }, fn: () => Promise<T>): Promise<{ value: T; freshness: Freshness }>; stats(): CacheStats; clear(): void; size(): number }`
  - Constants: `export const CACHE_MAX_ENTRIES = 10_000`

- [ ] **Step 1: Write the failing token-bucket test**

`test/limiter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../src/net/limiter.js';

describe('TokenBucket', () => {
  it('allows capacity tokens then refuses', () => {
    const b = new TokenBucket({ capacity: 3, refillPerMinute: 60 });
    expect([b.tryAcquire(), b.tryAcquire(), b.tryAcquire()]).toEqual([true, true, true]);
    expect(b.tryAcquire()).toBe(false);
  });

  it('refills continuously using the injected clock', () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 1, refillPerMinute: 60, now: () => now });
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    now += 1_100; // 1.1s at 1 token/sec == 1.1 tokens
    expect(b.tryAcquire()).toBe(true);
  });

  it('reports ms until the next token is available', () => {
    const b = new TokenBucket({ capacity: 1, refillPerMinute: 60 });
    b.tryAcquire();
    expect(b.msUntilNextToken()).toBeGreaterThan(900);
    expect(b.msUntilNextToken()).toBeLessThanOrEqual(1000);
  });
});
```

- [ ] **Step 2: Write the failing cache test**

`test/cache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { TTLCache } from '../src/cache/store.js';

describe('TTLCache', () => {
  it('serves a fresh value without calling the loader', async () => {
    let now = 0;
    const c = new TTLCache({ now: () => now });
    const fn = vi.fn().mockResolvedValue('v');
    expect((await c.wrap('k', { ttlMs: 1000, staleMs: 5000 }, fn)).value).toBe('v');
    now += 500;
    expect((await c.wrap('k', { ttlMs: 1000, staleMs: 5000 }, fn)).freshness).toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('serves stale immediately past ttl and refreshes in the background', async () => {
    let now = 0;
    const c = new TTLCache({ now: () => now });
    const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    await c.wrap('k', { ttlMs: 1000, staleMs: 10_000 }, fn);
    now += 2000; // past fresh, within stale
    const r = await c.wrap('k', { ttlMs: 1000, staleMs: 10_000 }, fn);
    expect(r.value).toBe('first');
    expect(r.freshness).toBe('stale');
    await new Promise(res => setImmediate(res));
    expect(fn).toHaveBeenCalledTimes(2);
    expect((await c.wrap('k', { ttlMs: 1000, staleMs: 10_000 }, fn)).value).toBe('second');
  });

  it('drops the entry entirely past staleMs', async () => {
    let now = 0;
    const c = new TTLCache({ now: () => now });
    const fn = vi.fn().mockResolvedValue('v');
    await c.wrap('k', { ttlMs: 1000, staleMs: 2000 }, fn);
    now += 5000;
    expect(c.get('k')).toBeUndefined();
  });

  it('coalesces 10 concurrent misses into exactly one loader call', async () => {
    const c = new TTLCache();
    let calls = 0;
    const fn = vi.fn(async () => { calls++; await new Promise(r => setTimeout(r, 10)); return 'v'; });
    await Promise.all(Array.from({ length: 10 }, () => c.wrap('k', { ttlMs: 1000, staleMs: 1000 }, fn)));
    expect(calls).toBe(1);
  });

  it('does not cache a rejected loader', async () => {
    const c = new TTLCache();
    const fn = vi.fn().mockRejectedValue(new Error('upstream down'));
    await expect(c.wrap('k', { ttlMs: 1000, staleMs: 1000 }, fn)).rejects.toThrow();
    await expect(c.wrap('k', { ttlMs: 1000, staleMs: 1000 }, fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used entries beyond maxEntries', async () => {
    const c = new TTLCache({ maxEntries: 2 });
    c.set('a', 1, { ttlMs: 10_000, staleMs: 10_000 });
    c.set('b', 2, { ttlMs: 10_000, staleMs: 10_000 });
    c.get('a');
    c.set('c', 3, { ttlMs: 10_000, staleMs: 10_000 });
    expect(c.size()).toBe(2);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
  });
});
```

The single-flight test is **Review Focus #4**: it is the test that stops a cold
cache under Nuvio's parallel Home fetch from burning the 30 req/min budget.

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run test/limiter.test.ts test/cache.test.ts`
Expected: FAIL — `Cannot find module '../src/net/limiter.js'`

- [ ] **Step 4: Implement `src/net/limiter.ts`**

Fractional-token continuous refill: `tokens = min(capacity, tokens + elapsedMs/60000 * refillPerMinute)`.
`tryAcquire()` returns false and does not mutate when `tokens < 1`.
`msUntilNextToken()` = `ceil((1 - tokens) / (refillPerMinute/60000))`, or `0` when a
token is available. `now` defaults to `Date.now`.

- [ ] **Step 5: Implement `src/cache/store.ts`**

`Map`-backed. `get` returns `undefined` once `now >= staleUntil` (and deletes the
entry). `wrap` algorithm, exactly:

1. `get(key)` → if hit: if `freshness === 'fresh'` return it; else **fire and
   forget** `this.refresh(key, opts, fn)` and return the stale value.
2. If an in-flight promise exists for `key`, await and return it.
3. Otherwise create the in-flight promise from `fn()`, `await` it, `set` on
   success, delete the in-flight entry in `finally`.

A rejected `fn` must not leave an in-flight entry behind and must not write a
value. LRU: keep an insertion/access-ordered structure — a `Map` whose keys are
re-inserted on `get` gives LRU ordering for free, since `Map` preserves insertion
order. Evict from the front when `size > maxEntries`.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run test/limiter.test.ts test/cache.test.ts` → Expected: 9 passed

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: token-bucket limiter and TTL cache with stale-while-revalidate"
```

---

### Task 5: Domain model and text normalisation

**Files:**
- Create: `src/domain/anime.ts`, `src/normalize/text.ts`
- Create: `test/domain-anime.test.ts`, `test/normalize-text.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `src/domain/anime.ts`:
    - `type AnimeFormat = 'TV'|'TV_SHORT'|'MOVIE'|'SPECIAL'|'OVA'|'ONA'|'MUSIC'|'OTHER'`
    - `type AnimeStatus = 'FINISHED'|'RELEASING'|'NOT_YET_RELEASED'|'CANCELLED'|'HIATUS'|'UNKNOWN'`
    - `type Season = 'WINTER'|'SPRING'|'SUMMER'|'FALL'`
    - `interface AnimeIdentity { anilist: number; mal?: number }`
    - `interface AnimeTitle { romaji?: string; english?: string; native?: string; synonyms: string[] }`
    - `interface AnimeImages { poster?: string; background?: string }`
    - `interface Tag { id: number; name: string; rank: number; category: string }`
    - `interface Studio { id: number; name: string; isMain: boolean }`
    - `interface Relation { id: number; relationType: string; title: string; format?: AnimeFormat; type: string }`
    - `interface AiringInfo { nextEpisode?: number; nextAiringAt?: number }`
    - `interface Anime { identity: AnimeIdentity; title: AnimeTitle; displayTitle: string; description?: string; format: AnimeFormat; status: AnimeStatus; type: 'anime'|'movie'; episodes?: number; durationMinutes?: number; releaseDate?: string; releaseYear?: number; season?: Season; seasonYear?: number; genres: string[]; tags: Tag[]; studios: Studio[]; relations: Relation[]; images: AnimeImages; scoreAnilist?: number; airing?: AiringInfo; siteUrl?: string; hashtags: string[]; countryOfOrigin?: string }`
    - `export function stremioIdFor(identity: AnimeIdentity): string` → `` `anilist:${identity.anilist}` ``
  - `src/normalize/text.ts`:
    - `stripHtml(input: string): string`
    - `stripAttribution(input: string): string`
    - `collapseWhitespace(input: string): string`
    - `normalizeDescription(input: string | null | undefined, opts?: { maxLength?: number }): string | undefined`
    - `resolveDisplayTitle(title: AnimeTitle, lang: 'english'|'romaji'|'native'): string`
    - `const DESCRIPTION_MAX_LENGTH = 900`

- [ ] **Step 1: Write the failing text tests**

`test/normalize-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stripHtml, stripAttribution, collapseWhitespace,
         normalizeDescription, resolveDisplayTitle } from '../src/normalize/text.js';

describe('stripHtml', () => {
  it('removes tags and decodes the entities AniList emits', () => {
    expect(stripHtml('<p>Hello<br/>World &amp; more</p>')).toBe('HelloWorld & more');
  });
  it('returns a trimmed string for empty-ish input', () => {
    expect(stripHtml('   ')).toBe('');
  });
});

describe('stripAttribution', () => {
  it('drops a trailing (Source: MAL Rewrite) attribution', () => {
    expect(stripAttribution('A story.\n\n(Source: MAL Rewrite)')).toBe('A story.');
  });
  it('keeps parentheses that are not an attribution', () => {
    expect(stripAttribution('He said (hi) loudly.')).toBe('He said (hi) loudly.');
  });
});

describe('normalizeDescription', () => {
  it('strips html, attribution and whitespace, then truncates on a word boundary', () => {
    const long = 'word '.repeat(400);
    const out = normalizeDescription(long, { maxLength: 100 })!;
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('word')).toBe(true);
  });
  it('returns undefined for null, undefined or whitespace-only input', () => {
    expect(normalizeDescription(null)).toBeUndefined();
    expect(normalizeDescription(undefined)).toBeUndefined();
    expect(normalizeDescription('   ')).toBeUndefined();
  });
});

describe('resolveDisplayTitle', () => {
  it('prefers english, then romaji, then native', () => {
    expect(resolveDisplayTitle({ romaji: 'R', english: 'E', native: 'N', synonyms: [] }, 'english')).toBe('E');
    expect(resolveDisplayTitle({ romaji: 'R', native: 'N', synonyms: [] }, 'english')).toBe('R');
    expect(resolveDisplayTitle({ native: 'N', synonyms: [] }, 'english')).toBe('N');
  });
  it('falls back to a non-blank title whatever the language preference', () => {
    expect(resolveDisplayTitle({ romaji: 'R', synonyms: [] }, 'native')).toBe('R');
  });
  it('returns "Untitled" only when every title is missing or blank', () => {
    expect(resolveDisplayTitle({ romaji: '  ', synonyms: [] }, 'english')).toBe('Untitled');
    expect(resolveDisplayTitle({ synonyms: [] }, 'english')).toBe('Untitled');
  });
});
```

The last case is **Review Focus #5**: AniList can return all-null titles, and Nuvio
silently drops any catalogue item with a blank `name`.

- [ ] **Step 2: Write the failing domain test**

`test/domain-anime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stremioIdFor } from '../src/domain/anime.js';

describe('stremioIdFor', () => {
  it('always produces a prefixed anilist id', () => {
    expect(stremioIdFor({ anilist: 21 })).toBe('anilist:21');
    expect(stremioIdFor({ anilist: 1, mal: 21 })).toBe('anilist:1');
  });
  it('never produces a bare number, which Nuvio would read as a Trakt id', () => {
    expect(stremioIdFor({ anilist: 21 }).startsWith('anilist:')).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/normalize-text.test.ts test/domain-anime.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement `src/domain/anime.ts`**

Exactly the interfaces listed above. `src/domain/` imports nothing — verify with
`grep -rn "^import" src/domain/` returning empty.

- [ ] **Step 5: Implement `src/normalize/text.ts`**

`stripHtml`: remove `<…>` tags, then decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`
and numeric entities, then trim. Do not insert spaces for `<br>` (the test pins
`HelloWorld`). `stripAttribution`: repeatedly strip a trailing
`\s*\(Source:[^)]*\)\s*$` (case-insensitive) and a trailing `(Source: …)`. Only at
end-of-string, so mid-sentence parentheses survive. `collapseWhitespace`: collapse
runs of whitespace to a single space and trim. `normalizeDescription`: compose
those three, return `undefined` when the result is empty, and truncate to
`maxLength` (default `DESCRIPTION_MAX_LENGTH = 900`) on the last space before the
limit. `resolveDisplayTitle`: try `english`/`romaji`/`native` per preference, then
any non-blank of the three, then a synonym, then `'Untitled'`.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run test/normalize-text.test.ts test/domain-anime.test.ts`
Expected: 8 passed

- [ ] **Step 7: Enforce the domain import rule in ESLint**

Append to `eslint.config.js` a rule blocking all imports inside `src/domain/**`:

```js
{
  files: ['src/domain/**/*.ts'],
  rules: { 'no-restricted-imports': ['error', { patterns: ['**/*'] }] },
}
```

Also add `src/adapter-cross-imports` guard as `no-restricted-imports` with
`patterns: ['../jikan/**', '../kitsu/**', '../tmdb/**', '../anizip/**']` scoped to
`files: ['src/sources/anilist/**/*.ts']`.

Verify: `grep -rn "^import" src/domain/` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: domain model, text normalisation and layer boundary rules"
```

---

### Task 6: AniList → Anime normaliser

**Files:**
- Create: `src/normalize/anime.ts`
- Create: `test/normalize-anime.test.ts`

**Interfaces:**
- Consumes: `Anime`, `AnimeTitle`, `Tag`, `Studio`, `Relation`, `AiringInfo`,
  `AnimeFormat`, `AnimeStatus`, `Season`, `stremioIdFor` (Task 5);
  `AniListMedia` (Task 2); `normalizeDescription`, `resolveDisplayTitle` (Task 5)
- Produces:
  - `normalizeMedia(m: AniListMedia, opts: { titleLang: 'english'|'romaji'|'native' }): Anime`
  - `normalizeFormat(raw: string | null | undefined): AnimeFormat`
  - `normalizeStatus(raw: string | null | undefined): AnimeStatus`
  - `export const TAG_MIN_RANK = 60`

- [ ] **Step 1: Write the failing tests**

`test/normalize-anime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AniListMedia } from '../src/sources/anilist/types.js';
import { normalizeMedia, normalizeFormat, normalizeStatus, TAG_MIN_RANK } from '../src/normalize/anime.js';

const meta = JSON.parse(
  readFileSync(new URL('./fixtures/meta-21.json', import.meta.url), 'utf8'),
) as { data: { Media: AniListMedia } };
const onePiece = meta.data.Media!;

describe('normalizeFormat / normalizeStatus', () => {
  it('maps every AniList format value', () => {
    for (const f of ['TV','TV_SHORT','MOVIE','SPECIAL','OVA','ONA','MUSIC'])
      expect(normalizeFormat(f)).toBe(f);
  });
  it('maps unknown or null format to OTHER', () => {
    expect(normalizeFormat(null)).toBe('OTHER');
    expect(normalizeFormat('MANGA')).toBe('OTHER');
  });
  it('maps every AniList status value, including CANCELLED not DELAYED', () => {
    for (const s of ['FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS'])
      expect(normalizeStatus(s)).toBe(s);
  });
  it('maps unknown or null status to UNKNOWN', () => {
    expect(normalizeStatus(null)).toBe('UNKNOWN');
    expect(normalizeStatus('DELAYED')).toBe('UNKNOWN');
  });
});

describe('normalizeMedia', () => {
  const a = normalizeMedia(onePiece, { titleLang: 'english' });

  it('maps identity and produces the prefixed stremio id', () => {
    expect(a.identity).toEqual({ anilist: 21, mal: 21 });
  });

  it('resolves a display title', () => {
    expect(a.displayTitle).toBe('ONE PIECE');
  });

  it('strips html and attribution from the description', () => {
    expect(a.description).toBeTruthy();
    expect(a.description).not.toMatch(/<[a-z]/i);
    expect(a.description!.length).toBeLessThanOrEqual(900);
  });

  it('uses duration as an integer number of minutes', () => {
    expect(a.durationMinutes).toBe(24);
  });

  it('keeps the AniList 0-100 score as-is; rendering divides by 10', () => {
    expect(a.scoreAnilist).toBe(onePiece.averageScore!);
    expect(a.scoreAnilist).toBeGreaterThan(0);
    expect(a.scoreAnilist).toBeLessThanOrEqual(100);
  });

  it('uses extraLarge for the poster, never the mis-sized large', () => {
    expect(a.images.poster).toBe(onePiece.coverImage!.extraLarge);
    expect(a.images.poster).toContain('/cover/large/');
  });

  it('maps tags, dropping spoiler tags and low-rank tags', () => {
    const b = normalizeMedia({
      ...onePiece,
      tags: [
        { id: 1, name: 'Good', rank: 90, category: 'Theme', isMediaSpoiler: false, isAdult: false },
        { id: 2, name: 'Spoiler', rank: 90, category: 'Theme', isMediaSpoiler: true, isAdult: false },
        { id: 3, name: 'Weak', rank: 5, category: 'Theme', isMediaSpoiler: false, isAdult: false },
        { id: 4, name: 'Adult', rank: 90, category: 'Theme', isMediaSpoiler: false, isAdult: true },
      ],
    }, { titleLang: 'english' });
    expect(b.tags.map(t => t.name)).toEqual(['Good']);
    expect(TAG_MIN_RANK).toBe(60);
  });

  it('maps studios with the isMain flag from StudioEdge', () => {
    expect(a.studios).toContainEqual({ id: 18, name: 'Toei Animation', isMain: true });
  });

  it('maps relations and tolerates a null relation list', () => {
    expect(a.relations.length).toBeGreaterThan(0);
    expect(a.relations[0]).toMatchObject({ relationType: expect.any(String) });
    expect(normalizeMedia({ ...onePiece, relations: null }, { titleLang: 'english' }).relations).toEqual([]);
  });

  it('falls back to a synonym when all three primary titles are blank', () => {
    // A blank name makes Nuvio SILENTLY DROP the catalogue item. One Piece's real
    // fixture has synonyms, so preferring a synonym over 'Untitled' keeps the item
    // visible. Only fall to 'Untitled' when there is genuinely no name at all.
    const b = normalizeMedia({ ...onePiece, title: { romaji: null, english: null, native: null } },
                              { titleLang: 'english' });
    expect(b.displayTitle).not.toBe('Untitled');
    expect(onePiece.synonyms).toContain(b.displayTitle);
  });

  it('falls back to Untitled only when titles AND synonyms are all blank', () => {
    const b = normalizeMedia(
      { ...onePiece, title: { romaji: null, english: null, native: null }, synonyms: [] },
      { titleLang: 'english' },
    );
    expect(b.displayTitle).toBe('Untitled');
  });

  it('populates title.synonyms from AniList synonyms', () => {
    expect(anime.title.synonyms).toEqual(onePiece.synonyms ?? []);
  });

  it('survives an entirely empty payload without throwing', () => {
    const b = normalizeMedia({ id: 1 } as AniListMedia, { titleLang: 'english' });
    expect(b.displayTitle).toBe('Untitled');
    expect(b.genres).toEqual([]);
    expect(b.images.poster).toBeUndefined();
  });

  it('carries countryOfOrigin through so the renderer can emit both spellings', () => {
    expect(a.countryOfOrigin).toBe('JP');
  });

  it('maps MOVIE format to stremio type movie and everything else to anime', () => {
    expect(normalizeMedia({ ...onePiece, format: 'MOVIE' }, { titleLang: 'english' }).type).toBe('movie');
    expect(normalizeMedia({ ...onePiece, format: 'TV' }, { titleLang: 'english' }).type).toBe('anime');
    expect(normalizeMedia({ ...onePiece, format: 'OVA' }, { titleLang: 'english' }).type).toBe('anime');
  });

  it('builds an ISO release date and a release year from startDate', () => {
    expect(a.releaseDate).toBe('1999-10-20');
    expect(a.releaseYear).toBe(1999);
  });

  it('omits the release date when startDate is entirely null', () => {
    const b = normalizeMedia({ ...onePiece, startDate: null }, { titleLang: 'english' });
    expect(b.releaseDate).toBeUndefined();
    expect(b.releaseYear).toBeUndefined();
  });

  it('maps nextAiringEpisode into airing, and omits it when null', () => {
    expect(a.airing).toMatchObject({ nextEpisode: 1181 });
    const b = normalizeMedia({ ...onePiece, nextAiringEpisode: null }, { titleLang: 'english' });
    expect(b.airing).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/normalize-anime.test.ts`
Expected: FAIL — `Cannot find module '../src/normalize/anime.js'`

- [ ] **Step 3: Implement `src/normalize/anime.ts`**

Rules, all pinned by the tests:

- `normalizeFormat` / `normalizeStatus`: pass through the seven / five documented
  values; anything else (`null`, `MANGA`, `DELAYED`) → `OTHER` / `UNKNOWN`.
- `displayTitle`: `resolveDisplayTitle(m.title, opts.titleLang)`.
- `description`: `normalizeDescription(m.description)`.
- `poster`: `m.coverImage?.extraLarge ?? undefined` — never `.large`.
- `background`: `m.bannerImage ?? undefined`.
- `scoreAnilist`: `m.averageScore ?? undefined` (0–100, unscaled).
- `durationMinutes`: `m.duration ?? undefined` (already minutes).
- Tags: keep where `rank >= TAG_MIN_RANK` (60) **and** `isMediaSpoiler !== true`
  **and** `isAdult !== true`; `category` defaults to `'Unknown'` when null.
- Studios: `m.studios?.edges.map(e => ({ id: e.node.id, name: e.node.name, isMain: e.isMain })) ?? []`.
- Relations: `m.relations?.edges.map(e => ({ id: e.node.id, relationType: e.relationType, title: resolveDisplayTitle({...}, lang), format: normalizeFormat(e.node.format), type: e.node.type })) ?? []`.
- `releaseDate`: build `YYYY-MM-DD` from `startDate` only when `year != null`;
  pad month/day to 2 digits, treat a missing month/day as `01`/`01`.
- `airing`: set only when `m.nextAiringEpisode != null`.
- `hashtags`: `m.hashtag ? [m.hashtag] : []`.
- `title.synonyms`: `m.synonyms ?? []`, and **`displayTitle` must be resolved with
  those real synonyms in scope** — pass the populated title object to
  `resolveDisplayTitle`, not one with `synonyms: []`. A blank `name` makes Nuvio
  silently drop the item, so any real name beats `'Untitled'`.
- `countryOfOrigin`: `m.countryOfOrigin ?? undefined` (AniList's only origin value; the
  renderer fans it out to both `country` and `countryOfOrigin`).
- Every collection access must tolerate `null`. **No `any`, no non-null `!` on
  AniList fields** — use `?? undefined` and optional chaining throughout, because
  the "entirely empty payload" test must pass.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/normalize-anime.test.ts` → Expected: 21 passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: normalise AniList media into the domain Anime model"
```

---

### Task 7: Catalogue definitions and the AniList adapter

**Files:**
- Create: `src/sources/catalog-def.ts`, `src/sources/anilist/adapter.ts`
- Create: `test/anilist-adapter.test.ts`

**Interfaces:**
- Consumes: `AniListPage`, `AniListMedia`, `AniListGraphQLResponse` (Task 2);
  `CATALOG_QUERY`, `SEARCH_QUERY` (Task 2); `HttpClient` (Task 3);
  `TokenBucket` (Task 4); `normalizeMedia` (Task 6); `Anime` (Task 5);
  `SourceError` (Task 3); `createLogger` (Task 1)
- Produces:
  - `src/sources/catalog-def.ts`:
    - `type CatalogId = 'anime-trending' | 'anime-top-rated' | 'anime-search'`
    - `interface CatalogDefinition { id: CatalogId; type: 'anime'; name: string; supportsSearch: boolean; buildQuery(skip: number): AniListPageQuery }`
    - `interface AniListPageQuery { sort: string[]; search?: string; genre?: string; page: number; perPage: number }`
    - `CATALOG_DEFS: Record<CatalogId, CatalogDefinition>`
    - `export const PAGE_SIZE = 100` (Nuvio's `CATALOG_PAGE_SIZE`)
    - `export const ANILIST_PER_PAGE = 50` (AniList's verified clamp)
  - `src/sources/anilist/adapter.ts`:
    - `interface AniListSourceDeps { http: HttpClient; limiter: TokenBucket; log?: Logger }`
    - `class AniListSource { constructor(deps: AniListSourceDeps); fetchCatalogPage(q: AniListPageQuery): Promise<{ items: Anime[]; total: number }>; search(term: string, page: number): Promise<{ items: Anime[]; total: number }>; fetchById(anilistId: number): Promise<Anime | null>; fetchByIds(anilistIds: number[]): Promise<Anime[]> }`

  `AniListSource` deliberately does **not** import a `Source` interface — that type is declared in Task 8 and satisfied structurally. Keeping the adapter free of a service-layer type is what prevents an import cycle.

- [ ] **Step 1: Write the failing adapter test**

`test/anilist-adapter.test.ts`, with a fake `HttpClient` and a fake limiter:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AniListSource } from '../src/sources/anilist/adapter.js';
import { CATALOG_DEFS, PAGE_SIZE, ANILIST_PER_PAGE } from '../src/sources/catalog-def.js';
import { CATALOG_QUERY, SEARCH_QUERY } from '../src/sources/anilist/queries.js';
import type { SourceErrorKind } from '../src/domain/errors.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

function deps(payloads: unknown[]) {
  const queue = [...payloads];
  const getJson = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { data: next, headers: {}, status: 200 };
  });
  const limiter = { tryAcquire: () => true, available: () => 25, msUntilNextToken: () => 0 };
  return {
    http: { getJson } as never,
    limiter: limiter as never,
    log: { debug(){}, info(){}, warn(){}, error(){} },
    _getJson: getJson,
  };
}

const page1 = load('./fixtures/catalog-trending.json');
const page2 = load('./fixtures/catalog-trending-p2.json');

describe('AniListSource.fetchCatalogPage', () => {
  it('posts CATALOG_QUERY to graphql.anilist.co with sort as a list', async () => {
    const d = deps([page1]);
    await new AniListSource(d).fetchCatalogPage({ sort: ['TRENDING_DESC'], page: 1, perPage: 50 });
    const [url, init] = d._getJson.mock.calls[0]!;
    expect(url).toBe('https://graphql.anilist.co');
    expect(init!.method).toBe('POST');
    const sent = JSON.parse(String(init!.body));
    expect(sent.query).toBe(CATALOG_QUERY);
    expect(sent.variables.sort).toEqual(['TRENDING_DESC']); // a LIST, per verified schema
  });

  it('returns normalised Anime items and the page total', async () => {
    const d = deps([page1]);
    const r = await new AniListSource(d).fetchCatalogPage({ sort: ['TRENDING_DESC'], page: 1, perPage: 50 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.identity.anilist).toBeTypeOf('number');
    expect(r.total).toBe(page1.pageInfo.total);
  });

  it('throws kind=rate_limited with retryAfterSeconds when AniList 429s', async () => {
    const err = Object.assign(new Error('Too Many Requests.'), { kind: 'rate_limited' as SourceErrorKind, retryAfterSeconds: 42 });
    await expect(new AniListSource(deps([err])).fetchCatalogPage({ sort: [], page: 1, perPage: 50 }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 42 });
  });

  it('throws kind=not_found when AniList returns data.media === null', async () => {
    await expect(new AniListSource(deps([{ pageInfo: {}, media: null }]))
      .fetchCatalogPage({ sort: [], page: 1, perPage: 50 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('surfaces a GraphQL errors array as invalid_request even on HTTP 200', async () => {
    await expect(new AniListSource(deps([{ errors: [{ message: 'Variable "$sort" … expecting type "[MediaSort]".', status: 400 }] }))
      .fetchCatalogPage({ sort: [], page: 1, perPage: 50 })).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
  });

  it('never calls fetch when the limiter has no token', async () => {
    const d = deps([page1]);
    (d.limiter as unknown as { tryAcquire: () => boolean }).tryAcquire = () => false;
    await expect(new AniListSource(d).fetchCatalogPage({ sort: [], page: 1, perPage: 50 }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    expect(d._getJson).not.toHaveBeenCalled();
  });
});

describe('AniListSource.search', () => {
  it('uses SEARCH_QUERY and returns matching items', async () => {
    const d = deps([load('./fixtures/catalog-search.json')]);
    const r = await new AniListSource(d).search('cowboy bebop', 1);
    expect(r.items.length).toBeGreaterThan(0);
    const sent = JSON.parse(String(d._getJson.mock.calls[0]![1]!.body));
    expect(sent.query).toBe(SEARCH_QUERY);
    expect(sent.variables.search).toBe('cowboy bebop');
  });
});

describe('AniListSource.fetchById', () => {
  it('returns the Anime for a known id', async () => {
    const d = deps([{ data: { Media: load('./fixtures/meta-21.json').data.Media } }]);
    const a = await new AniListSource(d).fetchById(21);
    expect(a!.identity.anilist).toBe(21);
  });

  it('returns null, NOT an error, when data.Media is null', async () => {
    const d = deps([{ data: { Media: null } }]);
    expect(await new AniListSource(d).fetchById(99999999)).toBeNull();
  });

  it('still returns null when a 404 errors array accompanies Media: null', async () => {
    // The real AniList shape. An "errors present -> throw" rule would fail here.
    const d = deps([{ errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } }]);
    await expect(new AniListSource(d).fetchById(99999999)).resolves.toBeNull();
  });

  it('preserves that null-media behaviour across the HttpClient boundary', async () => {
    // AniList answers HTTP 200 for an unknown id; the adapter must still yield null.
    const d = deps([{ data: { Media: null } }]);
    await expect(new AniListSource(d).fetchById(99999999)).resolves.toBeNull();
  });
});

describe('catalog definitions', () => {
  it('declares exactly three Phase 1 catalogues, all type anime', () => {
    expect(Object.keys(CATALOG_DEFS).sort()).toEqual(['anime-search', 'anime-top-rated', 'anime-trending']);
    for (const c of Object.values(CATALOG_DEFS)) expect(c.type).toBe('anime');
  });

  it('marks only anime-search as searchable', () => {
    expect(CATALOG_DEFS['anime-search'].supportsSearch).toBe(true);
    expect(CATALOG_DEFS['anime-trending'].supportsSearch).toBe(false);
    expect(CATALOG_DEFS['anime-top-rated'].supportsSearch).toBe(false);
  });

  it('pins PAGE_SIZE to 100 and ANILIST_PER_PAGE to AniList\'s verified clamp', () => {
    expect(PAGE_SIZE).toBe(100);
    expect(ANILIST_PER_PAGE).toBe(50);
    expect(PAGE_SIZE % ANILIST_PER_PAGE).toBe(0); // exactly 2 upstream pages per Nuvio page
  });

  it('builds distinct sort arguments per catalogue', () => {
    expect(CATALOG_DEFS['anime-trending'].buildQuery(0).sort).toEqual(['TRENDING_DESC']);
    expect(CATALOG_DEFS['anime-top-rated'].buildQuery(0).sort).toEqual(['SCORE_DESC']);
  });
});

describe('page 1 and page 2 are disjoint (Review Focus #1)', () => {
  it('has no overlapping ids across the two recorded pages', () => {
    const a = new Set(page1.media.map((m: { id: number }) => m.id));
    const b = page2.media.map((m: { id: number }) => m.id);
    expect(page1.media.some((m: { id: number }) => b.includes(m.id))).toBe(false);
    expect(a.size).toBe(page1.media.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/anilist-adapter.test.ts`
Expected: FAIL — `Cannot find module '../src/sources/anilist/adapter.js'`

- [ ] **Step 3: Implement `src/sources/catalog-def.ts`**

```ts
export const PAGE_SIZE = 100;        // Nuvio CATALOG_PAGE_SIZE
export const ANILIST_PER_PAGE = 50; // verified clamp
```

`buildQuery(skip)` for each catalogue maps `skip` to AniList pages:

```ts
page: Math.floor(skip / ANILIST_PER_PAGE) + 1 + (skip % ANILIST_PER_PAGE === 0 ? 0 : 1)
```

— but simpler and correct for Phase 1: since `skip` is always a multiple of
`PAGE_SIZE` from Nuvio, `page = Math.floor(skip / ANILIST_PER_PAGE) + 1` is exact.
Implement that, and have the *service* (Task 8) do the two-page stitching.
`perPage` is always `ANILIST_PER_PAGE`.

Sorts: `anime-trending` → `['TRENDING_DESC']`; `anime-top-rated` → `['SCORE_DESC']`;
`anime-search` → `['SEARCH_MATCH']`.

- [ ] **Step 4: Implement `src/sources/anilist/adapter.ts`**

- `limiter.tryAcquire()` false → `throw new SourceError('rate_limited', 'anilist limiter empty')`.
- Body: `JSON.stringify({ query, variables })`, `Content-Type: application/json`.
- `pageInfo.perPage` from the response, not the request (it may be clamped).
- `search` and `fetchCatalogPage`: `data.media === null` → `SourceError('not_found')`.
  This is deliberate — an exhausted/filtered page is not a transient failure.
- **Discriminate on `data.Media` before ever consulting `errors[]`.** AniList
  answers an unknown id with **both** `errors[{status:404}]` **and**
  `data.Media: null`, so a naive "errors present → throw" rule turns a not-found
  into an exception and breaks the `fetchById` contract below. Order:
  1. `data?.Media == null` on a `fetchById` → return `null` (**not** an error),
     regardless of any `errors[]` alongside it.
  2. Otherwise, if `errors[]` is non-empty → `SourceError('invalid_request',
     errors[0].message, errors[0].status)`. A malformed query lands here because
     it returns `data: null` with `status: 400` and no `Media` key.
  3. A 429-shaped GraphQL error maps to `'rate_limited'`.
- `fetchById`: `data.Media === null` → return `null` (**not** an error). This is
  the fixture-pinned Review Focus #2 case.
- `fetchByIds`: post `Media(id_in: …)` in chunks of 50 (verified supported) and
  filter out nulls. Phase 1 test coverage for this is one call; it earns its keep
  in Phase 2.
- Normalise everything with `normalizeMedia(..., { titleLang })`. `titleLang`
  arrives via constructor `deps.titleLang` defaulting to `'english'`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/anilist-adapter.test.ts` → Expected: 15 passed

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: AniList adapter and Phase 1 catalog definitions"
```

---

### Task 8: Catalogue service — pagination, caching, search

**Files:**
- Create: `src/services/catalog.service.ts`
- Create: `test/catalog-service.test.ts`

**Interfaces:**
- Consumes: `AnimeSource` (the local structural type declared below),
  `CATALOG_DEFS`, `PAGE_SIZE`, `ANILIST_PER_PAGE` (Task 7);
  `TTLCache` (Task 4); `Anime` (Task 5); `SourceError` (Task 3)
- Produces:
  - `src/services/catalog.service.ts`:
    - `export interface AnimeSource { fetchCatalogPage(q: AniListPageQuery): Promise<{ items: Anime[]; total: number }>; search(term: string, page: number): Promise<{ items: Anime[]; total: number }> }` (exported from here so the adapter in Task 7 structurally satisfies it without a circular import)
    - `export const CATALOG_TTL_MS = 15 * 60 * 1000`
    - `export const CATALOG_STALE_MS = 6 * 60 * 60 * 1000`
    - `export const SEARCH_TTL_MS = 30 * 60 * 1000`
    - `interface CatalogPageResult { items: Anime[]; cacheMaxAge: number; freshness: 'fresh' | 'stale' }`
    - `class CatalogService { constructor(deps: { source: AnimeSource; cache: TTLCache; log?: Logger }); getCatalogPage(args: { catalogId: string; type: string; genre?: string; skip: number }): Promise<CatalogPageResult>; search(args: { term: string; skip: number }): Promise<CatalogPageResult> }`

- [ ] **Step 1: Write the failing service test**

`test/catalog-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogService } from '../src/services/catalog.service.js';
import { TTLCache } from '../src/cache/store.js';
import { PAGE_SIZE } from '../src/sources/catalog-def.js';

const ids = (items: { identity: { anilist: number } }[]) => items.map(i => i.identity.anilist);
const mk = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ identity: { anilist: from + i } })) as never;

function svc(source: unknown, cache = new TTLCache()) {
  return { s: new CatalogService({ source: source as never, cache }), cache, source };
}

describe('CatalogService.getCatalogPage', () => {
  it('returns exactly 100 items for skip=0 using two AniList pages', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValueOnce({ items: mk(50), total: 5000 })
                                                .mockResolvedValueOnce({ items: mk(50, 50), total: 5000 }),
                     search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(r.items).toHaveLength(PAGE_SIZE);
    expect(source.fetchCatalogPage).toHaveBeenCalledTimes(2);
    expect(ids(r.items)).toHaveLength(100);
  });

  it('slices [skip, skip+100) so skip=100 shares no ids with skip=0', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ identity: { anilist: i + 1 } }));
    const source = {
      fetchCatalogPage: vi.fn(async ({ page }: { page: number }) =>
        ({ items: all.slice((page - 1) * 50, page * 50) as never, total: 5000 })),
      search: vi.fn(),
    };
    const { s } = svc(source);
    const p0 = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    const p1 = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 100 });
    expect(p0.items).toHaveLength(100);
    expect(p1.items).toHaveLength(100);
    expect(ids(p1.items).some(id => ids(p0.items).includes(id))).toBe(false);
    expect(ids(p1.items)[0]).toBe(101);
  });

  it('returns a short final page rather than padding', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ identity: { anilist: i + 1 } }));
    const source = {
      fetchCatalogPage: vi.fn(async ({ page }: { page: number }) =>
        ({ items: all.slice((page - 1) * 50, page * 50) as never, total: 120 })),
      search: vi.fn(),
    };
    const { s } = svc(source);
    expect((await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 100 })).items).toHaveLength(20);
  });

  it('returns an empty page past the end so pagination terminates', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: [], total: 120 }), search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 5000 });
    expect(r.items).toEqual([]);
    expect(r.cacheMaxAge).toBeLessThanOrEqual(60);
  });

  it('does NOT pad a short page back to 100 items', async () => {
    // A short page means the end of the list; padding would make Nuvio's nextSkip
    // point past data and strand the user on an empty page.
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: mk(12), total: 5000 }), search: vi.fn() };
    const { s } = svc(source);
    expect((await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 })).items).toHaveLength(12);
  });

  it('caches by catalog+skip so a repeated skip yields identical ids', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: mk(50), total: 5000 }), search: vi.fn() };
    const { s } = svc(source);
    const a = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    const b = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(ids(a.items)).toEqual(ids(b.items));
    expect(source.fetchCatalogPage).toHaveBeenCalledTimes(2); // second call served from cache
  });

  it('keys the cache by genre as well as catalog and skip', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: mk(50), total: 5000 }), search: vi.fn() };
    const { s } = svc(source);
    await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0, genre: 'Action' });
    expect(source.fetchCatalogPage).toHaveBeenCalledTimes(4);
  });

  it('rejects an unknown catalog id without touching the source', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-nope', type: 'anime', skip: 0 });
    expect(r.items).toEqual([]);
    expect(source.fetchCatalogPage).not.toHaveBeenCalled();
  });

  it('rejects a mismatched type without touching the source', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn() };
    const { s } = svc(source);
    expect((await s.getCatalogPage({ catalogId: 'anime-trending', type: 'movie', skip: 0 })).items).toEqual([]);
    expect(source.fetchCatalogPage).not.toHaveBeenCalled();
  });

  it('serves stale from the cache when the source throws', async () => {
    let fail = false;
    const source = {
      fetchCatalogPage: vi.fn(async () => {
        if (fail) throw Object.assign(new Error('down'), { kind: 'server_error' });
        return { items: mk(50), total: 5000 };
      }),
      search: vi.fn(),
    };
    let now = 0;
    const cache = new TTLCache({ now: () => now });
    const { s } = svc(source, cache);
    const first = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    fail = true;
    now += 20 * 60 * 1000; // past the 15-minute TTL, inside the 6-hour stale window
    const second = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(second.freshness).toBe('stale');
    expect(ids(second.items)).toEqual(ids(first.items));
  });

  it('returns an empty page, not an exception, when the source fails with no cache', async () => {
    const source = { fetchCatalogPage: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { kind: 'timeout' })), search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(r.items).toEqual([]);
  });
});

describe('CatalogService.search', () => {
  it('returns items for a term', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn().mockResolvedValue({ items: mk(3), total: 3 }) };
    const { s } = svc(source);
    expect((await s.search({ term: 'cowboy bebop', skip: 0 })).items).toHaveLength(3);
    expect(source.search).toHaveBeenCalledWith('cowboy bebop', 1);
  });

  it('returns empty without calling the source for a blank term', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn() };
    const { s } = svc(source);
    expect((await s.search({ term: '   ', skip: 0 })).items).toEqual([]);
    expect(source.search).not.toHaveBeenCalled();
  });

  it('truncates a very long term to 200 characters', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    const { s } = svc(source);
    await s.search({ term: 'x'.repeat(500), skip: 0 });
    expect(String(source.search.mock.calls[0]![0]).length).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/catalog-service.test.ts`
Expected: FAIL — `Cannot find module '../src/services/catalog.service.js'`

- [ ] **Step 3: Implement `src/services/catalog.service.ts`**

`getCatalogPage` algorithm:

1. `def = CATALOG_DEFS[catalogId]`; if missing **or** `def.type !== type` →
   return `{ items: [], cacheMaxAge: 60, freshness: 'fresh' }` with no source call.
2. Negative or non-finite `skip` → coerce to `0`.
3. Cache key `` `catalog:${catalogId}:${genre ?? ''}:${skip}` ``.
4. `cache.wrap(key, { ttlMs: CATALOG_TTL_MS, staleMs: CATALOG_STALE_MS }, loader)`
   where `loader` fetches the AniList pages needed for `[skip, skip+100)`:
   `firstPage = Math.floor(skip / 50) + 1`; fetch pages until 100 items are
   collected or a page comes back short/empty. **Never pad.** Return
   `{ items, total }`.
5. Wrap the whole call in try/catch: on `SourceError` (or anything) return
   `{ items: [], cacheMaxAge: 10, freshness: 'fresh' }` and `log.error`.

`search` algorithm: trim the term; if blank → empty page, **no source call**;
truncate to 200 chars; key `` `search:${term}:${skip}` ``; `cache.wrap` with
`SEARCH_TTL_MS`; map upstream page `Math.floor(skip / 50) + 1`.

`cacheMaxAge` derivation, which the handler turns into a header:
`fresh` → `900` (or `1800` for search); `stale` → `30`; empty page → `60`;
error path → `10`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/catalog-service.test.ts` → Expected: 14 passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: catalogue service with skip paging, page cache and stale serving"
```

---

### Task 9: Meta service

**Files:**
- Create: `src/services/meta.service.ts`
- Create: `test/meta-service.test.ts`

**Interfaces:**
- Consumes: `AnimeSource` (Task 8), `AniListSource.fetchById` (Task 7),
  `TTLCache` (Task 4), `Anime` (Task 5), `SourceError` (Task 3)
- Produces:
  - `export const META_TTL_MS = 7 * 24 * 60 * 60 * 1000`
  - `export const META_STALE_MS = 30 * 24 * 60 * 60 * 1000`
  - `export interface MetaResult { anime: Anime | null; cacheMaxAge: number; freshness: 'fresh' | 'stale' }`
  - `class MetaService { constructor(deps: { source: { fetchById(id: number): Promise<Anime | null> }; cache: TTLCache; log?: Logger }); getByAnilistId(id: number): Promise<MetaResult> }`

- [ ] **Step 1: Write the failing test**

`test/meta-service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { MetaService } from '../src/services/meta.service.js';
import { TTLCache } from '../src/cache/store.js';

const onePiece = { identity: { anilist: 21 }, displayTitle: 'ONE PIECE' } as never;

describe('MetaService.getByAnilistId', () => {
  it('returns the anime for a known id', async () => {
    const source = { fetchById: vi.fn().mockResolvedValue(onePiece) };
    const r = await new MetaService({ source, cache: new TTLCache() }).getByAnilistId(21);
    expect(r.anime!.identity.anilist).toBe(21);
  });

  it('returns anime === null for an unknown id, never an exception', async () => {
    const source = { fetchById: vi.fn().mockResolvedValue(null) };
    const r = await new MetaService({ source, cache: new TTLCache() }).getByAnilistId(99999999);
    expect(r.anime).toBeNull();
    expect(r.cacheMaxAge).toBeLessThanOrEqual(60);
  });

  it('returns anime === null for a non-positive or non-integer id without calling the source', async () => {
    const source = { fetchById: vi.fn() };
    const s = new MetaService({ source, cache: new TTLCache() });
    expect((await s.getByAnilistId(0)).anime).toBeNull();
    expect((await s.getByAnilistId(-5)).anime).toBeNull();
    expect((await s.getByAnilistId(Number.NaN)).anime).toBeNull();
    expect(source.fetchById).not.toHaveBeenCalled();
  });

  it('caches a successful lookup', async () => {
    const source = { fetchById: vi.fn().mockResolvedValue(onePiece) };
    const s = new MetaService({ source, cache: new TTLCache() });
    await s.getByAnilistId(21);
    await s.getByAnilistId(21);
    expect(source.fetchById).toHaveBeenCalledTimes(1);
  });

  it('does not cache a null lookup as a hit, so a new id resolves later', async () => {
    const source = { fetchById: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(onePiece) };
    const s = new MetaService({ source, cache: new TTLCache() });
    expect((await s.getByAnilistId(5)).anime).toBeNull();
    expect((await s.getByAnilistId(5)).anime).not.toBeNull();
  });

  it('serves stale meta when the source throws', async () => {
    let fail = false;
    const source = { fetchById: vi.fn(async () => {
      if (fail) throw Object.assign(new Error('down'), { kind: 'server_error' });
      return onePiece;
    }) };
    let now = 0;
    const cache = new TTLCache({ now: () => now });
    const s = new MetaService({ source, cache });
    await s.getByAnilistId(21);
    fail = true;
    now += 8 * 24 * 60 * 60 * 1000; // past the 7-day TTL, inside the 30-day stale window
    const r = await s.getByAnilistId(21);
    expect(r.freshness).toBe('stale');
    expect(r.anime!.identity.anilist).toBe(21);
  });

  it('returns anime === null and never throws when the source fails with no cache', async () => {
    const source = { fetchById: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { kind: 'timeout' })) };
    const r = await new MetaService({ source, cache: new TTLCache() }).getByAnilistId(21);
    expect(r.anime).toBeNull();
    expect(r.cacheMaxAge).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/meta-service.test.ts`
Expected: FAIL — `Cannot find module '../src/services/meta.service.js'`

- [ ] **Step 3: Implement `src/services/meta.service.ts`**

- Validate the id first: `Number.isInteger(id) && id > 0`, else return
  `{ anime: null, cacheMaxAge: 10, freshness: 'fresh' }` **without** a source call.
- Cache key `` `meta:anilist:${id}` `` with `META_TTL_MS` / `META_STALE_MS`.
- The loader returns `Anime | null`. `null` is cached with a **60 s** TTL by
  calling `cache.set` explicitly rather than through `wrap`, so a null never
  occupies a 7-day slot.
- On `SourceError` or any throw: if a stale value exists in the cache, return it
  with `freshness: 'stale'`; otherwise return `anime: null, cacheMaxAge: 10`.
  Never rethrow.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/meta-service.test.ts` → Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: meta service with 7-day cache and 30-day stale window"
```

---

### Task 10: Renderers — Anime to Stremio JSON

**Files:**
- Create: `src/render/types.ts`, `src/render/preview.ts`, `src/render/detail.ts`
- Create: `test/render.test.ts`

**Interfaces:**
- Consumes: `Anime`, `stremioIdFor` (Task 5), `AnimeTitle` (Task 5)
- Produces:
  - `src/render/types.ts` — extended Stremio types (see below)
  - `src/render/preview.ts` — `renderPreview(a: Anime): StremioMetaPreview`
  - `src/render/detail.ts` — `renderDetail(a: Anime): StremioMetaDetail`

- [ ] **Step 1: Write the failing render test**

`test/render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeMedia } from '../src/normalize/anime.js';
import { renderPreview, renderDetail } from '../src/render/index.js';
import type { AniListMedia } from '../src/sources/anilist/types.js';

const raw = (JSON.parse(
  readFileSync(new URL('./fixtures/meta-21.json', import.meta.url), 'utf8'),
) as { data: { Media: AniListMedia } }).data.Media!;

const anime = normalizeMedia(raw, { titleLang: 'english' });

describe('renderPreview', () => {
  const p = renderPreview(anime);

  it('always emits non-blank id, type and name, the three Nuvio requires', () => {
    expect(p.id).toBe('anilist:21');
    expect(p.type).toBe('anime');
    expect(p.name.trim()).toBe('ONE PIECE');
  });

  it('prefixes the id so Nuvio does not read it as a Trakt id', () => {
    expect(p.id).toMatch(/^anilist:\d+$/);
  });

  it('emits banner as well as background; Nuvio prefers banner', () => {
    expect(p.banner).toBe(anime.images.background);
    expect(p.background).toBe(anime.images.background);
  });

  it('formats imdbRating as a string, because Nuvio reads it as one', () => {
    expect(typeof p.imdbRating).toBe('string');
    expect(Number(p.imdbRating)).toBeGreaterThan(0);
    expect(Number(p.imdbRating)).toBeLessThanOrEqual(10);
  });

  it('never includes internal underscore-prefixed fields', () => {
    for (const k of Object.keys(p)) expect(k.startsWith('_')).toBe(false);
  });

  it('omits optional fields rather than emitting undefined keys', () => {
    const bare = renderPreview(normalizeMedia({ id: 7 } as AniListMedia, { titleLang: 'english' }));
    expect(JSON.parse(JSON.stringify(bare))).not.toHaveProperty('description');
    expect(bare.name).toBe('Untitled');
  });
});

describe('renderDetail', () => {
  const d = renderDetail(anime);

  it('emits both country and countryOfOrigin for Nuvio and the Stremio spec', () => {
    expect(d.country).toBe('JP');
    expect(d.countryOfOrigin).toBe('JP');
  });

  it('emits both language and audioLanguage', () => {
    expect(d.language).toBeDefined();
    expect(d.audioLanguage).toBe(d.language);
  });

  it('includes required id, type and name', () => {
    expect(d.id).toBe('anilist:21');
    expect(d.type).toBe('anime');
    expect(d.name.trim()).toBe('ONE PIECE');
  });

  it('emits links with all three of name, category and url', () => {
    expect(d.links!.length).toBeGreaterThan(0);
    for (const l of d.links!) {
      expect(l.name).toBeTruthy();
      expect(l.category).toBeTruthy();
      expect(l.url).toMatch(/^https?:\/\//);
    }
    expect(d.links!.map(l => l.category)).toContain('AniList');
    expect(d.links!.map(l => l.category)).toContain('MyAnimeList');
  });

  it('emits an AniList link built from the canonical id', () => {
    expect(d.links!.find(l => l.category === 'AniList')!.url).toBe('https://anilist.co/anime/21');
  });

  it('omits the MyAnimeList link when idMal is absent', () => {
    const noMal = renderDetail(normalizeMedia({ ...raw, idMal: null }, { titleLang: 'english' }));
    expect(noMal.links!.map(l => l.category)).not.toContain('MyAnimeList');
  });

  it('emits an empty videos array in Phase 1, never undefined', () => {
    expect(d.videos).toEqual([]);
  });

  it('omits runtime rather than inventing one when duration is unknown', () => {
    const noDur = renderDetail(normalizeMedia({ ...raw, duration: null }, { titleLang: 'english' }));
    expect(noDur.runtime).toBeUndefined();
    const withDur = renderDetail(normalizeMedia({ ...raw, duration: 24 }, { titleLang: 'english' }));
    expect(withDur.runtime).toBe('24 min');
  });

  it('emits genres as a plain string array', () => {
    expect(Array.isArray(d.genres)).toBe(true);
    for (const g of d.genres!) expect(typeof g).toBe('string');
  });

  it('serialises to JSON without throwing on a minimal Anime', () => {
    expect(() => JSON.stringify(renderDetail(normalizeMedia({ id: 1 } as AniListMedia, { titleLang: 'english' })))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/render.test.ts`
Expected: FAIL — `Cannot find module '../src/render/index.js'`

- [ ] **Step 3: Implement `src/render/types.ts`**

Extend the SDK's types rather than replacing them, so the handler stays assignable:

```ts
import type { MetaPreview, MetaDetail } from 'stremio-addon-sdk';

export interface StremioMetaPreview extends MetaPreview {
  banner?: string;
  landscapePoster?: string;
}
export interface StremioMetaDetail extends MetaDetail {
  banner?: string;
  country?: string;
  countryOfOrigin?: string;
  language?: string;
  audioLanguage?: string;
  hashtags?: string[];
  videos: StremioMetaVideo[];
}
export interface StremioMetaVideo {
  id: string; title: string; released?: string; season?: number; episode?: number;
  overview?: string; thumbnail?: string; runtime?: number;
}
```

No `any`. Use `Omit<MetaDetail, 'videos'>` for the detail base if TS complains
about `videos` incompatibility.

- [ ] **Step 4: Implement `src/render/preview.ts`**

`renderPreview(a: Anime): StremioMetaPreview` emits only: `id` (`stremioIdFor`),
`type`, `name` (`displayTitle`), `poster`, `posterShape: 'poster'`, `banner`,
`background`, `description`, `releaseInfo`, `released`, `imdbRating`,
`genres`. **Omit any key whose value is `undefined`** — build the object then
strip `undefined` values before returning, so `JSON.stringify` emits no
`undefined` keys.

`imdbRating`: `scoreAnilist != null ? (scoreAnilist / 10).toFixed(1) : undefined`
— AniList's 0–100 becomes a 0–10 **string**.

`releaseInfo`: `releaseYear != null ? String(releaseYear) : undefined`.
`released`: `releaseDate ?? undefined`.

- [ ] **Step 5: Implement `src/render/detail.ts`**

`renderDetail(a: Anime): StremioMetaDetail` emits everything in `renderPreview`
plus: `logo` (from `a.images.logo`, undefined in Phase 1 — AniList has no logo, TMDB
arrives Phase 4), `runtime` (`` `${a.durationMinutes} min` `` or undefined),
`status`, `country` + `countryOfOrigin` (both = `a.countryOfOrigin ?? undefined`;
AniList is the only source for this in Phase 1), `language` + `audioLanguage`
(both = `'ja'` when `a.countryOfOrigin === 'JP'`, else `undefined`; **do not**
invent a language value), `hashtags`, `awards` (undefined), `links`, `videos: []`.

`links` construction:
- `{ name: 'AniList', category: 'AniList', url: `https://anilist.co/anime/${id}` }`
- when `identity.mal != null`: `{ name: 'MyAnimeList', category: 'MyAnimeList', url: `https://myanimelist.net/anime/${mal}` }`
- `behaviorHints` is omitted in Phase 1 (no videos, no default video id).

- [ ] **Step 6: Add `src/render/index.ts` re-exporting both renderers**

```ts
export { renderPreview } from './preview.js';
export { renderDetail } from './detail.js';
export type { StremioMetaPreview, StremioMetaDetail, StremioMetaVideo } from './types.js';
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run test/render.test.ts` → Expected: 15 passed

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: render Anime into Stremio preview and detail payloads"
```

---

### Task 11: Config

**Files:**
- Create: `src/config/index.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type TitleLang = 'english' | 'romaji' | 'native'`
  - `export interface RequestConfig { titleLang: TitleLang }`
  - `export interface AppConfig { port: number; logLevel: 'debug'|'info'|'warn'|'error'; anilistRateLimitPerMinute: number; httpTimeoutMs: number; cacheMaxEntries: number }`
  - `loadAppConfig(env?: NodeJS.ProcessEnv): AppConfig`
  - `parseRequestConfig(query: string | URLSearchParams | undefined): RequestConfig`

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadAppConfig, parseRequestConfig } from '../src/config/index.js';

describe('parseRequestConfig', () => {
  it('defaults titleLang to english', () => {
    expect(parseRequestConfig(undefined).titleLang).toBe('english');
    expect(parseRequestConfig('').titleLang).toBe('english');
  });
  it('accepts the documented values and rejects anything else', () => {
    expect(parseRequestConfig('titleLang=romaji').titleLang).toBe('romaji');
    expect(parseRequestConfig('titleLang=native').titleLang).toBe('native');
    expect(parseRequestConfig('titleLang=klingon').titleLang).toBe('english');
  });
  it('never reads a secret from the query string', () => {
    const c = parseRequestConfig('TMDB_API_KEY=leak&ANILIST_TOKEN=leak2&titleLang=romaji');
    expect(Object.keys(c)).toEqual(['titleLang']);
  });
});

describe('loadAppConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadAppConfig({});
    expect(c.port).toBe(7000);
    expect(c.logLevel).toBe('info');
    expect(c.anilistRateLimitPerMinute).toBe(25);
    expect(c.httpTimeoutMs).toBe(3500);
    expect(c.cacheMaxEntries).toBe(10000);
  });
  it('reads overrides from the environment', () => {
    const c = loadAppConfig({ PORT: '8080', LOG_LEVEL: 'debug', ANILIST_RATE_LIMIT: '20',
                              HTTP_TIMEOUT_MS: '2000', CACHE_MAX_ENTRIES: '50' });
    expect(c.port).toBe(8080);
    expect(c.logLevel).toBe('debug');
    expect(c.anilistRateLimitPerMinute).toBe(20);
    expect(c.httpTimeoutMs).toBe(2000);
    expect(c.cacheMaxEntries).toBe(50);
  });
  it('falls back to the default for a non-numeric or invalid value', () => {
    expect(loadAppConfig({ PORT: 'abc' }).port).toBe(7000);
    expect(loadAppConfig({ LOG_LEVEL: 'shout' }).logLevel).toBe('info');
    expect(loadAppConfig({ ANILIST_RATE_LIMIT: '-1' }).anilistRateLimitPerMinute).toBe(25);
  });
  it('keeps the HTTP timeout under Nuvio\'s 5s meta budget', () => {
    expect(loadAppConfig({ HTTP_TIMEOUT_MS: '99999' }).httpTimeoutMs).toBeLessThanOrEqual(4000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/config/index.ts`**

`parseRequestConfig` accepts a string or `URLSearchParams`, reads **only**
`titleLang`, validates against the three values, defaults to `'english'`, and
returns an object whose only key is `titleLang`.

`loadAppConfig` uses a `readInt(env, key, fallback)` helper that returns the
fallback for anything non-numeric or `< 1`, and `readEnum` likewise.
`httpTimeoutMs` is additionally clamped to `<= 4000` — Nuvio's own meta timeout is
5000 ms, so a longer upstream timeout could never help.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/config.test.ts` → Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: env and query-string configuration"
```

---

### Task 12: Manifest builder

**Files:**
- Create: `src/addon/manifest.ts`
- Create: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `CATALOG_DEFS` (Task 7)
- Produces:
  - `export const ADDON_ID = 'org.anicata.anime'`
  - `export const ADDON_NAME = 'AniCata Anime'`
  - `buildManifest(version: string): Manifest`

- [ ] **Step 1: Write the failing manifest test**

`test/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addonBuilder } from 'stremio-addon-sdk';
import { buildManifest, ADDON_ID, ADDON_NAME } from '../src/addon/manifest.js';

const m = buildManifest('0.1.0');

describe('buildManifest', () => {
  it('carries the three fields Nuvio requires or install fails', () => {
    expect(m.id).toBe(ADDON_ID);
    expect(m.name).toBe(ADDON_NAME);
    expect(m.version).toBe('0.1.0');
  });

  it('fits the SDK\'s 8kb limit', () => {
    expect(JSON.stringify(m).length).toBeLessThanOrEqual(8192);
  });

  it('passes the SDK linter and handler-coverage check', () => {
    expect(() => addonBuilder(m)).not.toThrow();
  });

  it('declares meta as an object resource with anilist: and kitsu: idPrefixes', () => {
    const meta = m.resources.find(r => typeof r === 'object' && r.name === 'meta') as
      { name: string; types: string[]; idPrefixes: string[] };
    expect(meta).toBeDefined();
    expect(meta.idPrefixes).toContain('anilist:');
    expect(meta.idPrefixes).toContain('kitsu:');
    expect(meta.types).toEqual(expect.arrayContaining(['anime', 'movie']));
  });

  it('does not leak idPrefixes onto the catalog resource', () => {
    const cat = m.resources.find(r => r === 'catalog');
    expect(typeof cat === 'object' ? (cat as { idPrefixes?: string[] }).idPrefixes : undefined).toBeUndefined();
  });

  it('declares exactly the three Phase 1 catalogues', () => {
    expect(m.catalogs!.map(c => c.id).sort()).toEqual(
      ['anime-search', 'anime-top-rated', 'anime-trending']);
  });

  it('gives every catalogue a skip extra and no required extra, so all reach Home', () => {
    for (const c of m.catalogs!) {
      expect(c.extra!.some(e => e.name === 'skip')).toBe(true);
      expect(c.extra!.every(e => e.isRequired !== true)).toBe(true);
    }
  });

  it('declares search on exactly one catalogue, because Nuvio fans out per catalogue', () => {
    const searchable = m.catalogs!.filter(c => c.extra!.some(e => e.name === 'search'));
    expect(searchable.map(c => c.id)).toEqual(['anime-search']);
  });

  it('points logo at a path our own server serves', () => {
    expect(m.logo).toBe('/logo.png');
  });

  it('does not advertise resources we do not implement', () => {
    const names = m.resources.map(r => (typeof r === 'object' ? r.name : r));
    expect(names.sort()).toEqual(['catalog', 'meta']);
  });

  it('sets behaviourHints with adult false because isAdult is hard-filtered', () => {
    expect(m.behaviorHints).toEqual({
      configurable: false, configurationRequired: false, adult: false, p2p: false,
    });
  });
});
```

The `search`-on-one-catalogue test is the guard against the Nuvio fan-out
described in `docs/catalog-design.md` §6.1: adding `search` to another catalogue
would multiply upstream requests per user search.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/manifest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/addon/manifest.ts`**

```ts
import type { Manifest } from 'stremio-addon-sdk';
import { CATALOG_DEFS } from '../sources/catalog-def.js';

export const ADDON_ID = 'org.anicata.anime';
export const ADDON_NAME = 'AniCata Anime';

export function buildManifest(version: string): Manifest {
  return {
    id: ADDON_ID,
    version,
    name: ADDON_NAME,
    description: 'Anime catalogues and metadata from AniList, with Kitsu fallback.',
    logo: '/logo.png',
    types: ['anime', 'movie'],
    idPrefixes: ['anilist:', 'kitsu:'],
    resources: [
      'catalog',
      { name: 'meta', types: ['anime', 'movie'], idPrefixes: ['anilist:', 'kitsu:'] },
    ],
    catalogs: Object.values(CATALOG_DEFS).map(def => ({
      type: def.type,
      id: def.id,
      name: def.name,
      extra: def.supportsSearch
        ? [{ name: 'skip' }, { name: 'search' }]
        : [{ name: 'skip' }],
    })),
    behaviorHints: {
      configurable: false, configurationRequired: false, adult: false, p2p: false,
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/manifest.test.ts` → Expected: 11 passed

If `Manifest` types reject `idPrefixes` on a resource object or `logo` as a
relative string, widen the local variable to
`Manifest & { idPrefixes?: string[] }` rather than casting to `any`, and note the
SDK typing gap in a comment.

- [ ] **Step 5: Write the failing manifest-size-guard test**

Append to `test/manifest.test.ts`:

```ts
import { assertManifestFits } from '../src/addon/manifest.js';

it('throws for a manifest that would exceed the 8kb addonCollection limit', () => {
  const tooBig = {
    ...buildManifest('0.1.0'),
    catalogs: Array.from({ length: 60 }, (_, i) => ({
      type: 'anime', id: `anime-catalog-${i}`, name: `Catalog ${i}`,
      extra: [{ name: 'skip' }],
    })),
  };
  expect(() => assertManifestFits(tooBig as never)).toThrow(/8192|8kb/i);
});

it('accepts the real Phase 1 manifest', () => {
  expect(() => assertManifestFits(buildManifest('0.1.0'))).not.toThrow();
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/manifest.test.ts`
Expected: FAIL — `assertManifestFits` is not exported

- [ ] **Step 7: Implement the guard so a future catalogue cannot break startup**

In `src/addon/manifest.ts`, export

```ts
export function assertManifestFits(manifest: Manifest): void {
  const bytes = JSON.stringify(manifest).length;
  if (bytes > 8192) {
    throw new Error(`manifest size ${bytes} exceeds 8192 bytes (8kb SDK limit)`);
  }
}
```

and call it as the last statement of `buildManifest` before returning.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run test/manifest.test.ts` → Expected: 13 passed

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: manifest builder with Nuvio-required routing and gating"
```

---

### Task 13: Catalog handler

**Files:**
- Create: `src/addon/catalog.ts`
- Create: `test/helpers/serve.ts`

**Interfaces:**
- Consumes: `CatalogService` (Task 8), `renderPreview` (Task 10), `buildManifest` (Task 12)
- Produces:
  - `parseExtra(extra: Record<string, string | string[]> | undefined): { search?: string; genre?: string; skip: number }`
  - `createCatalogHandler(deps: { catalogService: CatalogService }): CatalogHandler`
  - `test/helpers/serve.ts` — `startServer(): Promise<{ url: string; close(): Promise<void> }>` which boots the real express app on port 0

- [ ] **Step 1: Write the failing extras test**

```ts
// appended to test/handlers.test.ts in this task
import { describe, it, expect } from 'vitest';
import { parseExtra } from '../src/addon/catalog.js';

describe('parseExtra', () => {
  it('defaults skip to 0 when absent', () => {
    expect(parseExtra(undefined).skip).toBe(0);
    expect(parseExtra({}).skip).toBe(0);
  });
  it('coerces skip from the string querystring delivers', () => {
    expect(parseExtra({ skip: '100' }).skip).toBe(100);
  });
  it('treats a non-numeric, negative or absent skip as 0', () => {
    expect(parseExtra({ skip: 'abc' }).skip).toBe(0);
    expect(parseExtra({ skip: '-5' }).skip).toBe(0);
    expect(parseExtra({ skip: '' }).skip).toBe(0);
  });
  it('takes the first value when a repeated key arrives as an array', () => {
    expect(parseExtra({ skip: ['100', '200'] }).skip).toBe(100);
  });
  it('preserves search and genre verbatim', () => {
    expect(parseExtra({ search: 'bebop', genre: 'Action' })).toMatchObject({ search: 'bebop', genre: 'Action' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/handlers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `parseExtra` and `createCatalogHandler`**

`parseExtra`: read `skip` via a `first(v)` helper (`Array.isArray(v) ? v[0] : v`),
then `Number.parseInt(...)`; fall back to `0` for `NaN` or a negative result.
`search`/`genre` pass through only when non-blank after trimming.

`createCatalogHandler` returns an async function:

1. `const { search, genre, skip } = parseExtra(args.extra)`
2. When `search` is present **and** `args.id === 'anime-search'`, delegate to
   `catalogService.search({ term: search, skip })`. Otherwise delegate to
   `catalogService.getCatalogPage({ catalogId: args.id, type: args.type, genre, skip })`.
   This two-path split is what keeps one upstream request per user search.
3. `const metas = result.items.map(renderPreview)`
4. Return `{ metas, cacheMaxAge: result.cacheMaxAge }` — the SDK turns the numeric
   `cacheMaxAge` into `Cache-Control: max-age=N, public`
   (`docs/sdk-reference.md` §7).
5. Wrap the whole body in try/catch. On any throw return
   `{ metas: [], cacheMaxAge: 10 }`. **Never rethrow and never return a
   non-200.**

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/handlers.test.ts` → Expected: 4 passed (parseExtra only)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: catalog handler with extras parsing and search routing"
```

---

### Task 14: Meta handler

**Files:**
- Create: `src/addon/meta.ts`
- Modify: `test/handlers.test.ts`

**Interfaces:**
- Consumes: `MetaService` (Task 9), `renderDetail` (Task 10)
- Produces:
  - `type ParsedMetaId = { namespace: 'anilist' | 'kitsu'; value: string }`
  - `parseMetaId(raw: string): ParsedMetaId | null` — `null` for anything unrecognised
  - `createMetaHandler(deps: { metaService: MetaService }): MetaHandler`

- [ ] **Step 1: Write the failing id-parsing tests**

Append to `test/handlers.test.ts`:

```ts
import { parseMetaId } from '../src/addon/meta.js';

describe('parseMetaId', () => {
  it('parses anilist:21', () => {
    expect(parseMetaId('anilist:21')).toEqual({ namespace: 'anilist', value: '21' });
  });
  it('parses kitsu:12', () => {
    expect(parseMetaId('kitsu:12')).toEqual({ namespace: 'kitsu', value: '12' });
  });
  it('ignores a Stremio video suffix of :season:episode', () => {
    expect(parseMetaId('anilist:21:1:5')).toEqual({ namespace: 'anilist', value: '21' });
  });
  it('rejects a bare number, which Nuvio would have read as a Trakt id', () => {
    expect(parseMetaId('21')).toBeNull();
  });
  it('rejects a blank or malformed id', () => {
    expect(parseMetaId('')).toBeNull();
    expect(parseMetaId('anilist:')).toBeNull();
    expect(parseMetaId('anilist:abc')).toBeNull();
    expect(parseMetaId(':21')).toBeNull();
    expect(parseMetaId('imdb:tt0388629')).toBeNull(); // Phase 1 supports anilist/kitsu only
    expect(parseMetaId('tt0388629')).toBeNull();
  });
  it('is case-sensitive about the namespace', () => {
    expect(parseMetaId('AniList:21')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/handlers.test.ts`
Expected: FAIL — `parseMetaId` not exported

- [ ] **Step 3: Implement `src/addon/meta.ts`**

`parseMetaId(raw)`: trim. Split on `:`. Require exactly 2 or 3 segments with a
recognised, **case-sensitive** namespace in `{'anilist','kitsu'}`. Require
`/^\d+$/` on the value. With 3 segments, require the last two to be integers
(the `:season:episode` suffix) and use segment 1 as the value. Otherwise `null`.

`createMetaHandler`:

1. `const parsed = parseMetaId(args.id)`
2. If `parsed === null`, return
   `{ meta: { id: args.id, type: args.type, name: 'Unavailable' }, cacheMaxAge: 60 }`
   **with zero service calls** — an unusable id must not reach the network.
3. If `parsed.namespace === 'anilist'`, call
   `metaService.getByAnilistId(Number(parsed.value))`.
4. If `parsed.namespace === 'kitsu'`, return the same minimal shape — Kitsu
   resolution arrives in Phase 3, so Phase 1 must not pretend to support it.
5. When `result.anime` is `null`, return the minimal shape
   `{ id: args.id, type: args.type, name: 'Unavailable' }` with `cacheMaxAge: 60`.
   This is what makes an unknown id a clean "no results" in Nuvio rather than a
   parse failure that silently drops the add-on.
6. Otherwise return `{ meta: renderDetail(result.anime), cacheMaxAge: result.cacheMaxAge }`.
7. Wrap in try/catch returning the minimal shape with `cacheMaxAge: 10`. Never throw.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/handlers.test.ts` → Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: meta handler with strict id parsing and no-throw guarantees"
```

---

### Task 15: Composition root and HTTP integration tests

**Files:**
- Create: `src/index.ts`, `test/helpers/serve.ts`, `test/integration.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `src/index.ts` — `export function createApp(overrides?: Partial<AppDeps>): express.Express`, `export function start(): void`, plus a `main()` guard that calls `start()` only when run directly
  - `test/helpers/serve.ts` — `startServer(app?): Promise<{ url: string; close(): Promise<void> }>`

- [ ] **Step 1: Write the integration helper**

`test/helpers/serve.ts`: `createServer(app).listen(0, '127.0.0.1')`, resolve the
port, return `{ url, close }` where `close()` returns a promise. Accept an
optional app so a test can inject fakes.

- [ ] **Step 2: Write the failing integration test**

`test/integration.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/index.js';
import type { Anime } from '../src/domain/anime.js';

const fake = (id: number, over: Partial<Anime> = {}): Anime => ({
  identity: { anilist: id }, title: { romaji: `T${id}`, english: `T${id}`, synonyms: [] },
  displayTitle: `T${id}`, description: 'desc', format: 'TV', status: 'FINISHED',
  type: 'anime', episodes: 12, durationMinutes: 24, releaseDate: '2020-01-01',
  releaseYear: 2020, genres: ['Action'], tags: [], studios: [],
  relations: [], images: { poster: `https://img/${id}.jpg`, background: `https://img/${id}b.jpg` },
  scoreAnilist: 80, hashtags: [], ...over,
});

const app = createApp({
  catalogService: {
    getCatalogPage: async ({ skip }) => ({ items: skip === 0 ? Array.from({ length: 100 }, (_, i) => fake(i + 1)) : [],
                                          cacheMaxAge: 900, freshness: 'fresh' }),
    search: async () => ({ items: [fake(1)], cacheMaxAge: 1800, freshness: 'fresh' }),
  } as never,
  metaService: { getByAnilistId: async (id: number) =>
    id === 21 ? { anime: fake(21), cacheMaxAge: 604800, freshness: 'fresh' }
              : { anime: null, cacheMaxAge: 60, freshness: 'fresh' } } as never,
});

describe('GET /manifest.json', () => {
  it('returns 200 with a valid manifest and a Cache-Control header', async () => {
    const res = await supertest(app).get('/manifest.json');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('org.anicata.anime');
    expect(res.body.name).toBeTruthy();
    expect(res.body.version).toBeTruthy();
    expect(res.headers['cache-control']).toContain('max-age=');
  });

  it('sets CORS headers, which the protocol requires', async () => {
    const res = await supertest(app).get('/manifest.json');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('serves the manifest logo at the path the manifest declares', async () => {
    const manifest = await supertest(app).get('/manifest.json');
    const logoPath = manifest.body.logo as string;
    expect(logoPath).toBe('/logo.png');
    const logo = await supertest(app).get(logoPath);
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toMatch(/^image\//);
    expect(logo.body.length).toBeGreaterThan(0);
  });
});

describe('GET /catalog/:type/:id.json', () => {
  it('returns exactly 100 metas for skip=0, each with id, type and name', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-trending.json');
    expect(res.status).toBe(200);
    expect(res.body.metas).toHaveLength(100);
    for (const m of res.body.metas) {
      expect(m.id).toMatch(/^anilist:\d+$/);
      expect(m.type).toBe('anime');
      expect(m.name.trim()).not.toBe('');
    }
  });

  it('emits banner alongside background', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-trending.json');
    expect(res.body.metas[0].banner).toBe(res.body.metas[0].background);
  });

  it('serves the skip extra as a path segment', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-trending.json/skip=100');
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([]);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('serves search as a path-segment extra', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-search.json/search=bebop');
    expect(res.status).toBe(200);
    expect(res.body.metas).toHaveLength(1);
  });

  it('returns an empty list for an unknown catalogue instead of a 404', async () => {
    const res = await supertest(app).get('/catalog/anime/does-not-exist.json');
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([]);
  });
});

describe('GET /meta/:type/:id.json', () => {
  it('resolves a percent-encoded anilist id', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A21.json');
    expect(res.status).toBe(200);
    expect(res.body.meta.id).toBe('anilist:21');
    expect(res.body.meta.name).toBe('T21');
  });

  it('emits both country spellings and both language spellings', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A21.json');
    expect(res.body.meta.country).toBeDefined();
    expect(res.body.meta.countryOfOrigin).toBe(res.body.meta.country);
    expect(res.body.meta.language).toBeDefined();
    expect(res.body.meta.audioLanguage).toBe(res.body.meta.language);
  });

  it('returns a 200 with id, type and name for an unknown id', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A99999999.json');
    expect(res.status).toBe(200);
    expect(res.body.meta.id).toBe('anilist:99999999');
    expect(res.body.meta.name).toBe('Unavailable');
  });

  it('returns a 200 for a bare numeric id rather than erroring', async () => {
    const res = await supertest(app).get('/meta/anime/21.json');
    expect(res.status).toBe(200);
    expect(res.body.meta.name).toBe('Unavailable');
  });

  it('emits links with name, category and url', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A21.json');
    for (const l of res.body.meta.links) {
      expect(l.name).toBeTruthy(); expect(l.category).toBeTruthy(); expect(l.url).toBeTruthy();
    }
  });
});

describe('never returns a non-200', () => {
  it('answers 200 with an empty list when the catalog service throws', async () => {
    const broken = createApp({
      catalogService: { getCatalogPage: async () => { throw new Error('boom'); },
                        search: async () => { throw new Error('boom'); } } as never,
    });
    for (const path of ['/catalog/anime/anime-trending.json',
                        '/catalog/anime/anime-search.json/search=x',
                        '/meta/anime/anilist%3A1.json',
                        '/meta/anime/garbage.json',
                        '/manifest.json']) {
      const res = await supertest(broken).get(path);
      expect(res.status, path).toBe(200);
    }
  });
});
```

The last block is the single most important test in Phase 1: it pins
**ADR-010** — no upstream failure may ever become a non-200.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 4: Implement `src/addon/…` wiring and `src/index.ts`**

`createApp(overrides)` composes, in order: `loadAppConfig(process.env)` →
`createLogger` → `HttpClient({ timeoutMs, userAgent })` →
`TokenBucket({ capacity: rateLimit, refillPerMinute: rateLimit })` →
`TTLCache({ maxEntries })` → `AniListSource({ http, limiter, log, titleLang })` →
`CatalogService` / `MetaService` (overridable via `overrides`) →
`addonBuilder(buildManifest(pkgVersion))` with
`defineCatalogHandler(createCatalogHandler(...))` and
`defineMetaHandler(createMetaHandler(...))` → `getRouter(builder)` mounted on a bare
express app.

**Mount `public/` as static assets**, otherwise the manifest's `logo: '/logo.png'`
404s and Nuvio shows a broken image in the add-on list:

```ts
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use('/', express.static(publicDir, { maxAge: '1d', fallthrough: true }));
```

Because `tsc` emits `dist/index.js` while `public/` stays at the repo root, resolve
the directory relative to `import.meta.url` as shown — **not** `process.cwd()`.

Read the version from `package.json` at build time via
`createRequire(import.meta.url)('./package.json').version`, not `process.env.npm_package_version`.

`start()` calls `serveHTTP(http.createServer(app), config.port, {})` and logs the
listen URL. Guard the direct-run case so importing the module in tests does not
bind a port:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/integration.test.ts` → Expected: 16 passed

- [ ] **Step 6: Run the full suite, typecheck and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green; `grep -rn "from '../sources/" src/services/` shows **no**
adapter imports, and `grep -rn "^import" src/domain/` shows nothing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: composition root and HTTP integration tests"
```

---

### Task 16: README and live smoke test

**Files:**
- Create: `README.md`, `test/live/anilist.live.test.ts`, `package.json` (add `test:live` glob if needed)
- Modify: `.env.example`

**Interfaces:**
- Consumes: the whole app
- Produces: install instructions and an opt-in live test

- [ ] **Step 1: Write the live smoke test**

`test/live/anilist.live.test.ts`, skipped unless `ANICATA_LIVE=1`:

```ts
import { describe, it, expect, skip } from 'vitest';
import { AniListSource } from '../../src/sources/anilist/adapter.js';
import { HttpClient } from '../../src/net/http.js';
import { TokenBucket } from '../../src/net/limiter.js';

const live = process.env.ANICATA_LIVE === '1' ? describe : describe.skip;

live('AniList live smoke', () => {
  const mk = () => new AniListSource({
    http: new HttpClient({ timeoutMs: 8000, userAgent: 'anicata-anime-addon/0.1' }),
    limiter: new TokenBucket({ capacity: 20, refillPerMinute: 20 }),
  });

  it('serves a catalogue page and clamps perPage to 50', async () => {
    const r = await mk().fetchCatalogPage({ sort: ['TRENDING_DESC'], page: 1, perPage: 50 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.identity.anilist).toBeTypeOf('number');
    expect(r.items[0]!.displayTitle.trim()).not.toBe('');
  }, 20_000);

  it('fetches One Piece and returns id 21', async () => {
    const a = await mk().fetchById(21);
    expect(a!.identity.anilist).toBe(21);
    expect(a!.identity.mal).toBe(21);
  }, 20_000);

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await mk().fetchById(99999999)).toBeNull();
  }, 20_000);

  it('still reports the current rate limit of 30/min', async () => {
    const http = new HttpClient({ userAgent: 'anicata-anime-addon/0.1' });
    const r = await http.getJson<Record<string, never>>('https://graphql.anilist.co', {
      method: 'POST',
      body: JSON.stringify({ query: '{__typename}' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(Number(r.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    // 2026-10-04: 30. Raise to 90+ when AniList's degraded state ends.
    console.log('anilist x-ratelimit-limit =', r.headers['x-ratelimit-limit']);
  }, 20_000);
});
```

- [ ] **Step 2: Run the live suite**

Run: `ANICATA_LIVE=1 npx vitest run --dir test/live`
Expected: 4 passed. If the rate-limit test logs a value other than `30`, record it
in `docs/data-sources.md` §1.2 — that number is a design input, not trivia.

Then run without the env var: `npx vitest run` → live tests must **skip**, and the
default `npm test` must stay offline.

- [ ] **Step 3: Write the README**

`README.md` must contain: what the add-on is and is not; the install URL; the
`titleLang` query parameter; the three Phase 1 catalogues and their `extra`
declarations; the `anilist:` id scheme and why; the architecture in one diagram; a
table of the five cache layers; an AniList rate-limit note (30/min, and that a
raise has been requested); a **known limitations** section listing that Jikan is
unreachable and therefore disabled, that Kitsu/TMDB/AniZip land in Phases 2–4,
that `videos[]` is empty, and that genre catalogues land in Phase 5; and
pointers to all nine documents in `docs/`.

- [ ] **Step 4: Final verification**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all green. Then confirm the built artifact starts:
```bash
PORT=7099 node dist/index.js &
sleep 2 && curl -s localhost:7099/manifest.json | head -c 200 && kill %1
```
Expected: manifest JSON containing `"id":"org.anicata.anime"`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README, live smoke tests and env documentation"
```

---

## Manual verification (not automatable)

Run after Task 16, on a real device, before calling Phase 1 done. Each item maps to
a `docs/roadmap.md` Phase 1 exit-gate checkbox.

- [ ] Install from a pasted `https://…/manifest.json` URL in Nuvio
- [ ] The add-on's logo renders in the add-on list (validates `/logo.png`)
- [ ] Both browse catalogues appear on Home — confirms no `isRequired` extras
- [ ] Scrolling Home triggers pagination; rows keep loading past 100 items
- [ ] Search returns results and does **not** appear to hang
- [ ] Opening a title shows poster, synopsis, genres, rating and links
- [ ] Nuvio classifies the title as **anime** and shows its anime tracking section
      (Simkl) — the payoff of the `anilist:` id scheme
- [ ] A nonsense search shows a clean "no results", not an error banner
- [ ] Killing the server leaves Nuvio degrading gracefully

## Deferred, by design

Out of scope for Phase 1, per `docs/roadmap.md`:

| Concern | Phase |
|---|---|
| Kitsu adapter + fallback chain | 2 |
| Jikan adapter (ships disabled) | 2 |
| Identity bundle, cross-source `links`, inbound `mal:`/`kitsu:`/`tmdb:`/`tt…` | 3 |
| `videos[]` via AniZip, logos via TMDB | 4 |
| 12 more catalogues, genre catalogues, season catalogue | 5 |
| Rate-limit tuning, scheduled identity rebuild | 6 |
| On-device regression suite, Stremio-client conformance | 7 |
| Dockerfile, Fly.io, custom domain | 8 |

`idPrefixes` already lists `kitsu:`, so Phase 3 needs **no** manifest change to start
emitting `kitsu:` ids (ADR-016).

---

## Self-Review Notes

- **Spec coverage.** All of `docs/roadmap.md` Phase 1 maps onto Tasks 1–16. The
  exit-gate items verified on-device are called out separately above, since they
  cannot be automated.
- **Review Focus coverage.** #1 → Task 8 (`page 1 and page 2 are disjoint`, plus
  the short-page and past-the-end tests). #2 → Task 7 (`fetchById` returns `null`,
  two tests) and Task 9. #3 → Task 8 (the service never reads `pageInfo.total` to
  compute pages; the adapter returns `total` but the service ignores it). #4 →
  Task 4 (10-concurrent-misses test). #5 → Task 5 (`resolveDisplayTitle` "Untitled")
  and Task 6 (`survives a fully-null title`, `survives an entirely empty payload`).
- **Type consistency.** `Anime`, `AnimeIdentity`, `stremioIdFor`, `SourceError`,
  `TTLCache`, `TokenBucket`, `HttpClient`, `AniListPageQuery`, `AnimeSource`,
  `CATALOG_DEFS`, `PAGE_SIZE`, `CATALOG_TTL_MS`, `META_TTL_MS`, `parseExtra`,
  `parseMetaId`, `buildManifest`, `createApp` are each defined once in the task
  listed above and referenced by the same name everywhere else.
- **Proportion.** Function bodies are given only where the tests leave the
  algorithm open (cache `wrap`, LRU eviction, page stitching, extras coercion).
  Everything else is a signature plus pinned assertions.
- **Pre-flight scan found and closed one load-bearing gap.** The manifest declares
  `logo: '/logo.png'` and `public/logo.png` is created in Task 1, but no task
  mounted `public/` as static assets — so the logo would have 404'd in Nuvio and
  the Phase 1 exit gate "manifest logo renders in the add-on list" would have
  failed on-device only, after every automated test was green. Task 15 now mounts
  `express.static` and an integration test fetches the manifest, reads its
  declared `logo` path, and asserts that path returns a 200 image.