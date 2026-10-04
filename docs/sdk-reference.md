# Stremio Add-on SDK Reference

> **Verification basis.** Read from the actual source of
> `Stremio/stremio-addon-sdk` **v1.6.10** (cloned to
> `/tmp/opencode/research/stremio-addon-sdk`), plus the vendored Stremio docs
> shipped inside `NuvioMobile` at `Docs/Stremio addons refer/`.
> File/line references are to the SDK clone.

---

## 1. Status and maintenance

| Property | Value |
|---|---|
| npm version | **1.6.10** |
| Last commit | **2026-09-23** (`Merge PR #394 …`) |
| GitHub "latest release" | `v1.1.4`, 2019-03-14 — **stale metadata; npm is ahead** |
| Runtime deps | `chalk@^2.4.2`, `cors@^2.8.4`, `express@^4.16.3`, `inquirer@^6.2.2`, `mkdirp@^0.5.1`, `node-fetch@^2.3.0`, `opn@^5.4.0`, `router@^1.3.3`, `stremio-addon-linter@^1.7.0` |
| Dev deps | `eslint@^5`, `supertest@^3`, `tape@^4`, `typescript@^5.9.2`, `stremio-addon-client@1.16.1` |

> **Verdict: maintained.** A merge landed 11 days before this research. The GitHub
> Releases page is stale, which is misleading — do not conclude "unmaintained"
> from it.
>
> ⚠ `express@4.16.3` and `node-fetch@2.3.0` are old. Express 4 works on Node 22.
> `node-fetch@2` is dead weight (Node 18+ has native `fetch`) but harmless.

---

## 2. What we use, and what we deliberately don't

| SDK API | Use? | Why |
|---|---|---|
| `addonBuilder` | ✅ | manifest + handler registration |
| `defineCatalogHandler` | ✅ | catalog + search |
| `defineMetaHandler` | ✅ | metadata |
| `serveHTTP` | ✅ | hosting |
| `getRouter` | ⚠ optional | only if we need to bypass the builder |
| `defineStreamHandler` | ❌ | streaming is out of scope |
| `defineSubtitleHandler` | ❌ | out of scope; Nuvio doesn't request it anyway |
| `defineResourceHandler('addon_catalog')` | ❌ | Nuvio never requests it |
| `publishToCentral` | ❌ | we deploy ourselves |
| `landingPage` / static serving | ✅ small | manifest landing page only |
| `/configure` router | ❌ | config via URL query is enough and Nuvio-native |

---

## 3. `addonBuilder` behaviour — the things that bite

From `src/builder.js`:

```js
// line 22-23
if (JSON.stringify(manifest).length > 8192) {
    throw new Error('manifest size exceeds 8kb, which is incompatible with addonCollection API')
}
```

Also on construction, `addonBuilder`:
1. **Lints the manifest** with `stremio-addon-linter` → throws if invalid.
2. **Verifies handler coverage** for every declared resource/catalog → throws if missing.
3. **`Object.freeze(manifest)`** — the manifest is immutable after construction.

### 3.1 ⚠ The 8 KB manifest limit is a hard design constraint

This is the most important SDK constraint for catalog design, and it interacts
directly with Nuvio's genre requirements.

Worked example:

```jsonc
// ~14 catalogs with no genre options
"catalogs": [
  { "type":"anime", "id":"trending",           "name":"Trending",              "extra":[{"name":"skip"}] },   // ≈ 105 bytes
  { "type":"anime", "id":"popular",            "name":"Popular",               "extra":[{"name":"skip"}] },   // ≈ 104
  { "type":"anime", "id":"top-rated",          "name":"Top Rated",             "extra":[{"name":"skip"}] },   // ≈ 106
  …
]
```

Approximate budget:

| Item | Approx. cost |
|---|---|
| Manifest envelope + `resources` + `types` | ~350 B |
| A minimal catalog entry (`type`,`id`,`name`,`extra:[skip]`) | ~100–110 B |
| 14 catalogs, no genres | ~1.5 KB |
| One genre extra with 20 options | ~180 B |
| **A genre extra on all 14 catalogs** | **~2.5 KB** |
| 30 catalogs, no genres | ~3.3 KB |

**Conclusion:** we have roughly **6–7 KB of headroom**. Declaring genre options on
every catalog is *possible* but wasteful. Declaring `search` on every catalog is
also wasteful — and harmful, because Nuvio sends a search request to every
searchable catalog (see `nuvio-compatibility.md` §7.2).

> **Recommendation:** declare `genre` options on **one or two** genre-oriented
> catalogs, not all of them. Add a build-time size assertion (`≤ 8192`) so a
> future catalog addition can never silently break startup.

