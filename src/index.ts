import express from 'express';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Args, Cache, ContentType, Manifest, MetaDetail } from 'stremio-addon-sdk';
import { buildManifest } from './addon/manifest.js';
import { createCatalogHandler } from './addon/catalog.js';
import { createMetaHandler } from './addon/meta.js';
import { ResolveService } from './services/resolve.service.js';
import { EpisodeService } from './services/episode.service.js';
import { loadBundle } from './identity/bundle.js';
import { loadAppConfig, type AppConfig } from './config/index.js';
import { HttpClient } from './net/http.js';
import { TokenBucket } from './net/limiter.js';
import { TTLCache } from './cache/store.js';
import { AniListSource } from './sources/anilist/adapter.js';
import { KitsuSource } from './sources/kitsu/adapter.js';
import { SourceChain } from './sources/chain.js';
import { CircuitBreaker } from './net/breaker.js';
import { CatalogService } from './services/catalog.service.js';
import { MetaService } from './services/meta.service.js';
import { createLogger } from './util/logger.js';

const require = createRequire(import.meta.url);

// `stremio-addon-sdk` is CommonJS without detectable named ESM exports, so a
// static named import fails at runtime. `require` returns the full
// `module.exports`; the cast restores the SDK's declared types at this one
// boundary. No `any` involved.
const sdk = require('stremio-addon-sdk') as typeof import('stremio-addon-sdk');

const pkg = require('../package.json') as { version: string };

export interface AppDeps {
  catalogService: CatalogService;
  metaService: MetaService;
  /**
   * Optional chain for injection. When provided, the default CatalogService
   * and MetaService are built over it instead of the internally constructed
   * AniList → Kitsu chain. Wiring only — no behaviour change when omitted.
   * Exists so integration tests can inject a throwing or hanging primary
   * through the composition root rather than by monkey-patching.
   */
  chain?: SourceChain;
  /**
   * Optional identity tier for injection, so tests can supply a bundle
   * without the build artefact. Wiring only.
   */
  resolveService?: ResolveService;
  /** Optional episode tier for injection. Wiring only (Phase 4). */
  episodeService?: EpisodeService;
  /**
   * Optional config for injection, so tests can supply a TMDB key without it
   * ever coming from `process.env`. Wiring only.
   */
  config?: AppConfig;
}

/**
 * Narrow bridge at the SDK boundary. The SDK types catalog `extra` as a fixed
 * `{ search: string; genre: string; skip: number }`, but its router hands us
 * the raw querystring map (all strings, possibly sparse — `skip` arrives as a
 * string, not a number). Rebuild the wire shape our handler parses, dropping
 * anything unexpected. `undefined` passes through so a missing extra still
 * means "first page".
 */
function toExtraRecord(
  extra: Record<string, unknown> | undefined,
): Record<string, string | string[]> | undefined {
  // `== null` rather than `=== undefined`: this is the only code on the
  // catalogue path that runs OUTSIDE the handler's try/catch (it sits in the
  // SDK's lambda, ahead of the promise the handler returns), so a throw here
  // would be the one way to bypass the no-5xx guarantee. `Object.entries(null)`
  // throws, so the guard is closed even though qs.parse never yields null today.
  if (extra == null) {
    return undefined;
  }
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') {
      out[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === 'string')
    ) {
      out[key] = value;
    }
  }
  return out;
}

// Nuvio's meta budget is 5000 ms (`MetaDetailsRepository.FETCH_TIMEOUT_MS`).
// The chain must outlive one per-attempt HTTP timeout so a primary that dies
// by timeout (not just a fast 5xx) still leaves room for Kitsu, while staying
// under 5000 with headroom for serialisation and transit. Arithmetic:
// budget = min(httpTimeoutMs + 500, 4500); httpTimeoutMs is clamped to <= 4000
// (see config), so the default 3500 yields 4000 and the max 4000 yields 4500.
// Headroom for the fallback attempt is therefore 500 ms at both ends.
//
// That 500 ms is enough for a SLOW-but-responding AniList: at a typical ~1000 ms
// the fallback gets ~3000 ms, and at 3000 ms it still gets ~1000 ms. It is tight
// only when AniList is fully hung and burns its whole timeout, where Kitsu's
// ~600 ms p50 may not fit. That case still returns HTTP 200 with an empty list
// inside Nuvio's budget, which is the correct degradation - but a larger
// fallback window would need a smaller per-attempt timeout, and Nuvio's 5000 ms
// cap is what forces the ceiling at 4500. Changing that trade is a deliberate
// decision, not a bug fix.
//
// A literal here would silently ignore the operator's HTTP_TIMEOUT_MS.
export const CHAIN_BUDGET_MARGIN_MS = 500;
export const CHAIN_BUDGET_MAX_MS = 4500;

export function chainBudgetForHttpTimeout(httpTimeoutMs: number): number {
  return Math.min(httpTimeoutMs + CHAIN_BUDGET_MARGIN_MS, CHAIN_BUDGET_MAX_MS);
}

