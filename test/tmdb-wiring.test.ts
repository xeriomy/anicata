import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { loadAppConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/index.js';
import type { MetaService } from '../src/services/meta.service.js';
import type { CatalogService } from '../src/services/catalog.service.js';
import type { ResolveService } from '../src/services/resolve.service.js';
import type { EpisodeService } from '../src/services/episode.service.js';
import type { TmdbArtworkSource } from '../src/sources/tmdb/source.js';
import type { Anime } from '../src/domain/anime.js';

const SENTINEL_KEY = 'anicata-test-sentinel-not-a-real-key';
const LOGO = 'https://image.tmdb.org/t/p/w500/9F7daAmibx8ZHTE17CdM5FAwiHE.png';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280/v38qp4bySLTXYu3MF8r5GD51FN3.jpg';

function onePiece(images: { poster?: string; background?: string } = {}): Anime {
  return {
    identity: { anilist: 21, mal: 21, kitsu: '12' },
    title: { synonyms: [], romaji: 'ONE PIECE' },
    displayTitle: 'ONE PIECE',
    format: 'TV',
    status: 'RELEASING',
    type: 'anime',
    genres: [],
    tags: [],
    studios: [],
    relations: [],
    images,
    hashtags: [],
    countryOfOrigin: 'JP',
  };
}

function deps(artwork: ReturnType<typeof vi.fn>) {
  return {
    metaService: {
      getById: vi.fn(async () => ({ anime: onePiece(), cacheMaxAge: 300 })),
    } as unknown as MetaService,
    catalogService: {
      getCatalogPage: vi.fn(async () => ({ items: [onePiece()], total: 1 })),
      search: vi.fn(async () => ({ items: [onePiece()], total: 1 })),
    } as unknown as CatalogService,
    resolveService: {
      resolveToCanonical: vi.fn(async () => ({
        identity: onePiece().identity,
        canonicalId: 'anilist:21',
      })),
      enrichFromBundle: vi.fn(() => null),
    } as unknown as ResolveService,
    episodeService: {
      episodesFor: vi.fn(async () => null),
    } as unknown as EpisodeService,
    artworkSource: { artworkFor: artwork } as unknown as TmdbArtworkSource,
  };
}

function configWith(key: string | undefined): AppConfig {
  return { ...loadAppConfig({}), ...(key !== undefined ? { tmdbApiKey: key } : {}) };
}

const meta = async (
  key: string | undefined,
  artwork: ReturnType<typeof vi.fn> = vi.fn(async () => ({ logo: undefined, backdrop: undefined })),
  withArtworkSource = true,
): Promise<Record<string, unknown>> => {
  // Destructured so the no-key case can omit the override entirely: passing
  // `artworkSource: undefined` would still wire a tier and prove nothing.
  const { artworkSource, ...rest } = deps(artwork);
  const app = createApp({
    ...rest,
    config: configWith(key),
    ...(withArtworkSource ? { artworkSource } : {}),
  });
  const res = await request(app).get('/meta/anime/anilist%3A21.json');
  expect(res.status).toBe(200);
  return (res.body as { meta: Record<string, unknown> }).meta;
};

describe('TMDB artwork wiring (Phase 4)', () => {
  it('puts the TMDB logo on the meta when a key is configured', async () => {
    const artwork = vi.fn(async () => ({ logo: LOGO, backdrop: undefined }));
    const m = await meta(SENTINEL_KEY, artwork);

    expect(m.logo).toBe(LOGO);
    expect(artwork).toHaveBeenCalledTimes(1);
  });

  it('leaves the source background alone when it already has one', async () => {
    // The merge rule is the same one Phase 3 settled for identity: the source
    // owns what it already supplied, and TMDB only fills what is missing. A
    // wide backdrop must never replace a poster the source chose.
    const app = createApp({
      config: configWith(SENTINEL_KEY),
      ...deps(vi.fn(async () => ({ backdrop: BACKDROP }))),
      metaService: {
        getById: vi.fn(async () => ({
          anime: onePiece({ background: 'https://anilist/bg.jpg' }),
          cacheMaxAge: 300,
        })),
      } as unknown as MetaService,
    });
    const res = await request(app).get('/meta/anime/anilist%3A21.json');
    const m = (res.body as { meta: Record<string, unknown> }).meta;

    expect(m.banner).toBe('https://anilist/bg.jpg');
    expect(m.background).toBe('https://anilist/bg.jpg');
  });

  it('fills the backdrop when the source has none', async () => {
    const app = createApp({
      config: configWith(SENTINEL_KEY),
      ...deps(vi.fn(async () => ({ backdrop: BACKDROP }))),
      metaService: {
        getById: vi.fn(async () => ({ anime: onePiece({ poster: 'https://anilist/poster.jpg' }), cacheMaxAge: 300 })),
      } as unknown as MetaService,
    });
    const res = await request(app).get('/meta/anime/anilist%3A21.json');
    const m = (res.body as { meta: Record<string, unknown> }).meta;

    expect(m.banner).toBe(BACKDROP);
    expect(m.background).toBe(BACKDROP);
    expect(m.poster).toBe('https://anilist/poster.jpg');
  });

  it('never contacts TMDB when no key is configured', async () => {
    // Deliberately does NOT inject an artworkSource: the point is that the real
    // composition root builds no source at all without a key, so injecting a
    // fake here would prove nothing. An injected fake would be called however
    // the config is set, because the injection is what wires the tier.
    const artwork = vi.fn(async () => ({ logo: LOGO }));
    const m = await meta(undefined, artwork, false);

    expect(artwork).not.toHaveBeenCalled();
    expect(m.logo).toBeUndefined();
  });

  it('renders the meta with no logo when TMDB fails, without an error', async () => {
    const artwork = vi.fn(async () => {
      throw new Error('tmdb down');
    });
    const m = await meta(SENTINEL_KEY, artwork);

    expect(m.name).toBe('ONE PIECE');
    expect(m.logo).toBeUndefined();
  });

  it('still carries links and episodes alongside the logo', async () => {
    // The artwork tier must not regress either earlier phase: links[] from
    // Phase 3 and videos[] from Phase 4's episode half both survive it.
    const app = createApp({
      config: configWith(SENTINEL_KEY),
      ...deps(vi.fn(async () => ({ logo: LOGO }))),
      episodeService: {
        episodesFor: vi.fn(async () => ({
          '1': { seasonNumber: 1, episodeNumber: 1, title: { en: 'Ep 1' }, runtime: 25 },
        })),
      } as unknown as EpisodeService,
    });
    const res = await request(app).get('/meta/anime/anilist%3A21.json');
    const m = (res.body as { meta: Record<string, unknown> }).meta;

    expect(m.logo).toBe(LOGO);
    expect(Array.isArray(m.links)).toBe(true);
    expect((m.links as unknown[]).length).toBeGreaterThan(0);
    expect((m.videos as unknown[]).length).toBe(1);
  });
});
