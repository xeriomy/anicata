import { describe, it, expect, vi } from 'vitest';
import {
  CatalogService,
  catalogCacheKey,
  searchCacheKey,
} from '../src/services/catalog.service.js';
import { TTLCache } from '../src/cache/store.js';
import { SourceChain } from '../src/sources/chain.js';
import { CircuitBreaker } from '../src/net/breaker.js';
import type { ChainResult } from '../src/sources/chain.js';
import type { SourceId } from '../src/sources/types.js';
import type { Anime } from '../src/domain/anime.js';

const mkAnime = (tag: string, n: number): Anime => ({
  identity: tag === 'kitsu' ? { kitsu: n } : { anilist: n },
  title: { synonyms: [] },
  displayTitle: `${tag} Title ${String(n)}`,
  format: 'TV',
  status: 'FINISHED',
  type: 'anime',
  genres: [],
  tags: [],
  studios: [],
  relations: [],
  images: {},
  hashtags: [],
});

interface FakeChain {
  peekSticky: ReturnType<typeof vi.fn<() => SourceId | undefined>>;
  fetchPage: ReturnType<typeof vi.fn<() => Promise<ChainResult>>>;
  search: ReturnType<typeof vi.fn<() => Promise<ChainResult>>>;
}

function chainResult(sourceId: SourceId, tag: string, n: number): ChainResult {
  return {
    items: [mkAnime(tag, n)],
    total: 1,
    sourceId,
    fromFallback: sourceId !== 'anilist',
  };
}

/** Serves every page from one fixed source. `sticky` controls peekSticky. */
function fakeChain(sourceId: SourceId, sticky: SourceId | undefined = sourceId): FakeChain {
  const res = chainResult(sourceId, sourceId, sourceId === 'kitsu' ? 101 : 1);
  return {
    peekSticky: vi.fn(() => sticky),
    fetchPage: vi.fn(async () => res),
    search: vi.fn(async () => res),
  };
}

describe('catalogCacheKey / searchCacheKey', () => {
  it('a Kitsu page and an AniList page at the same (catalogId, skip) occupy different keys', () => {
    expect(catalogCacheKey('kitsu', 'anime-trending', undefined, 0)).not.toBe(
      catalogCacheKey('anilist', 'anime-trending', undefined, 0),
    );
  });

  it('the same source is stable across calls', () => {
    expect(catalogCacheKey('anilist', 'anime-trending', undefined, 0)).toBe(
      catalogCacheKey('anilist', 'anime-trending', undefined, 0),
    );
  });

  it('a genre and a different skip still separate', () => {
    const base = catalogCacheKey('anilist', 'anime-trending', undefined, 0);
    expect(catalogCacheKey('anilist', 'anime-trending', 'Action', 0)).not.toBe(base);
    expect(catalogCacheKey('anilist', 'anime-trending', undefined, 100)).not.toBe(base);
  });

  it('search keys are namespaced too', () => {
    expect(searchCacheKey('kitsu', 'bebop', 0)).not.toBe(searchCacheKey('anilist', 'bebop', 0));
    expect(searchCacheKey('anilist', 'bebop', 0)).toBe(searchCacheKey('anilist', 'bebop', 0));
    expect(searchCacheKey('anilist', 'bebop', 100)).not.toBe(searchCacheKey('anilist', 'bebop', 0));
  });
});

describe('CatalogService over SourceChain', () => {
  it('a Kitsu page no longer overwrites an AniList page at the same (catalogId, skip)', async () => {
    const cache = new TTLCache();
    const anilistChain = fakeChain('anilist');
    const kitsuChain = fakeChain('kitsu');
    const svcA = new CatalogService({ source: anilistChain as never, cache });
    const svcB = new CatalogService({ source: kitsuChain as never, cache });
    const a = await svcA.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    const b = await svcB.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(a.items[0]?.displayTitle).toBe('anilist Title 1');
    expect(b.items[0]?.displayTitle).toBe('kitsu Title 101');
    // Both sources were actually consulted: no silent merge.
    expect(anilistChain.fetchPage).toHaveBeenCalledTimes(1);
    expect(kitsuChain.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('a repeated page is served from the serving source key without a second chain call', async () => {
    const anilistChain = fakeChain('anilist');
    const svc = new CatalogService({ source: anilistChain as never, cache: new TTLCache() });
    const args = { catalogId: 'anime-trending', type: 'anime', skip: 0 };
    const a = await svc.getCatalogPage(args);
    const b = await svc.getCatalogPage(args);
    expect(a.items[0]?.displayTitle).toBe(b.items[0]?.displayTitle);
    expect(anilistChain.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('derives the sticky key from (catalogId, genre): two pages, one primary attempt', async () => {
    // Real chain: the primary always fails over, so without stickiness every
    // page would cost a primary call. The service passes no stickyKey of its
    // own — the derived `${catalogId}:${genre}` key must still stick.
    const primary = {
      id: 'anilist' as SourceId,
      fetchPage: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { kind: 'server_error' })),
      search: vi.fn(),
      fetchById: vi.fn(),
    };
    const fallback = {
      id: 'kitsu' as SourceId,
      fetchPage: vi
        .fn()
        .mockResolvedValue({ items: [mkAnime('kitsu', 101)], total: 1 }),
      search: vi.fn(),
      fetchById: vi.fn(),
    };
    const now = (): number => 0;
    const chain = new SourceChain({
      sources: [primary as never, fallback as never],
      breakers: new Map<SourceId, CircuitBreaker>([
        ['anilist', new CircuitBreaker({ failureThreshold: 100, cooldownMs: 30_000, now })],
        ['kitsu', new CircuitBreaker({ failureThreshold: 100, cooldownMs: 30_000, now })],
      ]),
    });
    const svc = new CatalogService({ source: chain, cache: new TTLCache() });
    await svc.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    await svc.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 100 });
    expect(fallback.fetchPage).toHaveBeenCalledTimes(2);
    // Second page skipped the primary outright: the derived key stuck.
    expect(primary.fetchPage).toHaveBeenCalledTimes(1);
    // And the chain received the derived key, not an ad-hoc one.
    expect(chain.peekSticky('anime-trending:')).toBe('kitsu');
  });

  it('passes genre through to the chain request', async () => {
    const anilistChain = fakeChain('anilist');
    const svc = new CatalogService({ source: anilistChain as never, cache: new TTLCache() });
    await svc.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0, genre: 'Action' });
    expect(anilistChain.fetchPage).toHaveBeenCalledWith(
      'anime-trending',
      { catalogId: 'anime-trending', skip: 0, limit: 100, genre: 'Action' },
      'anime-trending:Action',
    );
  });

  it('search pages are keyed by serving source and served from cache on repeat', async () => {
    const anilistChain = fakeChain('anilist');
    const kitsuChain = fakeChain('kitsu');
    const cache = new TTLCache();
    const svcA = new CatalogService({ source: anilistChain as never, cache });
    const svcB = new CatalogService({ source: kitsuChain as never, cache });
    const a = await svcA.search({ term: 'bebop', skip: 0 });
    const b = await svcB.search({ term: 'bebop', skip: 0 });
    expect(a.items[0]?.displayTitle).toBe('anilist Title 1');
    expect(b.items[0]?.displayTitle).toBe('kitsu Title 101');
    const again = await svcA.search({ term: 'bebop', skip: 0 });
    expect(again.items[0]?.displayTitle).toBe('anilist Title 1');
    expect(anilistChain.search).toHaveBeenCalledTimes(1);
  });
});
