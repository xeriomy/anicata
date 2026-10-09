import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveToCanonical, clearIdentityCacheState } from '../src/identity/resolver.js';
import { loadBundle } from '../src/identity/bundle.js';
import { SourceError } from '../src/domain/errors.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

// An id that is not in the 32,381-row bundle, so the Kitsu and AniZip legs run.
const HIGH_ANILIST = 'anilist:99999999';

// Real AniZip capture: /mappings?anilist_id=21 (One Piece). The `mappings`
// block is the only part the tier is allowed to consume.
const AniZip21 = load('../test/fixtures/identity/anizip-21.json');

function fakeHttp(payloads: unknown[]) {
  const getJson = vi.fn<
    (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
      data: unknown;
      headers: Record<string, string>;
      status: number;
    }>
  >(async () => {
    const next = payloads.shift();
    return { data: next, headers: {}, status: 200 };
  });
  return { http: { getJson } as never, getJson };
}

const realBundle = loadBundle('data/identity.min.json.gz');

// The AniZip 404 cache is module-global for the process lifetime. Without this
// reset, an earlier test's 404 for `anilist:99999999` suppresses the AniZip call
// every later test expects.
beforeEach(() => {
  clearIdentityCacheState();
});

describe('Tier 2 — AniZip', () => {
  it('resolves an anilist id from a real AniZip mappings block', async () => {
    // Kitsu misses (empty data), then AniZip answers with the real capture.
    const fake = fakeHttp([{ data: [] }, AniZip21]);
    const result = await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);

    expect(result).not.toBeNull();
    expect(result).toHaveProperty('anilist', 21);
  });

  it('sends exactly one query parameter (duplicates are a real 500)', async () => {
    const fake = fakeHttp([{ data: [] }, AniZip21]);
    await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    const anizipCall = fake.getJson.mock.calls.at(-1)!;
    const url = new URL(anizipCall[0]);
    expect([...url.searchParams.keys()]).toEqual(['anilist_id']);
  });

  it('maps the bare themoviedb string into { tv } with no movie key', async () => {
    const fake = fakeHttp([{ data: [] }, AniZip21]);
    const result = await resolveToCanonical('anilist:99999999', fake.http, realBundle);
    expect(result).toHaveProperty('tmdb', { tv: 37854 });
  });

  it('consumes only the mappings block, never episodes or images', async () => {
    const fake = fakeHttp([{ data: [] }, AniZip21]);
    const result = await resolveToCanonical('anilist:99999999', fake.http, realBundle);
    // Every key on the resolved identity is a namespace id — never episode or
    // image data from the same 1.87 MB response.
    const allowed = new Set([
      'anilist', 'mal', 'kitsu', 'anidb', 'tmdb', 'imdb', 'tvdb', 'simkl',
    ]);
    for (const key of Object.keys(result ?? {})) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('a 404 is a tier miss and is negative-cached (no further calls)', async () => {
    // Call 1: Kitsu misses (empty data). Call 2 is the AniZip leg, which
    // HttpClient turns into a thrown SourceError('not_found') — the fake must
    // throw the real shape, or the test proves nothing.
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url) => {
      if (url.includes('api.ani.zip')) {
        throw new SourceError('not_found', `GET ${url} failed with status 404`, 404);
      }
      return { data: [], headers: {}, status: 200 };
    });
    const http = { getJson } as never;

    const first = await resolveToCanonical(HIGH_ANILIST, http, realBundle);
    expect(first).toBeNull();

    const anizipCallsAfterFirst = getJson.mock.calls.filter((c) => c[0].includes('api.ani.zip')).length;
    const second = await resolveToCanonical(HIGH_ANILIST, http, realBundle);
    expect(second).toBeNull();
    // The negative cache must absorb the repeat: AniZip is not called again.
    // (The Kitsu tier legitimately runs again — the cache guards this tier only.)
    expect(getJson.mock.calls.filter((c) => c[0].includes('api.ani.zip')).length).toBe(
      anizipCallsAfterFirst,
    );
  });

  it('is skipped entirely, with no network call, when the budget is exhausted', async () => {
    const fake = fakeHttp([{ data: [] }, AniZip21]);
    const result = await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle, 199);
    expect(result).toBeNull();
    expect(fake.getJson).not.toHaveBeenCalled();
  });

  it('the tier cap never exceeds the remaining budget', async () => {
    const fake = fakeHttp([{ data: [] }, AniZip21]);
    await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    const anizipCall = fake.getJson.mock.calls.at(-1)!;
    expect(anizipCall[1]?.timeoutMs).toBeLessThanOrEqual(900);
  });
});

describe('Tier 2 — the shared deadline is measured, not restated', () => {
  const AniZipOk = { mappings: { anilist_id: 21, mal_id: 21, kitsu_id: 12 } };

  it('AniZip receives the REMAINING budget after a slow Kitsu leg', async () => {
    // Injected clock, not a fake timer: each Kitsu call costs 700 ms of wall
    // time, so the AniZip leg must be offered 1500 - 700 = 800 ms.
    let t = 0;
    const now = (): number => t;
    const calls: Array<[string, number | undefined]> = [];
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url, init) => {
      calls.push([url.includes('api.ani.zip') ? 'anizip' : 'kitsu', init?.timeoutMs]);
      if (!url.includes('api.ani.zip')) t += 700;
      return url.includes('api.ani.zip')
        ? { data: AniZipOk, headers: {}, status: 200 }
        : { data: [], headers: {}, status: 200 };
    });

    const result = await resolveToCanonical(
      'anilist:99999999',
      { getJson } as never,
      realBundle,
      1500,
      now,
    );
    expect(result).not.toBeNull();

    const anizip = calls.filter((c) => c[0] === 'anizip').at(-1);
    expect(calls.length).toBe(2);
    expect(anizip?.[1]).toBe(800);
    expect(700 + (anizip?.[1] ?? 0)).toBeLessThanOrEqual(1500);
  });

  it('the tier caps sum cannot exceed the shared deadline at any elapsed point', async () => {
    // Kitsu burns its cap slowly; AniZip must never be offered the full 900.
    let t = 0;
    const now = (): number => t;
    const caps: number[] = [];
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url, init) => {
      caps.push(init?.timeoutMs ?? 0);
      if (!url.includes('api.ani.zip')) t += 650;
      return { data: { mappings: { anilist_id: 21, mal_id: 21, kitsu_id: 12 } }, headers: {}, status: 200 };
    });

    await resolveToCanonical('anilist:99999999', { getJson } as never, realBundle, 1500, now);

    expect(caps.length).toBe(2);
    // 1500 total budget, minus the 650 ms the first tier actually spent.
    expect(caps.at(-1)).toBeLessThanOrEqual(850);
  });
});