---

## 4. Manifest schema — SDK-validated fields

```jsonc
{
  "id": "org.anicata.anime",          // required, linted
  "version": "1.0.0",                 // required, linted
  "name": "AniCata Anime",            // required, linted
  "description": "…",                 // optional
  "logo": "https://…/logo.png",       // optional, PASS-THROUGH (not linted)
  "background": "https://…/bg.jpg",   // optional, PASS-THROUGH
  "contactEmail": "…",                // optional, PASS-THROUGH

  "types": ["anime", "movie"],
  "idPrefixes": ["anilist:"],
  "resources": ["catalog", { "name": "meta", "types": ["anime"], "idPrefixes": ["anilist:"] }],
  "catalogs": [
    {
      "type": "anime",                // required
      "id": "anime-trending",         // required
      "name": "Trending",
      "extra": [
        { "name": "skip" },
        { "name": "search" },
        { "name": "genre", "options": ["Action", "…"], "optionsLimit": 20 }
      ]
    }
  ],
  "behaviorHints": { "configurable": false, "configurationRequired": false,
                     "adult": false, "p2p": false },
  "config": []                        // optional; presence adds the /:config? path prefix
}
```

### 4.1 Validated vs pass-through

| Validated / linted | Passed through unvalidated |
|---|---|
| `id`, `name`, `version`, `resources`, `types`, `catalogs` | `logo`, `background`, `contactEmail` |
| `behaviorHints` keys | all other unknown keys |
| catalog `extra` (`name`, `isRequired`, `options`, `optionsLimit`) | |
| resource names ∈ known set | |
| manifest ≤ 8192 bytes | |

### 4.2 `extraSupported` / `extraRequired`

The linter also accepts the older array notation
(`"extraSupported": ["search"], "extraRequired": ["date"]`), but the SDK builder
and Nuvio both read the `extra` array. **Use `extra` only.**

### 4.3 Resource object form

`resources[]` entries may be strings or objects. The object form lets us scope
`types` and `idPrefixes` per resource — **required** for our `meta` routing
(`nuvio-compatibility.md` §8.1).

```json
["catalog", { "name": "meta", "types": ["anime", "movie"], "idPrefixes": ["anilist:"] }]
```

---

## 5. Routing and handlers

### 5.1 URL scheme (`src/getRouter.js`)

```js
const configPrefix = hasConfig ? '/:config?' : ''
router.get(`${configPrefix}/manifest.json`, manifestHandler)
router.get(`${configPrefix}/:resource${ResourcesRegex}/:type/:id/:extra?.json`, handler)
```

`ResourcesRegex` is built from the manifest, so only declared resources are routed:

```js
const handlersInManifest = []
if (manifest.catalogs.length > 0) handlersInManifest.push('catalog')
manifest.resources.forEach(r => handlersInManifest.push(r.name || r))
```

> Note `catalog` is pushed automatically whenever `catalogs.length > 0` — so
> listing `"catalog"` explicitly is optional but harmless and clearer.

### 5.2 How `extra` is parsed — read this before hand-rolling anything

```js
// getRouter.js, ~line 59
const extra = req.params.extra
    ? qs.parse(req.url.split('/').pop().slice(0, -5))
    : {}
```

- Parsed from the **raw** URL, not `req.params`, because `req.params` decodes
  characters and would break `&`-separated extras when `%26` appears in a value.
- `querystring.parse` → **all values are strings or string arrays**. `skip`
  arrives as `"100"`, never `100`.
- `:extra` is the whole segment before `.json`.

> **Consequence:** always `Number.parseInt(args.extra.skip ?? '0', 10)` and guard
> `NaN`. Also handle a repeated key arriving as an array.

### 5.3 Handler arguments

`addonInterface.get(resource, type, id, extra, config)` invokes the handler with a
single `args` object:

```ts
{ type: string, id: string, extra?: Record<string, string | string[]>, config?: unknown }
```

- `extra` defaults to `{}`.
- `config` is `false` (not `undefined`) when the `/:config?` segment is absent
  or unparseable.

### 5.4 Catalog handler signature

```ts
defineCatalogHandler((args) => {
  // args.type            e.g. "anime"
  // args.id              e.g. "anime-trending"
  // args.extra.search    string | undefined
  // args.extra.genre     string | undefined
  // args.extra.skip      string | undefined   ← STRING
  return { metas: MetaPreview[] };
})
```

**The SDK does not implement pagination for you.** There is no `page` argument and
no `skip` slicing in the SDK. *Our* handler must:

1. read `args.extra.skip`,
2. request the corresponding window upstream,
3. return at most the remaining items.

