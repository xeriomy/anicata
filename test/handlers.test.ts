import { describe, it, expect, vi } from 'vitest';
import { parseExtra, createCatalogHandler } from '../src/addon/catalog.js';
import { parseMetaId, createMetaHandler } from '../src/addon/meta.js';
import type { CatalogService } from '../src/services/catalog.service.js';
import type { MetaService, MetaResult } from '../src/services/meta.service.js';
import type { Anime } from '../src/domain/anime.js';

describe('parseExtra', () => {
  it('defaults skip to 0 when absent', () => {
    expect(parseExtra(undefined).skip).toBe(0);
    expect(parseExtra({}).skip).toBe(0);
  });
  it('coerces skip from the string querystring delivers', () => {
    expect(parseExtra({ skip: '100' }).skip).toBe(100);
  });
  it('treats a non-numeric, negative or absent skip as 0', () => {
    expect(parseExtra({ skip: 'abc' }).skip).toBe(0);
    expect(parseExtra({ skip: '-5' }).skip).toBe(0);
    expect(parseExtra({ skip: '' }).skip).toBe(0);
  });
  it('takes the first value when a repeated key arrives as an array', () => {
    expect(parseExtra({ skip: ['100', '200'] }).skip).toBe(100);
  });
  it('preserves search and genre verbatim', () => {
    expect(parseExtra({ search: 'bebop', genre: 'Action' })).toMatchObject({ search: 'bebop', genre: 'Action' });
  });
  it('drops blank search and genre after trimming', () => {
    expect(parseExtra({ search: '   ' })).not.toHaveProperty('search');
    expect(parseExtra({ genre: '' })).not.toHaveProperty('genre');
  });
});

const anime: Anime = {
  identity: { anilist: 21 },
  title: { synonyms: [] },
  displayTitle: 'ONE PIECE',
  format: 'TV',
  status: 'FINISHED',
  type: 'anime',
  genres: [],
  tags: [],
  studios: [],
  relations: [],
  images: {},
  hashtags: [],
};

function fakeService(overrides: {
  getCatalogPage?: (args: { catalogId: string; type: string; genre?: string; skip: number }) => Promise<{ items: Anime[]; cacheMaxAge: number; freshness: 'fresh' | 'stale' }>;
  search?: (args: { term: string; skip: number }) => Promise<{ items: Anime[]; cacheMaxAge: number; freshness: 'fresh' | 'stale' }>;
} = {}): CatalogService {
  return {
    getCatalogPage: vi.fn(async () => ({ items: [], cacheMaxAge: 60, freshness: 'fresh' as const })),
    search: vi.fn(async () => ({ items: [], cacheMaxAge: 60, freshness: 'fresh' as const })),
    ...overrides,
  } as unknown as CatalogService;
}

