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
  it("keeps the HTTP timeout under Nuvio's 5s meta budget", () => {
    expect(loadAppConfig({ HTTP_TIMEOUT_MS: '99999' }).httpTimeoutMs).toBeLessThanOrEqual(4000);
  });
  it('defaults ANILIST_URL to the AniList endpoint when absent', () => {
    expect(loadAppConfig({}).anilistUrl).toBe('https://graphql.anilist.co');
  });
  it('returns the ANILIST_URL override when set', () => {
    expect(loadAppConfig({ ANILIST_URL: 'http://127.0.0.1:1' }).anilistUrl).toBe('http://127.0.0.1:1');
  });
  it('falls back to the default for an empty or whitespace-only ANILIST_URL', () => {
    expect(loadAppConfig({ ANILIST_URL: '' }).anilistUrl).toBe('https://graphql.anilist.co');
    expect(loadAppConfig({ ANILIST_URL: '   ' }).anilistUrl).toBe('https://graphql.anilist.co');
  });
});

describe('loadAppConfig — TMDB_API_KEY (Phase 4, optional enrichment)', () => {
  it('is absent by default so the add-on runs identically without a key', () => {
    // The Phase 4 exit gate: "TMDB key unset -> everything else still works
    // identically". Absence must read as `undefined`, not as an empty string —
    // an empty-string key would be sent to TMDB and 401 on every request.
    // The key is omitted entirely rather than set to undefined, so it can never
    // appear in a serialized config or a log line.
    expect(loadAppConfig({}).tmdbApiKey).toBeUndefined();
    expect(Object.keys(loadAppConfig({}))).not.toContain('tmdbApiKey');
  });

  it('reads the key from TMDB_API_KEY', () => {
    const c = loadAppConfig({ TMDB_API_KEY: 'abc123' });
    expect(c.tmdbApiKey).toBe('abc123');
  });

  it('treats a blank or whitespace-only key as unset', () => {
    expect(loadAppConfig({ TMDB_API_KEY: '' }).tmdbApiKey).toBeUndefined();
    expect(loadAppConfig({ TMDB_API_KEY: '   ' }).tmdbApiKey).toBeUndefined();
  });

  it('trims surrounding whitespace from the key', () => {
    // A newline pasted in from a config page is the common case.
    expect(loadAppConfig({ TMDB_API_KEY: '  abc123\n' }).tmdbApiKey).toBe('abc123');
  });

  it('never falls back to a hardcoded key', () => {
    // The key is operator-supplied via the future /configure page. Nothing in
    // this repo may carry a default: a hardcoded fallback would make the
    // add-on depend on one person's credential, and would leak it on push.
    expect(loadAppConfig({}).tmdbApiKey).toBeUndefined();
    expect(loadAppConfig({ TMDB_API_KEY: '' }).tmdbApiKey).toBeUndefined();
  });
});
