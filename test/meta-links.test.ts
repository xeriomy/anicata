import { describe, it, expect } from 'vitest';
import { renderDetail } from '../src/render/detail.js';
import type { Anime } from '../src/domain/anime.js';

// A fully-populated identity is the golden case in spec §5: all four services.
function mk(identity: Anime['identity']): Anime {
  return {
    identity,
    title: { romaji: 'One Piece', synonyms: [] },
    displayTitle: 'One Piece',
    description: 'Gum-gums.',
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
}

describe('renderDetail links[]', () => {
  it('emits all four service links in spec §5 order with only three keys each', () => {
    const links = renderDetail(mk({
      anilist: 21,
      mal: 21,
      kitsu: '12',
      anidb: 69,
      tmdb: { tv: 37854 },
      imdb: 'tt0388629',
      tvdb: 81797,
    })).links;
    expect(links).toEqual([
      { name: 'AniList', category: 'AniList', url: 'https://anilist.co/anime/21' },
      { name: 'MyAnimeList', category: 'MyAnimeList', url: 'https://myanimelist.net/anime/21' },
      { name: 'Kitsu', category: 'Kitsu', url: 'https://kitsu.app/anime/12' },
      { name: 'AniDB', category: 'AniDB', url: 'https://anidb.net/anime/69' },
    ]);
  });

  it('no entry carries a stray key', () => {
    const links = renderDetail(mk({ anilist: 21, mal: 21, kitsu: '12', anidb: 69 })).links ?? [];
    for (const link of links) {
      expect(Object.keys(link).sort()).toEqual(['category', 'name', 'url']);
    }
  });

  it('omits a service when its id is unknown rather than inventing one', () => {
    // A valid identity that carries no MAL and no Kitsu: only the two entries
    // it actually has may be emitted, and nothing else.
    const links = renderDetail(mk({ anilist: 21, anidb: 69 })).links ?? [];
    expect(links).toEqual([
      { name: 'AniList', category: 'AniList', url: 'https://anilist.co/anime/21' },
      { name: 'AniDB', category: 'AniDB', url: 'https://anidb.net/anime/69' },
    ]);
  });

  it('keeps the canonical id and adds no cross-ids to the meta body', () => {
    const meta = renderDetail(mk({ anilist: 21, mal: 21, kitsu: '12' }));
    expect(meta.id).toBe('anilist:21');
    const allowed = new Set([
      'id', 'type', 'name', 'poster', 'background', 'logo', 'description', 'genres',
      'year', 'runtime', 'status', 'hashtags', 'awards', 'trailer', 'videosCount',
      'country', 'countryOfOrigin', 'language', 'audioLanguage', 'posterShape',
      'links', 'videos', 'imdbRating', 'releaseInfo', 'website', 'releaseDate',
    ]);
    for (const key of Object.keys(meta)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('emits a Kitsu-only link on the Kitsu-only path (ADR-016)', () => {
    const a = mk({ kitsu: 11392 });
    const meta = renderDetail(a);
    expect(meta.id).toBe('kitsu:11392');
    expect(meta.links).toEqual([
      { name: 'Kitsu', category: 'Kitsu', url: 'https://kitsu.app/anime/11392' },
    ]);
  });
});
