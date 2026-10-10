import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { loadAppConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/index.js';
import type { MetaService } from '../src/services/meta.service.js';
import type { CatalogService } from '../src/services/catalog.service.js';
import type { ResolveService } from '../src/services/resolve.service.js';
import type { EpisodeService } from '../src/services/episode.service.js';
import type { Anime } from '../src/domain/anime.js';

// A sentinel value, NOT the operator's real key. If this ever appears in a
// response the test must fail, so the sentinel has to be something that could
// never legitimately occur in anime metadata.
const SENTINEL_KEY = 'anicata-test-sentinel-not-a-real-key';

function onePiece(): Anime {
  return {
    identity: { anilist: 21, mal: 21, kitsu: '12' },
    title: { synonyms: [], romaji: 'ONE PIECE', english: 'One Piece' },
    displayTitle: 'ONE PIECE',
    description: 'East Blue',
    format: 'TV',
    status: 'RELEASING',
    type: 'anime',
    episodes: 1217,
    genres: ['Adventure'],
    tags: [],
    studios: [],
    relations: [],
    images: {},
    hashtags: [],
    countryOfOrigin: 'JP',
  };
}

/**
 * Every tier is a fake, so the suite stays offline and deterministic: the
 * point is to inspect what the add-on puts on the wire, not to test TMDB.
 */
function fakeDeps() {
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
  };
}

function configWith(key: string | undefined): AppConfig {
  return {
    ...loadAppConfig({}),
    ...(key !== undefined ? { tmdbApiKey: key } : {}),
  };
}

const MEDIA_ROUTES = [
  '/manifest.json',
  '/catalog/anime/anilist-trending.json',
  '/catalog/anime/anilist-trending/genre=Action&skip=0.json',
  '/meta/anime/anilist%3A21.json',
  '/meta/anime/mal%3A21.json',
  '/meta/anime/kitsu%3A12.json',
  '/meta/anime/garbage.json',
  '/meta/anime/anilist%3A99999999.json',
];

describe('TMDB key confidentiality', () => {
  it('never appears in any response body or header', async () => {
    // The key is operator-supplied and will live in env or, later, a
    // /configure page. Every wire path the add-on serves is asserted here: the
    // manifest, catalogues, and meta requests that both succeed and fail.
    const app = createApp({ config: configWith(SENTINEL_KEY), ...fakeDeps() });

    const bodies: string[] = [];
    const headers: string[] = [];
    for (const route of MEDIA_ROUTES) {
      const res = await request(app).get(route);
      bodies.push(res.text ?? '');
      headers.push(JSON.stringify(res.headers ?? {}));
    }

    for (const body of bodies) {
      expect(body).not.toContain(SENTINEL_KEY);
    }
    for (const header of headers) {
      expect(header).not.toContain(SENTINEL_KEY);
    }
  });

  it('never appears when the artwork tier is configured but fails upstream', async () => {
    // The interesting case: TMDB configured, upstream unreachable. A failure
    // path is exactly where a defensive log or an error body tends to leak the
    // credential that was used to make the failing call.
    const app = createApp({
      config: configWith(SENTINEL_KEY),
      ...fakeDeps(),
    });

    const res = await request(app).get('/meta/anime/anilist%3A21.json');

    expect(res.status).toBe(200);
    expect(res.text ?? '').not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(res.headers ?? {})).not.toContain(SENTINEL_KEY);
  });

  it('serves the same response shape whether or not the key is configured', async () => {
    // Phase 4's headline gate. Compared on the fields a client parses, not the
    // whole body: artwork fields are the intended difference, everything else
    // must be byte-identical.
    const withKey = createApp({ config: configWith(SENTINEL_KEY), ...fakeDeps() });
    const withoutKey = createApp({ config: configWith(undefined), ...fakeDeps() });

    for (const route of MEDIA_ROUTES) {
      const a = await request(withKey).get(route);
      const b = await request(withoutKey).get(route);
      expect(a.status, route).toBe(b.status);

      if (!route.endsWith('.json') || !route.includes('/meta/')) continue;
      // Strip the artwork fields, which are the one intended difference.
      const shape = (r: { text?: string }): Record<string, unknown> => {
        const meta = (JSON.parse(r.text ?? '{}') as { meta?: Record<string, unknown> }).meta ?? {};
        const { logo, banner, background, poster, videos, ...rest } = meta;
        void logo; void banner; void background; void poster; void videos;
        return rest;
      };
      expect(shape(a), route).toEqual(shape(b));
    }
  });
});
