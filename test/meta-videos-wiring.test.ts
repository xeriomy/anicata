import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMetaHandler } from '../src/addon/meta.js';
import type { MetaService } from '../src/services/meta.service.js';
import { ResolveService } from '../src/services/resolve.service.js';
import { EpisodeService } from '../src/services/episode.service.js';
import { renderDetail } from '../src/render/detail.js';
import { videosFromEpisodes } from '../src/render/videos.js';
import type { Anime } from '../src/domain/anime.js';

// Real One Piece capture — the same fixture the render and service tests use,
// so the wired path is verified against what AniZip actually returns.
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/identity/anizip-21.json', import.meta.url), 'utf8'),
) as { episodes: Record<string, unknown> };

function onePiece(): Anime {
  return {
    identity: { anilist: 21, mal: 21 },
    title: { synonyms: [], romaji: 'ONE PIECE' },
    displayTitle: 'ONE PIECE',
    format: 'TV',
    status: 'RELEASING',
    type: 'anime',
    genres: [],
    tags: [],
    studios: [],
    relations: [],
    images: {},
    hashtags: [],
    countryOfOrigin: 'JP',
  };
}

const anime = onePiece();

function metaService(): MetaService {
  return { getById: vi.fn(async () => ({ anime, cacheMaxAge: 300 })) } as unknown as MetaService;
}

function resolve(): ResolveService {
  return {
    resolveToCanonical: vi.fn(async () => ({
      identity: { anilist: 21, mal: 21 },
      canonicalId: 'anilist:21',
    })),
    enrichFromBundle: vi.fn(() => null),
  } as unknown as ResolveService;
}

/** An AniZip tier that answers with the real capture. */
function episodes(): EpisodeService & { episodesFor: ReturnType<typeof vi.fn> } {
  return { episodesFor: vi.fn(async () => capture.episodes) } as unknown as EpisodeService & {
    episodesFor: ReturnType<typeof vi.fn>;
  };
}

describe('meta handler — episode enrichment wiring (Phase 4)', () => {
  it('sends the captured episode list out as videos[]', async () => {
    const handler = createMetaHandler({
      metaService: metaService(),
      resolve: resolve(),
      episodes: episodes(),
    });

    const out = await handler({ type: 'anime', id: 'anilist:21' });

    expect(out.meta.videos!.length).toBe(1217);
    expect(out.meta.videos!.find((v) => v.id === 'anilist:21:1')).toMatchObject({
      title: 'I`m Luffy! The Man Who`s Gonna Be King of the Pirates!',
      season: 1,
      episode: 1,
    });
  });

  it('renders the meta with no videos key when AniZip fails, and never errors', async () => {
    // Roadmap gate: "AniZip down -> meta renders without videos, no error."
    const broken = {
      episodesFor: vi.fn(async () => {
        throw new Error('anizip down');
      }),
    } as unknown as EpisodeService;
    const handler = createMetaHandler({
      metaService: metaService(),
      resolve: resolve(),
      episodes: broken,
    });

    const out = await handler({ type: 'anime', id: 'anilist:21' });

    expect(out.meta.name).toBe('ONE PIECE');
    expect(out.meta.videos).toBeUndefined();
    expect(out.cacheMaxAge).toBe(300);
  });

  it('renders the meta when AniZip answers with a body that has no episodes', async () => {
    const empty = {
      episodesFor: vi.fn(async () => null),
    } as unknown as EpisodeService;
    const handler = createMetaHandler({
      metaService: metaService(),
      resolve: resolve(),
      episodes: empty,
    });

    const out = await handler({ type: 'anime', id: 'anilist:21' });

    expect(out.meta.videos).toBeUndefined();
    expect(out.meta.links!.length).toBeGreaterThan(0);
  });

  it('asks for episodes by the namespace the caller used, not a resolved one', async () => {
    // The episode fetch must not wait for identity resolution, so it is issued
    // with the inbound id rather than the canonical one.
    const eps = episodes();
    const handler = createMetaHandler({
      metaService: metaService(),
      resolve: resolve(),
      episodes: eps,
    });

    await handler({ type: 'anime', id: 'mal:21' });

    expect(eps.episodesFor).toHaveBeenCalledWith('mal', '21');
  });

  it('starts the episode fetch before identity resolution settles', async () => {
    // The two tiers are independent, so a slow identity tier must not delay
    // the episode fetch: if the handler serialised them, `episodesFor` would
    // still be uncalled at the moment resolve is stuck.
    let releaseResolve: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      releaseResolve = r;
    });
    const slowResolve = {
      resolveToCanonical: vi.fn(async () => {
        await held;
        return { identity: { anilist: 21, mal: 21 }, canonicalId: 'anilist:21' };
      }),
      enrichFromBundle: vi.fn(() => null),
    } as unknown as ResolveService;
    const eps = episodes();
    const handler = createMetaHandler({
      metaService: metaService(),
      resolve: slowResolve,
      episodes: eps,
    });

    const pending = handler({ type: 'anime', id: 'mal:21' });
    await Promise.resolve();
    await Promise.resolve();

    // Already asked, while the identity tier is still blocked.
    expect(eps.episodesFor).toHaveBeenCalledTimes(1);

    releaseResolve?.();
    const out = await pending;
    expect(out.meta.name).toBe('ONE PIECE');
    expect(out.meta.videos!.length).toBe(1217);
  });

  it('works with no episode tier wired at all', async () => {
    // Everything except the episode tier is optional enrichment: with none
    // wired the meta must still render exactly as Phase 3 did.
    const handler = createMetaHandler({ metaService: metaService(), resolve: resolve() });

    const out = await handler({ type: 'anime', id: 'anilist:21' });

    expect(out.meta.name).toBe('ONE PIECE');
    expect(out.meta.videos).toBeUndefined();
    expect(out.meta).toEqual(renderDetail({ ...anime, identity: { anilist: 21, mal: 21 } }));
  });

  it('numbers every emitted video from the canonical id of the rendered anime', async () => {
    // The ids must be derived from the anime actually rendered, not from the
    // parsed id: a `mal:21` request that resolves to `anilist:21` has to emit
    // `anilist:21:<key>`, so a client following an id back gets the same title.
    const handler = createMetaHandler({
      metaService: metaService(),
      resolve: resolve(),
      episodes: episodes(),
    });

    const out = await handler({ type: 'anime', id: 'mal:21' });

    const ids = out.meta.videos!.map((v) => v.id);
    expect(ids.every((id) => id.startsWith('anilist:21:'))).toBe(true);
    expect(ids).toContain('anilist:21:S2');
  });
});

describe('videosFromEpisodes — the id the handler uses', () => {
  it('matches the ids renderDetail is given for the rendered anime', () => {
    const identity = anime.identity;
    const rendered = renderDetail(anime, videosFromEpisodes('anilist:21', capture.episodes));
    expect(rendered.videos!.every((v) => v.id.startsWith('anilist:21:'))).toBe(true);
    expect(identity.anilist).toBe(21);
  });
});