// The manifest route has no handler, so the SDK router emits no Cache-Control
// for it. The manifest only changes on deploy: cache it for a day here. This
// is deliberately per-route — a global serveHTTP cache would fight the
// per-resource TTLs the handlers return (10 s on error, 7 days on meta).
const MANIFEST_CACHE_CONTROL = 'max-age=86400, public';

// The SDK's declared meta signature. Our handler returns `StremioMetaDetail`,
// which intentionally omits the SDK's required `MetaVideo.released` (Nuvio
// renders with no `videos` key at all) and carries the Nuvio-only spellings.
// The runtime shape is what Nuvio parses; this alias documents the single
// boundary where our accurate types meet the SDK's declared ones. No `any`
// involved.
type SdkMetaHandler = (args: { type: ContentType; id: string }) => Promise<
  { meta: MetaDetail } & Cache
>;

// The build artefact from `npm run identity:build` (ADR-018/D2: fetched at
// build time, never vendored). A missing file degrades to an empty index and
// live tiers, which is why this is not fatal.
const IDENTITY_BUNDLE_PATH = 'data/identity.min.json.gz';

export function createApp(overrides?: Partial<AppDeps>): express.Express {
  const config = overrides?.config ?? loadAppConfig(process.env);
  const log = createLogger(config.logLevel);
  const http = new HttpClient({ timeoutMs: config.httpTimeoutMs });
  const limiter = new TokenBucket({
    capacity: config.anilistRateLimitPerMinute,
    refillPerMinute: config.anilistRateLimitPerMinute,
  });
  const cache = new TTLCache({ maxEntries: config.cacheMaxEntries });
  const anilist = new AniListSource({ http, limiter, log, url: config.anilistUrl });
  const kitsu = new KitsuSource({ http, limiter, log });
  const chain = new SourceChain({
    sources: [anilist, kitsu],
    breakers: new Map([
      ['anilist', new CircuitBreaker()],
      ['kitsu', new CircuitBreaker()],
    ]),
    // The chain's total budget follows the operator's configured timeout (see
    // chainBudgetForHttpTimeout above): one full per-attempt timeout plus a
    // 500 ms fallback window, capped at 4500 ms. A literal here would silently
    // ignore that setting.
    budgetMs: chainBudgetForHttpTimeout(config.httpTimeoutMs),
  });
  const catalogService =
    overrides?.catalogService ?? new CatalogService({ source: overrides?.chain ?? chain, cache, log });
  const metaService =
    overrides?.metaService ?? new MetaService({ source: overrides?.chain ?? chain, cache, log });

  const builder = new sdk.addonBuilder(
    // Documented: `AniCataManifest` widens the SDK's `Manifest` with the
    // Nuvio-required `'anime'` type (see `addon/manifest.ts`); the SDK passes
    // these strings through untouched at runtime.
    buildManifest(pkg.version) as Manifest,
  );
  const catalogHandle = createCatalogHandler({ catalogService });
  // Two separate statements: the SDK types these as returning `void`, so they
  // are not chainable. The catalog lambda widens `Args` to the wire shape at
  // this single call site (see `toExtraRecord`); the meta cast below is the
  // one documented exception for the return side (see `SdkMetaHandler`).
  builder.defineCatalogHandler((args: Args) => {
    const extra = toExtraRecord(args.extra);
    if (extra === undefined) {
      return catalogHandle({ type: args.type, id: args.id });
    }
    return catalogHandle({ type: args.type, id: args.id, extra });
  });
  // The identity tier. A missing or corrupt bundle degrades to an empty index
  // rather than failing startup, so this never takes the process down.
  const resolveService =
    overrides?.resolveService ?? new ResolveService({ http, bundle: loadBundle(IDENTITY_BUNDLE_PATH), log, cache });
  // The episode tier. Separate budget from identity, fetched in parallel with
  // it, and absent from the manifest entirely: a missing AniZip costs the
  // episode list, never the meta (roadmap gate).
  const episodeService =
    overrides?.episodeService ?? new EpisodeService({ http, log });
  builder.defineMetaHandler(
    createMetaHandler({ metaService, resolve: resolveService, episodes: episodeService }) as SdkMetaHandler,
  );

  const app = express();
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use('/', express.static(publicDir, { maxAge: '1d', fallthrough: true }));
  app.use('/manifest.json', (_req, res, next) => {
    res.setHeader('Cache-Control', MANIFEST_CACHE_CONTROL);
    next();
  });
  app.use(sdk.getRouter(builder.getInterface()));
  return app;
}

export function start(): void {
  const config = loadAppConfig(process.env);
  const log = createLogger(config.logLevel);
  const app = createApp();
  const server = createServer(app);
  server.listen(config.port, () => {
    log.info('listening', { url: `http://127.0.0.1:${config.port}/manifest.json` });
  });
}

// Importing this module (as the integration tests do) must not bind a port;
// only `node dist/index.js` starts listening.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