> **Nuvio-specific:** Nuvio sets `skip = previousSkip + <length of our last
> response>` (`nuvio-compatibility.md` §6.3). So the correct behaviour is
> "return items `[skip, skip+N)`", and returning fewer than `N` is legal and
> self-consistent — it just shortens the next step.

### 5.5 Meta handler signature

```ts
defineMetaHandler((args) => {
  // args.type   e.g. "anime"
  // args.id     e.g. "anilist:21"  (already URL-decoded by the router)
  return { meta: MetaDetail };
})
```

> ⚠ Unlike `extra`, the `:id` path segment **is** taken from `req.params`, so it
> **is** percent-decoded. `anilist%3A21` arrives as `anilist:21`. Split on `:`.

---

## 6. Response schemas

### 6.1 Catalog — `MetaPreview`

The SDK type includes ~30 optional fields, but only `id`, `type`, `name` are
effectively mandatory. Fields our clients actually consume:

| Field | Type | Required | Nuvio reads? |
|---|---|---|---|
| `id` | string | ✅ | ✅ |
| `type` | string | ✅ | ✅ |
| `name` | string | ✅ | ✅ |
| `poster` | string | recommended | ✅ |
| `posterShape` | `'poster'\|'square'\|'landscape'` | optional | ✅ |
| `description` | string | optional | ✅ |
| `releaseInfo` | string | optional | ✅ |
| `released` | ISO date string | optional | ✅ (`rawReleaseDate`) |
| `imdbRating` | string | optional | ✅ (read as string) |
| `genres` | string[] | optional | ✅ |
| `background` | string | optional | ✅ (lower priority than `banner`) |
| `banner` | string | optional | ✅ **Nuvio-preferred wide art** |
| `logo` | string | optional | ✅ |
| `links` | `MetaLink[]` | optional | ✅ |

> `banner`, `landscapePoster`, and `app_extras` are **not** in the SDK's
> `MetaPreview` type. They are pass-through JSON. To emit `banner` in
> TypeScript we declare our own response type extending `MetaPreview` — not by
> casting to `any`.

### 6.2 Meta — `MetaDetail`

Same core as `MetaPreview`, plus:

| Field | Type | Nuvio reads? | Notes |
|---|---|---|---|
| `imdb_id` | string | ✅ | **snake_case** |
| `runtime` | string | ✅ | e.g. `"24 min"` |
| `country` | string | ✅ | ⚠ Nuvio name, **not** `countryOfOrigin` |
| `language` | string | ✅ | ⚠ Nuvio name, **not** `audioLanguage` |
| `countryOfOrigin` | string | ❌ | standard; emit **alongside** `country` |
| `audioLanguage` | string | ❌ | standard; emit **alongside** `language` |
| `ageRating` | string | ✅ | or `app_extras.certification` |
| `status` | string | ✅ | |
| `awards` | string | ✅ | |
| `website` | string | ✅ | |
| `videos` | `MetaVideo[]` | ✅ | season/episode rendering |
| `trailers` | `MetaTrailer[]` | ✅ | needs `key` |
| `behaviorHints` | `{hasScheduledVideos?, defaultVideoId?}` | ✅ | |
| `links` | `{name,category,url}[]` | ✅ | all three required by Nuvio |
| `director`, `writer`, `cast` | string[] \| CSV | ✅ | also derivable from `links` |

⚠ **We must emit both `country`+`countryOfOrigin` and
`language`+`audioLanguage`** to satisfy Nuvio *and* Stremio/other clients.

### 6.3 `MetaVideo`

```ts
{
  id: string          // required
  title?: string      // or `name` — one required by Nuvio
  released?: string
  available?: boolean // default true
  thumbnail?: string
  seasonPoster?: string
  season?: number
  episode?: number
  overview?: string   // or `description`
  runtime?: number    // MINUTES — Nuvio runs parseRuntimeMinutes()
  rating?: number
}
```

> Nuvio additionally reads embedded `streams[]` inside videos — that is the
> streaming seam, and out of scope for us.

---

## 7. `serveHTTP`

```js
serveHTTP(server, port, opts)
```

`opts`:

| Opt | Effect |
|---|---|
| `cacheMaxAge` (alias `cache`) | sets `Cache-Control: max-age=N, public` when no `Cache-Control` is already set |
| `static` | static file path/options |
| `port` | port |
| `getRouter` | override the router |

```js
// serveHTTP.js:13-21
const cacheMaxAge = opts.cacheMaxAge || opts.cache
if (cacheMaxAge && !res.getHeader('Cache-Control'))
    res.setHeader('Cache-Control', 'max-age=' + cacheMaxAge + ', public')
```

