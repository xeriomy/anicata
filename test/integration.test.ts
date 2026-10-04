import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/index.js';
import type { Anime } from '../src/domain/anime.js';

const fake = (id: number, over: Partial<Anime> = {}): Anime => ({
  identity: { anilist: id }, title: { romaji: `T${id}`, english: `T${id}`, synonyms: [] },
  displayTitle: `T${id}`, description: 'desc', format: 'TV', status: 'FINISHED',
  type: 'anime', episodes: 12, durationMinutes: 24, releaseDate: '2020-01-01',
  releaseYear: 2020, genres: ['Action'], tags: [], studios: [],
  relations: [], images: { poster: `https://img/${id}.jpg`, background: `https://img/${id}b.jpg` },
  scoreAnilist: 80, hashtags: [], ...over,
});

const app = createApp({
  catalogService: {
    // Mirrors the real CatalogService: only the known catalogue resolves, and
    // an empty page carries the 60 s "nothing here" TTL rather than the
    // 900 s full-page TTL.
    getCatalogPage: async ({ catalogId, skip }) => {
      const items = catalogId === 'anime-trending' && skip === 0
        ? Array.from({ length: 100 }, (_, i) => fake(i + 1))
        : [];
      return { items, cacheMaxAge: items.length > 0 ? 900 : 60, freshness: 'fresh' };
    },
    search: async () => ({ items: [fake(1)], cacheMaxAge: 1800, freshness: 'fresh' }),
  } as never,
  metaService: { getByAnilistId: async (id: number) =>
    id === 21 ? { anime: fake(21, { countryOfOrigin: 'JP' }), cacheMaxAge: 604800, freshness: 'fresh' }
              : { anime: null, cacheMaxAge: 60, freshness: 'fresh' } } as never,
});

describe('GET /manifest.json', () => {
  it('returns 200 with a valid manifest and a Cache-Control header', async () => {
    const res = await supertest(app).get('/manifest.json');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('org.anicata.anime');
    expect(res.body.name).toBeTruthy();
    expect(res.body.version).toBeTruthy();
    expect(res.headers['cache-control']).toContain('max-age=');
  });

  it('sets CORS headers, which the protocol requires', async () => {
    const res = await supertest(app).get('/manifest.json');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('serves the manifest logo at the path the manifest declares', async () => {
    const manifest = await supertest(app).get('/manifest.json');
    const logoPath = manifest.body.logo as string;
    expect(logoPath).toBe('/logo.png');
    const logo = await supertest(app).get(logoPath);
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toMatch(/^image\//);
    expect(logo.body.length).toBeGreaterThan(0);
  });
});

describe('GET /catalog/:type/:id.json', () => {
  it('returns exactly 100 metas for skip=0, each with id, type and name', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-trending.json');
    expect(res.status).toBe(200);
    expect(res.body.metas).toHaveLength(100);
    for (const m of res.body.metas) {
      expect(m.id).toMatch(/^anilist:\d+$/);
      expect(m.type).toBe('anime');
      expect(m.name.trim()).not.toBe('');
    }
  });

  it('emits banner alongside background', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-trending.json');
    expect(res.body.metas[0].banner).toBe(res.body.metas[0].background);
  });

  it('serves the skip extra as a path segment', async () => {
    // Protocol shape: the extra segment precedes `.json` (the SDK router only
    // matches `/:id/:extra?.json`).
    const res = await supertest(app).get('/catalog/anime/anime-trending/skip=100.json');
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([]);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('serves search as a path-segment extra', async () => {
    const res = await supertest(app).get('/catalog/anime/anime-search/search=bebop.json');
    expect(res.status).toBe(200);
    expect(res.body.metas).toHaveLength(1);
  });

  it('returns an empty list for an unknown catalogue instead of a 404', async () => {
    const res = await supertest(app).get('/catalog/anime/does-not-exist.json');
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([]);
  });
});

describe('GET /meta/:type/:id.json', () => {
  it('resolves a percent-encoded anilist id', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A21.json');
    expect(res.status).toBe(200);
    expect(res.body.meta.id).toBe('anilist:21');
    expect(res.body.meta.name).toBe('T21');
  });

  it('emits both country spellings and both language spellings', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A21.json');
    expect(res.body.meta.country).toBeDefined();
    expect(res.body.meta.countryOfOrigin).toBe(res.body.meta.country);
    expect(res.body.meta.language).toBeDefined();
    expect(res.body.meta.audioLanguage).toBe(res.body.meta.language);
  });

  it('returns a 200 with id, type and name for an unknown id', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A99999999.json');
    expect(res.status).toBe(200);
    expect(res.body.meta.id).toBe('anilist:99999999');
    expect(res.body.meta.name).toBe('Unavailable');
  });

  it('returns a 200 for a bare numeric id rather than erroring', async () => {
    const res = await supertest(app).get('/meta/anime/21.json');
    expect(res.status).toBe(200);
    expect(res.body.meta.name).toBe('Unavailable');
  });

  it('emits links with name, category and url', async () => {
    const res = await supertest(app).get('/meta/anime/anilist%3A21.json');
    for (const l of res.body.meta.links) {
      expect(l.name).toBeTruthy(); expect(l.category).toBeTruthy(); expect(l.url).toBeTruthy();
    }
  });
});

describe('never returns a non-200', () => {
  it('answers 200 with an empty list when the catalog service throws', async () => {
    // BOTH services are stubbed to throw. Injecting only a broken catalogService
    // leaves /meta/* on the real MetaService, which attempts a live AniList call:
    // the suite's stated invariant is that `npm test` never touches the network,
    // and a network-dependent test can fail for reasons unrelated to our code.
    const broken = createApp({
      catalogService: { getCatalogPage: async () => { throw new Error('boom'); },
                        search: async () => { throw new Error('boom'); } } as never,
      metaService: { getByAnilistId: async () => { throw new Error('boom'); } } as never,
    });
    for (const path of ['/catalog/anime/anime-trending.json',
                        '/catalog/anime/anime-search/search=x.json',
                        '/meta/anime/anilist%3A1.json',
                        '/meta/anime/garbage.json',
                        '/manifest.json']) {
      const res = await supertest(broken).get(path);
      expect(res.status, path).toBe(200);
    }
  });

  it('answers 200 when the meta service throws', async () => {
    // The meta path has the same no-5xx guarantee as the catalogue path: a
    // malformed body makes Nuvio's MetaDetailsParser throw, which makes Nuvio
    // silently skip this add-on and fall through to TMDB. Proved here rather than
    // inferred, because the catalogue test above cannot reach it.
    const broken = createApp({
      metaService: { getByAnilistId: async () => { throw new Error('boom'); } } as never,
    });
    for (const path of ['/meta/anime/anilist%3A21.json', '/meta/anime/21.json',
                        '/meta/anime/garbage.json']) {
      const res = await supertest(broken).get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.meta.id, path).toBeTruthy();
      expect(res.body.meta.name, path).toBe('Unavailable');
    }
  });
});
