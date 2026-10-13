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

describe('renderDetail — imdb_id (Nuvio enrichment hook)', () => {
  it('emits imdb_id so Nuvio can resolve TMDB/MDBList enrichment', () => {
    // Nuvio parses `imdb_id` (snake_case) from the meta and uses it as the
    // fallback when the meta id is not a tmdb/tt id. Our ids are `anilist:` /
    // `kitsu:` prefixed, so without this field Nuvio cannot resolve a TMDB id
    // at all: TMDB enrichment, MDBList ratings and episode stills all silently
    // do nothing for our titles while working for addons that emit it.
    const meta = renderDetail(mk({ anilist: 21, mal: 21, imdb: 'tt0388629' }));
    expect(meta.imdb_id).toBe('tt0388629');
  });

  it('omits imdb_id rather than sending an empty one when the title has none', () => {
    const meta = renderDetail(mk({ anilist: 99999999 }));
    expect('imdb_id' in meta).toBe(false);
  });

  it('never emits imdb_id for a Kitsu-only title that has none', () => {
    const meta = renderDetail(mk({ kitsu: 11392 }));
    expect('imdb_id' in meta).toBe(false);
  });
});
