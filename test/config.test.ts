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
});
