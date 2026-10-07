import { describe, it, expect, vi } from 'vitest';
import { MetaService } from '../src/services/meta.service.js';
import { createMetaHandler } from '../src/addon/meta.js';
import { SourceChain } from '../src/sources/chain.js';
import { CircuitBreaker } from '../src/net/breaker.js';
import { TTLCache } from '../src/cache/store.js';
import type { Anime } from '../src/domain/anime.js';
import type { AnimeSource, SourceId } from '../src/sources/types.js';

const anilistAnime: Anime = {
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

const kitsuAnime: Anime = {
  identity: { kitsu: 1 },
  title: { synonyms: [] },
  displayTitle: 'Cowboy Bebop',
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

function setup(): {
  anilistFetchById: ReturnType<typeof vi.fn<(id: number) => Promise<Anime | null>>>;
  kitsuFetchById: ReturnType<typeof vi.fn<(id: number) => Promise<Anime | null>>>;
  handler: ReturnType<typeof createMetaHandler>;
} {
  const anilistFetchById = vi.fn<(id: number) => Promise<Anime | null>>(
    async (id) => (id === 21 ? anilistAnime : null),
  );
  const kitsuFetchById = vi.fn<(id: number) => Promise<Anime | null>>(
    async (id) => (id === 1 ? kitsuAnime : null),
  );
  const mkSource = (
    id: SourceId,
    fetchById: (num: number) => Promise<Anime | null>,
  ): AnimeSource => ({
    id,
    fetchPage: vi.fn(async () => ({ items: [], total: 0 })),
    search: vi.fn(async () => ({ items: [], total: 0 })),
    fetchById,
  });
  const now = (): number => 0;
  const chain = new SourceChain({
    sources: [mkSource('anilist', anilistFetchById), mkSource('kitsu', kitsuFetchById)],
    breakers: new Map<SourceId, CircuitBreaker>([
      ['anilist', new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now })],
      ['kitsu', new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now })],
    ]),
  });
  const service = new MetaService({ source: chain, cache: new TTLCache() });
  return { anilistFetchById, kitsuFetchById, handler: createMetaHandler({ metaService: service }) };
}

describe('kitsu: meta resolution', () => {
  it('kitsu:1 resolves a full Anime via Kitsu with zero AniList calls', async () => {
    const { handler, anilistFetchById, kitsuFetchById } = setup();
    const res = await handler({ type: 'anime', id: 'kitsu:1' });
    expect(res.meta).toMatchObject({ id: 'kitsu:1', type: 'anime', name: 'Cowboy Bebop' });
    expect(kitsuFetchById).toHaveBeenCalledWith(1, expect.any(Number));
    expect(anilistFetchById).toHaveBeenCalledTimes(0);
  });

  it('anilist:21 resolves via AniList with zero Kitsu calls', async () => {
    const { handler, anilistFetchById, kitsuFetchById } = setup();
    const res = await handler({ type: 'anime', id: 'anilist:21' });
    expect(res.meta).toMatchObject({ id: 'anilist:21', type: 'anime', name: 'ONE PIECE' });
    expect(anilistFetchById).toHaveBeenCalledWith(21, expect.any(Number));
    expect(kitsuFetchById).toHaveBeenCalledTimes(0);
  });

  it('an unknown kitsu: id returns null, not a throw', async () => {
    const { handler, kitsuFetchById } = setup();
    const res = await handler({ type: 'anime', id: 'kitsu:999999' });
    expect(kitsuFetchById).toHaveBeenCalledWith(999999, expect.any(Number));
    // Complete meta object, never a throw: id/type/name all non-blank.
    expect(res.meta.id.trim()).not.toBe('');
    expect(res.meta.type.trim()).not.toBe('');
    expect(res.meta.name.trim()).not.toBe('');
    expect(res.meta.name).toBe('Unavailable');
  });

  it('the Unavailable shape still carries non-blank id, type and name for both namespaces', async () => {
    const { handler } = setup();
    for (const id of ['anilist:999999', 'kitsu:999999']) {
      const res = await handler({ type: 'anime', id });
      expect(res.meta.id.trim(), id).not.toBe('');
      expect(res.meta.type.trim(), id).not.toBe('');
      expect(res.meta.name.trim(), id).not.toBe('');
    }
  });

  it('a bare numeric id is still rejected without touching either source', async () => {
    const { handler, anilistFetchById, kitsuFetchById } = setup();
    const res = await handler({ type: 'anime', id: '21' });
    expect(res.meta).toMatchObject({ id: '21', type: 'anime', name: 'Unavailable' });
    expect(anilistFetchById).toHaveBeenCalledTimes(0);
    expect(kitsuFetchById).toHaveBeenCalledTimes(0);
  });
});
