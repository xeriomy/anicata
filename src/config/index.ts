export type TitleLang = 'english' | 'romaji' | 'native';

export interface RequestConfig {
  titleLang: TitleLang;
}

export interface AppConfig {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  anilistUrl: string;
  anilistRateLimitPerMinute: number;
  httpTimeoutMs: number;
  cacheMaxEntries: number;
  /**
   * Operator-supplied TMDB key for Phase 4 artwork enrichment.
   *
   * Absent (`undefined`) means the enrichment is off, and the add-on must behave
   * exactly as it did without it. There is deliberately NO default: a hardcoded
   * key would make the add-on depend on one person's credential and would leak
   * it to everyone who clones the repo. Phase 8's `/configure` page will collect
   * it; until then the environment variable is the only way in.
   */
  tmdbApiKey?: string;
}

const TITLE_LANGS: readonly TitleLang[] = ['english', 'romaji', 'native'];
const LOG_LEVELS: readonly AppConfig['logLevel'][] = ['debug', 'info', 'warn', 'error'];

// Single home for the AniList endpoint default. The adapter imports this
// rather than defining its own literal, so the default exists in exactly one
// place (no circular import: this module imports nothing).
export const DEFAULT_ANILIST_URL = 'https://graphql.anilist.co';

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const found = allowed.find((v) => v === raw);
  return found ?? fallback;
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') return fallback;
  return raw;
}

/**
 * Optional credentials read from the environment.
 *
 * Unlike `readString` there is no fallback: an unset, empty or whitespace-only
 * value all mean "not configured" and must produce `undefined`, because an
 * empty-string credential would be sent upstream and rejected on every request
 * rather than failing the feature off cleanly.
 */
function readOptionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Conditional spread, not a direct assignment: exactOptionalPropertyTypes
  // rejects writing `undefined` into an optional key, and the distinction is
  // load-bearing here — `tmdbApiKey: undefined` would claim the key was
  // configured, while omitting it says the enrichment is simply off.
  const tmdbApiKey = readOptionalString(env, 'TMDB_API_KEY');
  return {
    port: readInt(env, 'PORT', 7000),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    anilistUrl: readString(env, 'ANILIST_URL', DEFAULT_ANILIST_URL),
    anilistRateLimitPerMinute: readInt(env, 'ANILIST_RATE_LIMIT', 25),
    httpTimeoutMs: Math.min(readInt(env, 'HTTP_TIMEOUT_MS', 3500), 4000),
    cacheMaxEntries: readInt(env, 'CACHE_MAX_ENTRIES', 10000),
    ...(tmdbApiKey !== undefined ? { tmdbApiKey } : {}),
  };
}

/**
 * NOT YET WIRED — do not advertise `titleLang` as a working option.
 *
 * Nuvio does preserve the manifest URL's query string and re-append it to every
 * catalogue and meta request (verified in its `AddonTransportUrls.kt`: the built
 * URL ends `return resourceUrl + query`). But `stremio-addon-sdk`'s router never
 * reads `req.query` — it derives extras solely from the final path segment
 * (`qs.parse(req.url.split('/').pop().slice(0, -5))`, `getRouter.js:55`). So the
 * query string arrives at our server and is discarded before any handler sees it,
 * and `AniListSource` always receives `titleLang: undefined` and falls back to
 * `'english'`.
 *
 * Wiring it would mean threading the query string past the SDK's router, either by
 * forking `getRouter` or by rewriting `req.url` in express middleware so the value
 * lands in the extras segment. Both are non-trivial, and no Phase 1 exit gate
 * requires them. Deferred to Phase 8 alongside a `/configure` page, where language
 * becomes a real form field rather than a query parameter the protocol drops.
 *
 * This function is retained (and tested) because Phase 8 will need it; it is simply
 * not part of the public contract yet.
 */
export function parseRequestConfig(query: string | URLSearchParams | undefined): RequestConfig {
  let raw: string | null = null;
  if (typeof query === 'string') {
    raw = new URLSearchParams(query).get('titleLang');
  } else if (query instanceof URLSearchParams) {
    raw = query.get('titleLang');
  }
  const found = TITLE_LANGS.find((v) => v === raw);
  return { titleLang: found ?? 'english' };
}
