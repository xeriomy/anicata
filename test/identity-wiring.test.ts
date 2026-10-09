import { describe, it, expect, vi } from 'vitest';
import { createMetaHandler } from '../src/addon/meta.js';
import type { MetaService } from '../src/services/meta.service.js';
import { ResolveService } from '../src/services/resolve.service.js';
import type { HttpClient } from '../src/net/http.js';
import { loadBundle } from '../src/identity/bundle.js';
import type { Anime } from '../src/domain/anime.js';

function fakeMetaService(): MetaService {
  return {
    getById: vi.fn(async () => ({ anime: null, cacheMaxAge: 60 })),
  } as unknown as MetaService;
}

function fakeResolve(
  impl: (id: string) => Promise<{ identity: unknown; canonicalId: string } | null>,
  enrich: (id: string) => unknown = () => null,
): ResolveService {
  return {
    resolveToCanonical: vi.fn(impl),
    enrichFromBundle: vi.fn(enrich),
  } as unknown as ResolveService;
}

describe('meta handler — identity wiring (gates 4, 5)', () => {
  it('an unknown anilist id is fetched directly, never via a resolver cascade', async () => {
    const metaService = fakeMetaService();
    const getById = vi.mocked(metaService.getById);
    const resolve = fakeResolve(async () => null);
    const handler = createMetaHandler({ metaService, resolve });

    const out = await handler({ type: 'anime', id: 'anilist:99999999' });

    // An `anilist:` id is already canonical, so the LIVE identity tier is never
    // consulted — only the in-memory bundle is, which cannot cost a network call
    // (gate 4).
    expect(resolve.resolveToCanonical).not.toHaveBeenCalled();
    // Exactly one fetch, under the parsed id — no cascade, no second attempt.
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith('anilist:99999999');
    expect(out.meta.name).toBe('Unavailable');
  });

  it('a bare number is a Trakt id: minimal meta, zero upstream calls', async () => {
    const metaService = fakeMetaService();
    const getById = vi.mocked(metaService.getById);
    const resolve = fakeResolve(async () => {
      throw new Error('resolver must not be reached for a bare number');
    });
    const handler = createMetaHandler({ metaService, resolve });

    const out = await handler({ type: 'anime', id: '21' });

    expect(out.meta.id).toBe('21');
    expect(out.meta.name).toBe('Unavailable');
    // Gate 5: the parse rejects it before any resolution or fetch.
    expect(resolve.resolveToCanonical).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });

  it('a mal: id resolves to the canonical anilist: id before the fetch', async () => {
    const metaService = fakeMetaService();
    const getById = vi.mocked(metaService.getById);
    const resolve = fakeResolve(async () => ({ identity: { anilist: 21 }, canonicalId: 'anilist:21' }));
    const handler = createMetaHandler({ metaService, resolve });

    await handler({ type: 'anime', id: 'mal:21' });

    expect(resolve.resolveToCanonical).toHaveBeenCalledWith('mal:21');
    // The fetch must use the canonical id, not the inbound namespace.
    expect(getById).toHaveBeenCalledWith('anilist:21');
  });

  it('the resolved identity reaches the rendered meta, which carries links[]', async () => {
    const anime: Anime = {
      identity: {
        anilist: 21,
        mal: 21,
        kitsu: '12',
        anidb: 69,
        tmdb: { tv: 37854 },
        imdb: 'tt0388629',
        tvdb: 81797,
      },
      title: { romaji: 'One Piece', synonyms: [] },
      displayTitle: 'One Piece',
      format: 'TV',
      status: 'RELEASING',
      type: 'anime',
      genres: ['Adventure'],
      tags: [],
      studios: [],
      relations: [],
      images: {},
      hashtags: [],
    };
    const metaService = {
      getById: vi.fn(async () => ({ anime, cacheMaxAge: 60 })),
    } as unknown as MetaService;
    const resolve = fakeResolve(
      async () => ({ identity: anime.identity, canonicalId: 'anilist:21' }),
      () => anime.identity,
    );
    const handler = createMetaHandler({ metaService, resolve });

    const out = await handler({ type: 'anime', id: 'anilist:21' });

    expect(out.meta.id).toBe('anilist:21');
    expect(out.meta.links).toEqual([
      { name: 'AniList', category: 'AniList', url: 'https://anilist.co/anime/21' },
      { name: 'MyAnimeList', category: 'MyAnimeList', url: 'https://myanimelist.net/anime/21' },
      { name: 'Kitsu', category: 'Kitsu', url: 'https://kitsu.app/anime/12' },
      { name: 'AniDB', category: 'AniDB', url: 'https://anidb.net/anime/69' },
    ]);
  });

  it('the real resolver answers gate 3 for every inbound form of One Piece', async () => {
    const bundle = loadBundle('data/identity.min.json.gz');
    const http = {
      getJson: vi.fn(async () => ({ data: [], headers: {}, status: 200 })),
    } as unknown as HttpClient;
    const resolve = new ResolveService({ http, bundle });
    const metaService = fakeMetaService();
    const handler = createMetaHandler({ metaService, resolve });

    for (const form of ['anilist:21', 'mal:21', 'kitsu:12', 'tmdb:37854', 'tt0388629']) {
      await handler({ type: 'anime', id: form });
      expect(vi.mocked(metaService.getById), `${form} -> anilist:21`).toHaveBeenCalledWith('anilist:21');
    }
  });
});
