export type TitleLang = 'english' | 'romaji' | 'native';

export interface RequestConfig {
  titleLang: TitleLang;
}

export interface AppConfig {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  anilistRateLimitPerMinute: number;
  httpTimeoutMs: number;
  cacheMaxEntries: number;
}

const TITLE_LANGS: readonly TitleLang[] = ['english', 'romaji', 'native'];
const LOG_LEVELS: readonly AppConfig['logLevel'][] = ['debug', 'info', 'warn', 'error'];

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

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readInt(env, 'PORT', 7000),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    anilistRateLimitPerMinute: readInt(env, 'ANILIST_RATE_LIMIT', 25),
    httpTimeoutMs: Math.min(readInt(env, 'HTTP_TIMEOUT_MS', 3500), 4000),
    cacheMaxEntries: readInt(env, 'CACHE_MAX_ENTRIES', 10000),
  };
}

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
