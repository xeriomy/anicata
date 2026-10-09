import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ResolveService } from '../src/services/resolve.service.js';
import { loadBundle } from '../src/identity/bundle.js';
import { TTLCache } from '../src/cache/store.js';
import type { HttpClient } from '../src/net/http.js';
import { SourceError } from '../src/domain/errors.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const AniZip21 = load('../test/fixtures/identity/anizip-21.json');

const bundle = loadBundle('data/identity.min.json.gz');
const HIGH = 'anilist:99999999'; // not in the bundle, so live tiers run

/** An HTTP layer that misses Kitsu and answers AniZip with the real capture. */
function liveHttp() {
  const getJson = vi.fn<
    (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
      data: unknown;
      headers: Record<string, string>;
      status: number;
    }>
  >(async (url) =>
    url.includes('api.ani.zip')
      ? { data: AniZip21, headers: {}, status: 200 }
      : { data: [], headers: {}, status: 200 },
  );
  return { http: { getJson } as unknown as HttpClient, getJson };
}

const MIN = 60_000;
const NEGATIVE_TTL_MS = 10 * MIN;

describe('ResolveService caching', () => {
  it('a positive resolution is served from cache with zero upstream calls', async () => {
    const { http, getJson } = liveHttp();
    const svc = new ResolveService({ http, bundle, cache: new TTLCache() });

    const first = await svc.resolveToCanonical('mal:99999999');
    const callsAfterFirst = getJson.mock.calls.length;
    expect(first).not.toBeNull();

    const second = await svc.resolveToCanonical('mal:99999999');
    expect(second).toEqual(first);
    expect(getJson.mock.calls.length).toBe(callsAfterFirst);
  });

  it('a negative result is cached and re-resolved only after its TTL', async () => {
    // Every tier misses: Kitsu empty, AniZip 404.
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async () => {
      throw new SourceError('not_found', '404', 404);
    });
    const http = { getJson } as unknown as HttpClient;
    let now = 0;
    const cache = new TTLCache({ now: () => now });
    const svc = new ResolveService({ http, bundle, cache });

    const before = await svc.resolveToCanonical(HIGH);
    expect(before).toBeNull();
    const callsBefore = getJson.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    // Inside the 10-minute negative window: no re-fetch.
    now = NEGATIVE_TTL_MS - 1;
    expect(await svc.resolveToCanonical(HIGH)).toBeNull();
    expect(getJson.mock.calls.length).toBe(callsBefore);

    // Past it: re-resolved.
    now = NEGATIVE_TTL_MS + 1;
    await svc.resolveToCanonical(HIGH);
    expect(getJson.mock.calls.length).toBeGreaterThan(callsBefore);
  });


  it('a 429 suppresses the next tier and serves a stale positive entry', async () => {
    // Warm the positive cache through a healthy tier set (Kitsu miss, AniZip
    // hit). Then break BOTH live tiers with a 429 from Kitsu: per ADR-011 a
    // rate-limit is not a fallback trigger, so AniZip must never be called —
    // and the already-cached identity must be served instead of null.
    const cache = new TTLCache();
    const good = liveHttp();
    const svc = new ResolveService({ http: good.http, bundle, cache });
    const warmed = await svc.resolveToCanonical('mal:99999999');
    expect(warmed).not.toBeNull();

    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url) => {
      if (url.includes('kitsu.io')) {
        throw new SourceError('rate_limited', '429', 429);
      }
      throw new SourceError('server_error', 'anizip would have answered', 500);
    });
    const broken = new ResolveService({
      http: { getJson } as unknown as HttpClient,
      bundle,
      cache,
    });

    const served = await broken.resolveToCanonical('mal:99999999');

    expect(served).toEqual(warmed);
    expect(getJson.mock.calls.filter((c) => c[0].includes('api.ani.zip')).length).toBe(0);
  });

  it('a 429 with nothing cached stays null rather than cascading tiers', async () => {
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url) => {
      if (url.includes('kitsu.io')) {
        throw new SourceError('rate_limited', '429', 429);
      }
      return { data: AniZip21, headers: {}, status: 200 };
    });
    const svc = new ResolveService({
      http: { getJson } as unknown as HttpClient,
      bundle,
      cache: new TTLCache(),
    });

    await expect(svc.resolveToCanonical('anilist:99999999')).resolves.toBeNull();
    // ADR-011: no next-tier call after a 429.
    expect(getJson.mock.calls.filter((c) => c[0].includes('api.ani.zip')).length).toBe(0);
  });

});
