import { describe, it, expect } from 'vitest';
import { renderDetail } from '../src/render/detail.js';
import { videosFromEpisodes } from '../src/render/videos.js';
import type { Anime, AnimeIdentity } from '../src/domain/anime.js';
import { readFileSync } from 'node:fs';

function mk(identity: AnimeIdentity): Anime {
  return {
    identity,
    title: { synonyms: [], romaji: 'ONE PIECE' },
    displayTitle: 'ONE PIECE',
    description: '',
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

const capture = JSON.parse(
  readFileSync(new URL('./fixtures/identity/anizip-21.json', import.meta.url), 'utf8'),
) as { episodes: Record<string, unknown> };

describe('renderDetail — videos[] (Phase 4)', () => {
  it('carries the episode list through to the rendered meta', () => {
    const videos = videosFromEpisodes('anilist:21', capture.episodes);
    const meta = renderDetail(mk({ anilist: 21, mal: 21, kitsu: '12', anidb: 69 }), videos);

    expect(meta.videos!.length).toBe(1217);
    expect(meta.videos![0]).toMatchObject({ id: 'anilist:21:S2', season: 0, episode: 3 });
  });

  it('omits the key entirely when there are no episodes, rather than sending an empty array', () => {
    // Nuvio's MetaDetailsParser accepts both, but a present-but-empty array is
    // a promise of a series with no episodes, which is a different claim from
    // "we have no episode data". Omission is the honest form.
    const meta = renderDetail(mk({ anilist: 21 }));
    expect('videos' in meta).toBe(false);
  });

  it('omits the key for an empty episode list, same as for no tier at all', () => {
    const meta = renderDetail(mk({ anilist: 21 }), []);
    expect('videos' in meta).toBe(false);
  });

  it('still carries every Phase 3 field when episodes are present', () => {
    // The episode tier must not regress the identity work: links, language and
    // country are all still emitted alongside videos[].
    const identity: AnimeIdentity = { anilist: 21, mal: 21, kitsu: '12', anidb: 69 };
    const videos = videosFromEpisodes('anilist:21', capture.episodes);
    const meta = renderDetail(mk(identity), videos);

    expect(meta.links?.length).toBe(4);
    expect(meta.language).toBe('ja');
    expect(meta.countryOfOrigin).toBe('JP');
    expect(meta.videos!.length).toBe(1217);
  });
});
