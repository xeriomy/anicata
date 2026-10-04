import { describe, it, expect, vi } from 'vitest';
import { CatalogService } from '../src/services/catalog.service.js';
import { TTLCache } from '../src/cache/store.js';
import { PAGE_SIZE } from '../src/sources/catalog-def.js';

const ids = (items: { identity: { anilist: number } }[]) => items.map(i => i.identity.anilist);
const mk = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ identity: { anilist: from + i } })) as never;

function svc(source: unknown, cache = new TTLCache()) {
  return { s: new CatalogService({ source: source as never, cache }), cache, source };
}

describe('CatalogService.getCatalogPage', () => {
  it('returns exactly 100 items for skip=0 using two AniList pages', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValueOnce({ items: mk(50), total: 5000 })
                                                .mockResolvedValueOnce({ items: mk(50, 50), total: 5000 }),
                     search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(r.items).toHaveLength(PAGE_SIZE);
    expect(source.fetchCatalogPage).toHaveBeenCalledTimes(2);
    expect(ids(r.items)).toHaveLength(100);
  });

  it('slices [skip, skip+100) so skip=100 shares no ids with skip=0', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ identity: { anilist: i + 1 } }));
    const source = {
      fetchCatalogPage: vi.fn(async ({ page }: { page: number }) =>
        ({ items: all.slice((page - 1) * 50, page * 50) as never, total: 5000 })),
      search: vi.fn(),
    };
    const { s } = svc(source);
    const p0 = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    const p1 = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 100 });
    expect(p0.items).toHaveLength(100);
    expect(p1.items).toHaveLength(100);
    expect(ids(p1.items).some(id => ids(p0.items).includes(id))).toBe(false);
    expect(ids(p1.items)[0]).toBe(101);
  });

  it('returns a short final page rather than padding', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ identity: { anilist: i + 1 } }));
    const source = {
      fetchCatalogPage: vi.fn(async ({ page }: { page: number }) =>
        ({ items: all.slice((page - 1) * 50, page * 50) as never, total: 120 })),
      search: vi.fn(),
    };
    const { s } = svc(source);
    expect((await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 100 })).items).toHaveLength(20);
  });

  it('returns an empty page past the end so pagination terminates', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: [], total: 120 }), search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 5000 });
    expect(r.items).toEqual([]);
    expect(r.cacheMaxAge).toBeLessThanOrEqual(60);
  });

  it('does NOT pad a short page back to 100 items', async () => {
    // A short page means the end of the list; padding would make Nuvio's nextSkip
    // point past data and strand the user on an empty page.
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: mk(12), total: 5000 }), search: vi.fn() };
    const { s } = svc(source);
    expect((await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 })).items).toHaveLength(12);
  });

  it('caches by catalog+skip so a repeated skip yields identical ids', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: mk(50), total: 5000 }), search: vi.fn() };
    const { s } = svc(source);
    const a = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    const b = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(ids(a.items)).toEqual(ids(b.items));
    expect(source.fetchCatalogPage).toHaveBeenCalledTimes(2); // second call served from cache
  });

  it('keys the cache by genre as well as catalog and skip', async () => {
    const source = { fetchCatalogPage: vi.fn().mockResolvedValue({ items: mk(50), total: 5000 }), search: vi.fn() };
    const { s } = svc(source);
    await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0, genre: 'Action' });
    expect(source.fetchCatalogPage).toHaveBeenCalledTimes(4);
  });

  it('rejects an unknown catalog id without touching the source', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-nope', type: 'anime', skip: 0 });
    expect(r.items).toEqual([]);
    expect(source.fetchCatalogPage).not.toHaveBeenCalled();
  });

  it('rejects a mismatched type without touching the source', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn() };
    const { s } = svc(source);
    expect((await s.getCatalogPage({ catalogId: 'anime-trending', type: 'movie', skip: 0 })).items).toEqual([]);
    expect(source.fetchCatalogPage).not.toHaveBeenCalled();
  });

  it('serves stale from the cache when the source throws', async () => {
    let fail = false;
    const source = {
      fetchCatalogPage: vi.fn(async () => {
        if (fail) throw Object.assign(new Error('down'), { kind: 'server_error' });
        return { items: mk(50), total: 5000 };
      }),
      search: vi.fn(),
    };
    let now = 0;
    const cache = new TTLCache({ now: () => now });
    const { s } = svc(source, cache);
    const first = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    fail = true;
    now += 20 * 60 * 1000; // past the 15-minute TTL, inside the 6-hour stale window
    const second = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(second.freshness).toBe('stale');
    expect(ids(second.items)).toEqual(ids(first.items));
  });

  it('returns an empty page, not an exception, when the source fails with no cache', async () => {
    const source = { fetchCatalogPage: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { kind: 'timeout' })), search: vi.fn() };
    const { s } = svc(source);
    const r = await s.getCatalogPage({ catalogId: 'anime-trending', type: 'anime', skip: 0 });
    expect(r.items).toEqual([]);
  });
});

describe('CatalogService.search', () => {
  it('returns items for a term', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn().mockResolvedValue({ items: mk(3), total: 3 }) };
    const { s } = svc(source);
    expect((await s.search({ term: 'cowboy bebop', skip: 0 })).items).toHaveLength(3);
    expect(source.search).toHaveBeenCalledWith('cowboy bebop', 1);
  });

  it('returns empty without calling the source for a blank term', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn() };
    const { s } = svc(source);
    expect((await s.search({ term: '   ', skip: 0 })).items).toEqual([]);
    expect(source.search).not.toHaveBeenCalled();
  });

  it('truncates a very long term to 200 characters', async () => {
    const source = { fetchCatalogPage: vi.fn(), search: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    const { s } = svc(source);
    await s.search({ term: 'x'.repeat(500), skip: 0 });
    expect(String(source.search.mock.calls[0]![0]).length).toBe(200);
  });
});