describe('createCatalogHandler', () => {
  it('routes anime-search with a term to catalogService.search', async () => {
    const service = fakeService({
      search: vi.fn(async () => ({ items: [anime], cacheMaxAge: 1800, freshness: 'fresh' as const })),
    });
    const handler = createCatalogHandler({ catalogService: service });
    const res = await handler({ type: 'anime', id: 'anime-search', extra: { search: 'one piece' } });
    expect(service.search as unknown as { mock: { calls: unknown[][] } }).toHaveBeenCalledWith({ term: 'one piece', skip: 0 });
    expect(res.metas).toHaveLength(1);
    expect(res.metas[0]?.id).toBe('anilist:21');
    expect(res.cacheMaxAge).toBe(1800);
  });

  it('routes other ids to getCatalogPage with genre and skip', async () => {
    const service = fakeService({
      getCatalogPage: vi.fn(async () => ({ items: [anime], cacheMaxAge: 900, freshness: 'fresh' as const })),
    });
    const handler = createCatalogHandler({ catalogService: service });
    const res = await handler({ type: 'anime', id: 'anime-trending', extra: { skip: '100', genre: 'Action' } });
    expect(service.getCatalogPage as unknown as { mock: { calls: unknown[][] } }).toHaveBeenCalledWith({
      catalogId: 'anime-trending',
      type: 'anime',
      genre: 'Action',
      skip: 100,
    });
    expect(res.metas).toHaveLength(1);
    expect(res.cacheMaxAge).toBe(900);
  });

  it('falls back to getCatalogPage for anime-search without a search term', async () => {
    const service = fakeService();
    const handler = createCatalogHandler({ catalogService: service });
    await handler({ type: 'anime', id: 'anime-search' });
    expect((service.getCatalogPage as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
    expect((service.search as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it('never throws: returns empty metas with a short cache on upstream failure', async () => {
    const service = fakeService({
      getCatalogPage: vi.fn(async () => { throw new Error('upstream down'); }),
    });
    const handler = createCatalogHandler({ catalogService: service });
    const res = await handler({ type: 'anime', id: 'anime-trending' });
    expect(res).toEqual({ metas: [], cacheMaxAge: 10 });
  });
});

describe('parseMetaId', () => {
  it('parses anilist:21', () => {
    expect(parseMetaId('anilist:21')).toEqual({ namespace: 'anilist', value: '21' });
  });
  it('parses kitsu:12', () => {
    expect(parseMetaId('kitsu:12')).toEqual({ namespace: 'kitsu', value: '12' });
  });
  it('ignores a Stremio video suffix of :season:episode', () => {
    expect(parseMetaId('anilist:21:1:5')).toEqual({ namespace: 'anilist', value: '21' });
  });
  it('rejects a bare number, which Nuvio would have read as a Trakt id', () => {
    expect(parseMetaId('21')).toBeNull();
  });
  it('rejects a blank or malformed id', () => {
    expect(parseMetaId('')).toBeNull();
    expect(parseMetaId('anilist:')).toBeNull();
    expect(parseMetaId('anilist:abc')).toBeNull();
    expect(parseMetaId(':21')).toBeNull();
    expect(parseMetaId('imdb:tt0388629')).toBeNull(); // Phase 1 supports anilist/kitsu only
    expect(parseMetaId('tt0388629')).toBeNull();
  });
  it('is case-sensitive about the namespace', () => {
    expect(parseMetaId('AniList:21')).toBeNull();
  });
});

function fakeMetaService(overrides?: {
  getByAnilistId?: (id: number) => Promise<MetaResult>;
}): MetaService {
  return {
    getByAnilistId: vi.fn(async () => ({ anime: null, cacheMaxAge: 60, freshness: 'fresh' as const })),
    ...overrides,
  } as unknown as MetaService;
}

describe('createMetaHandler', () => {
  it('returns Unavailable with cacheMaxAge 60 and zero service calls for an unparseable id', async () => {
    const service = fakeMetaService();
    const handler = createMetaHandler({ metaService: service });
    const res = await handler({ type: 'anime', id: '21' });
    expect(res.meta).toMatchObject({ id: '21', type: 'anime', name: 'Unavailable' });
    expect(res.cacheMaxAge).toBe(60);
    expect((service.getByAnilistId as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it('returns Unavailable with cacheMaxAge 60 without calling the service for kitsu: ids', async () => {
    const service = fakeMetaService();
    const handler = createMetaHandler({ metaService: service });
    const res = await handler({ type: 'anime', id: 'kitsu:12' });
    expect(res.meta).toMatchObject({ id: 'kitsu:12', type: 'anime', name: 'Unavailable' });
    expect(res.cacheMaxAge).toBe(60);
    expect((service.getByAnilistId as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it('returns Unavailable with cacheMaxAge 60 when the anime is unknown', async () => {
    const service = fakeMetaService({
      getByAnilistId: vi.fn(async () => ({ anime: null, cacheMaxAge: 60, freshness: 'fresh' as const })),
    });
    const handler = createMetaHandler({ metaService: service });
    const res = await handler({ type: 'anime', id: 'anilist:999999' });
    expect(service.getByAnilistId as unknown as { mock: { calls: unknown[][] } }).toHaveBeenCalledWith(999999);
    expect(res.meta).toMatchObject({ id: 'anilist:999999', type: 'anime', name: 'Unavailable' });
    expect(res.cacheMaxAge).toBe(60);
  });

  it('returns renderDetail output with the service cacheMaxAge on a hit', async () => {
    const service = fakeMetaService({
      getByAnilistId: vi.fn(async () => ({ anime, cacheMaxAge: 604800, freshness: 'fresh' as const })),
    });
    const handler = createMetaHandler({ metaService: service });
    const res = await handler({ type: 'anime', id: 'anilist:21' });
    expect(service.getByAnilistId as unknown as { mock: { calls: unknown[][] } }).toHaveBeenCalledWith(21);
    expect(res.meta).toMatchObject({ id: 'anilist:21', type: 'anime', name: 'ONE PIECE' });
    expect(res.cacheMaxAge).toBe(604800);
  });

  it('never throws: returns Unavailable with cacheMaxAge 10 when the service fails', async () => {
    const service = fakeMetaService({
      getByAnilistId: vi.fn(async () => { throw new Error('upstream down'); }),
    });
    const handler = createMetaHandler({ metaService: service });
    const res = await handler({ type: 'anime', id: 'anilist:21' });
    expect(res.meta).toMatchObject({ id: 'anilist:21', type: 'anime', name: 'Unavailable' });
    expect(res.cacheMaxAge).toBe(10);
  });
});