Warns if `cacheMaxAge > 365 * 24 * 60 * 60` ("cache times are in seconds, not
milliseconds").

> **Per-response cache headers work too** (`getRouter.js:69-85`): a handler may
> return a numeric `cacheMaxAge` (and/or `staleRevalidate`/`staleError`) and the
> router builds `Cache-Control` from it:
> ```
> Cache-Control: max-age=<cacheMaxAge>, stale-while-revalidate=<…>, stale-if-error=<…>, public
> ```
> Values must be **integers**; non-integers are skipped.
>
> **Decision:** use **per-response** `cacheMaxAge`, because our TTLs differ by
> resource (manifest long, catalogs medium, meta long) and vary by staleness
> (stale-while-revalidate when serving from cache). A single global
> `serveHTTP` cache value cannot express that.

---

## 8. TypeScript types

The SDK ships its own `.d.ts` (`src/types.d.ts`, `src/builder.d.ts`,
`src/getRouter.d.ts`, `src/serveHTTP.d.ts`) — **no `@types/*` package needed.**

Key exported types:

```ts
type Resource = 'catalog' | 'meta' | 'stream' | 'subtitles' | 'addon_catalog'

interface Manifest {
  id: string
  version: string
  name: string
  logo?: string
  background?: string
  types: ResourceType[]
  resources: (Resource | ResourceObj)[]
  catalogs: ManifestCatalog[]
  idPrefixes?: string[]
  behaviorHints?: BehaviorHints
  description?: string
  contactEmail?: string
  config?: ManifestConfig[]
}

interface ManifestCatalog {
  type: ResourceType
  id: string
  name?: string
  extra?: ManifestExtraProp[]
  extraSupported?: string[]
  extraRequired?: string[]
  extraOptions?: Record<string, string[] | string>
}

interface ManifestExtraProp {
  name: string
  isRequired?: boolean
  options?: string[]
  optionsLimit?: number
}

interface AddonBuilder {
  defineCatalogHandler(handler: CatalogHandler): AddonBuilder
  defineMetaHandler(handler: MetaHandler): AddonBuilder
  defineStreamHandler(handler: StreamHandler): AddonBuilder
  defineSubtitlesHandler(handler: SubtitlesHandler): AddonBuilder
  defineResourceHandler<T extends Resource>(name: T, handler: ResourceHandler<T>): AddonBuilder
  getManifest(): Manifest
}

type CatalogHandler = (args: CatalogHandlerArgs) => Promise<{ metas: MetaPreview[] } | undefined>
type MetaHandler    = (args: MetaHandlerArgs)    => Promise<{ meta: MetaDetail } | undefined>
```

`GetHandlerExtra` / `HandlerExtraMap` conditionally type `args.extra` based on the
manifest's declared extras — useful, but it types against **our** manifest, and
Nuvio is free to send extras we did not declare. We still need a runtime guard.

---

## 9. Linter rules (`stremio-addon-linter`)

Invoked automatically by `addonBuilder`. Manifest must have:

- `id` — non-empty string
- `name` — non-empty string
- `version` — string
- `types` — non-empty array
- `resources` — non-empty array of known resource names
- `catalogs` — each entry needs `type` and `id`

Not validated: `logo`, `background`, `contactEmail`, unknown keys.

> **Practical use:** a unit test that constructs the builder from our manifest
> asserts lint + handler-coverage + the 8 KB limit in one line. This is our
> cheapest CI gate and it catches manifest regressions before deploy.

---

## 10. Recommendations

1. **Use the SDK** — it gives us CORS, linting, handler coverage, and the
   canonical URL scheme for free, with no Nuvio-specific code.
2. **Use the object form of `resources`** so `meta` can carry
   `idPrefixes: ["anilist:", "kitsu:"]`. This is load-bearing for routing.
3. **Use per-response `cacheMaxAge`**, not the global `serveHTTP` option.
4. **Declare our own extended response types** (`StremioMetaPreview` with `banner`,
   `StremioMetaDetail` with `country`/`language`/`videos`) extending the SDK types.
   Avoid `any`.
5. **Assert manifest size ≤ 8192 in CI.**
6. **Always return `metas: []` rather than `undefined`.** `undefined` is typed as
   legal but produces an empty body that clients treat inconsistently.
7. **Never throw from a handler.** Return an empty result with a short
   `Cache-Control`; let the client degrade.
8. **Do not implement `stream`/`subtitles`** and do not advertise them. Nuvio
   checks `resource.name` when routing `meta`, and advertising unimplemented
   resources would make the builder throw for missing handlers.