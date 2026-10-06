import { describe, it, expect, vi } from 'vitest';
import { MetaService } from '../src/services/meta.service.js';
import { TTLCache } from '../src/cache/store.js';
import { AniListSource } from '../src/sources/anilist/adapter.js';
import { SourceError } from '../src/domain/errors.js';

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

  it('caches a missing title for only 60 seconds, not the 7-day metadata TTL', async () => {
    // A title AniList lacks today may exist tomorrow. If the negative cache used
    // META_TTL_MS, a newly-added title would be invisible for 7 days with no error.
    let now = 0;
    const cache = new TTLCache({ now: () => now });
    const source = { fetchById: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(onePiece) };
    const s = new MetaService({ source, cache });

    const first = await s.getByAnilistId(777);
    expect(first.anime).toBeNull();
    expect(source.fetchById).toHaveBeenCalledTimes(1);

    // The miss is briefly cached (not served as a hit, but present with a short TTL).
    expect(cache.get('meta:anilist:777')).toBeDefined();

    now += 61_000; // past the 60s negative window, far inside META_TTL_MS

    // The negative entry must have expired: with a 7-day TTL it would still be here.
    expect(cache.get('meta:anilist:777')).toBeUndefined();

    const second = await s.getByAnilistId(777);
    expect(source.fetchById).toHaveBeenCalledTimes(2);
    expect(second.anime).not.toBeNull();
  });

  it('stores a 60-second negative entry when the source 404s on an unknown id', async () => {
    // User-visible consequence of the AniList 404 fix, wired end to end:
    // HttpClient rejects with a 404 SourceError, the source resolves null
    // (instead of throwing), so MetaService records the miss for 60 s and
    // reports cacheMaxAge 60. A throw would leave no entry and report 10,
    // sending every repeat lookup back upstream against the 30 req/min budget.
    const getJson = vi.fn().mockRejectedValue(
      new SourceError('invalid_request', 'GET https://graphql.anilist.co failed with status 404', 404),
    );
    const source = new AniListSource({
      http: { getJson } as never,
      limiter: { tryAcquire: () => true, available: () => 25, msUntilNextToken: () => 0 } as never,
    });
    const cache = new TTLCache();
    const s = new MetaService({ source, cache });
    const r = await s.getByAnilistId(99999999);
    expect(r.anime).toBeNull();
    expect(r.cacheMaxAge).toBe(60);
    expect(cache.get('meta:anilist:99999999')).toBeDefined();
  });
});
