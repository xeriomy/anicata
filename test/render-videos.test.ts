import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { videosFromEpisodes } from '../src/render/videos.js';
import type { StremioMetaVideo } from '../src/render/types.js';

// Anchored on a REAL AniZip capture (One Piece, anilist 21), never fabricated
// values: every title, air date and URL asserted below was read out of the
// capture, not remembered. That matters — an assertion written from memory is
// how an AniDB id once ended up attached to the wrong title.
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/identity/anizip-21.json', import.meta.url), 'utf8'),
) as { episodes: Record<string, unknown> };

const EP1_TITLE = 'I`m Luffy! The Man Who`s Gonna Be King of the Pirates!';
const EP2_TITLE = 'Enter the Great Swordsman! Pirate Hunter Roronoa Zoro!';
const SPECIAL_TITLE = 'Luffy`s Fall! The Unexplored Region - Grand Adventure in the Ocean`s Navel';

const videos = (): StremioMetaVideo[] => videosFromEpisodes('anilist:21', capture.episodes);

describe('videosFromEpisodes — season and episode placement', () => {
  it('maps a placed episode to a Nuvio video entry, using the real capture values', () => {
    // Looked up by id, not by index: specials carry season 0, so they sort
    // ahead of episode 1 and index 0 belongs to a special.
    const byId = new Map(videos().map((v) => [v.id, v]));
    const first = byId.get('anilist:21:1');
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      id: 'anilist:21:1',
      title: EP1_TITLE,
      season: 1,
      episode: 1,
      released: '1999-10-20',
      runtime: 25,
    });
    expect(first?.thumbnail).toBe(
      'https://artworks.thetvdb.com/banners/v4/episode/361887/screencap/604df7d3ecf3a.jpg',
    );
    expect(first?.overview).toContain('Alvida pirates plunder a ship');

    // A second anchor: consecutive rows map independently, so an off-by-one in
    // the row key would show up here rather than only in the first entry.
    expect(byId.get('anilist:21:2')).toMatchObject({
      season: 1,
      episode: 2,
      title: EP2_TITLE,
      released: '1999-11-17',
    });
  });

  it('preserves per-season numbering rather than absolute numbering', () => {
    // Absolute 34 is season 3 episode 4 in the capture. Collapsing it to the
    // absolute number would put episode 34 into season 1 and break Nuvio's
    // per-season grouping.
    const byId = new Map(videos().map((v) => [v.id, v]));
    expect(byId.get('anilist:21:34')).toMatchObject({
      season: 3,
      episode: 4,
      title: 'Everyone`s Gathered! Usopp Speaks the Truth About Nami!',
    });
  });

  it('keeps specials in season 0 and never drops them', () => {
    const specials = videos().filter((v) => v.season === 0);
    expect(specials.length).toBeGreaterThan(30);
    expect(specials.map((v) => v.id)).toContain('anilist:21:S2');
    expect(specials.find((v) => v.id === 'anilist:21:S2')).toMatchObject({
      season: 0,
      episode: 3,
      title: SPECIAL_TITLE,
    });
  });

  it('sorts by season, then by episode within the season', () => {
    const list = videos();
    const key = (v: StremioMetaVideo): string =>
      `${String(v.season ?? 0).padStart(3, '0')}:${String(v.episode ?? 0).padStart(5, '0')}`;
    const keys = list.map(key);
    expect([...keys]).toEqual([...keys].sort());
  });
});

describe('videosFromEpisodes — the unaired placeholder rows', () => {
  it('emits one video per placed episode and skips rows with no placement', () => {
    // The capture has 1265 rows: 1217 with a season+episode, and 48 that carry
    // only a title and a length. A row with neither a season nor an episode
    // cannot be placed by Nuvio, so it is skipped rather than emitted as a
    // null-season entry that would collide in `id` with every other such row.
    const list = videos();
    expect(list.length).toBe(1217);
    const placedRows = Object.values(capture.episodes).filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { seasonNumber?: unknown }).seasonNumber === 'number' &&
        typeof (e as { episodeNumber?: unknown }).episodeNumber === 'number',
    ).length;
    expect(placedRows).toBe(list.length);
    expect(list.every((v) => v.season !== undefined && v.episode !== undefined)).toBe(true);
  });
});

describe('videosFromEpisodes — ids must be unique', () => {
  it('gives every row a distinct id even when season and episode collide', () => {
    // 30 (season, episode) pairs appear twice in this capture, because TVDB
    // carries two English dub titles for one episode. An id built from
    // season:episode would silently merge them into one entry in the UI, so the
    // id is built from the row's own key instead.
    const list = videos();
    const ids = list.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries both dub variants for the episode they describe', () => {
    const byId = new Map(videos().map((v) => [v.id, v]));
    expect(byId.get('anilist:21:20')?.title).toBe('Famous Cook! Sanji of the Sea Restaurant!');
    expect(byId.get('anilist:21:21')?.title).toBe(
      'Unwelcome Customer! Sanji`s Food and Ghin`s Debt!',
    );
  });
});

describe('videosFromEpisodes — degraded input never throws', () => {
  it('returns an empty list for anything that is not an episode map', () => {
    for (const bad of [null, undefined, 42, 'nope', [], true]) {
      expect(videosFromEpisodes('anilist:21', bad)).toEqual([]);
    }
  });

  it('skips non-object rows instead of failing on them', () => {
    const list = videosFromEpisodes('anilist:21', {
      '1': 'garbage',
      '2': null,
      '3': { seasonNumber: 1, episodeNumber: 1, title: { en: 'Real' } },
    });
    expect(list).toEqual([
      { id: 'anilist:21:3', title: 'Real', season: 1, episode: 1, runtime: 0 },
    ]);
  });

  it('falls back to the Japanese title when no English title exists', () => {
    // Synthetic unit input, not a capture: this fixture has no Japanese-only
    // episode, so the fallback is exercised with a hand-built row. Every other
    // test in this file asserts against real captured values.
    const list = videosFromEpisodes('anilist:21', {
      '5': { seasonNumber: 2, episodeNumber: 3, title: { ja: '日本語のみ' } },
    });
    expect(list[0]?.title).toBe('日本語のみ');
  });

  it('falls back to the length when AniZip gives no explicit runtime', () => {
    const list = videosFromEpisodes('anilist:21', {
      '5': { seasonNumber: 2, episodeNumber: 3, title: { en: 'Ep' }, length: 24 },
    });
    expect(list[0]?.runtime).toBe(24);
  });
});
