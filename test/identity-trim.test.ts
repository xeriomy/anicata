import { describe, it, expect } from 'vitest'
import { trimIdentityRow } from '../src/identity/trim.js';

describe('trimIdentityRow', () => {
  // --- fixture rows from test/fixtures/identity/fribb-rows.json ---

  it('one_piece produces exact expected output', () => {
    const raw = {
      type: 'TV',
      anidb_id: 69,
      anilist_id: 21,
      animecountdown_id: 38636,
      animenewsnetwork_id: 836,
      anime_planet_id: 'one-piece',
      anisearch_id: 2227,
      imdb_id: ['tt0388629'],
      kitsu_id: 12,
      livechart_id: 321,
      mal_id: 21,
      simkl_id: 38636,
      themoviedb_id: { tv: 37854 },
      tvdb_id: 81797,
    }
    const result = trimIdentityRow(raw)
    expect(result).toEqual({
      anilist_id: 21,
      mal_id: 21,
      kitsu_id: 12,
      anidb_id: 69,
      tvdb_id: 81797,
      imdb_id: 'tt0388629',
      themoviedb_id: { tv: 37854 },
      simkl_id: 38636,
    })
  })

  it('multi_imdb: imdb_id keeps only first element, themoviedb_id.movie keeps only first of array', () => {
    const raw = {
      type: 'MOVIE',
      anidb_id: 1250,
      anilist_id: 1441,
      animecountdown_id: 37340,
      animenewsnetwork_id: 51,
      anime_planet_id: 'night-on-the-galactic-railroad',
      anisearch_id: 1102,
      imdb_id: ['tt1920940', 'tt0089206'],
      kitsu_id: 1294,
      livechart_id: 6241,
      mal_id: 1441,
      simkl_id: 37340,
      themoviedb_id: { movie: [37585] },
    }
    const result = trimIdentityRow(raw)
    expect(result).toEqual({
      anilist_id: 1441,
      mal_id: 1441,
      kitsu_id: 1294,
      anidb_id: 1250,
      imdb_id: 'tt1920940',
      themoviedb_id: { movie: 37585 },
      simkl_id: 37340,
    })
  })

  it('tmdb_movie_object: single-element array must not stay an array', () => {
    const raw = {
      type: 'MOVIE',
      anidb_id: 7,
      anilist_id: 164,
      animecountdown_id: 36228,
      animenewsnetwork_id: 197,
      anime_planet_id: 'princess-mononoke',
      anisearch_id: 3320,
      imdb_id: ['tt0119698'],
      kitsu_id: 142,
      livechart_id: 3081,
      mal_id: 164,
      simkl_id: 36228,
      themoviedb_id: { movie: [128] },
    }
    const result = trimIdentityRow(raw)
    expect(result).toEqual({
      anilist_id: 164,
      mal_id: 164,
      kitsu_id: 142,
      anidb_id: 7,
      imdb_id: 'tt0119698',
      themoviedb_id: { movie: 128 },
      simkl_id: 36228,
    })
  })

  // --- adversarial / synthetic rows ---

  it('row with neither anilist_id nor mal_id returns null', () => {
    const raw = { kitsu_id: 5, anidb_id: 1 }
    expect(trimIdentityRow(raw)).toBeNull()
  })

  it('imdb_id: [] → key absent', () => {
    const raw = { anilist_id: 1, imdb_id: [] }
    expect(trimIdentityRow(raw)).toEqual({ anilist_id: 1 })
  })

  it('imdb_id: ["12345"] → key absent (no tt prefix)', () => {
    const raw = { anilist_id: 1, imdb_id: ['12345'] }
    expect(trimIdentityRow(raw)).toEqual({ anilist_id: 1 })
  })

  it('themoviedb_id: {movie: 5} (not an array) → key absent', () => {
    const raw = { anilist_id: 1, themoviedb_id: { movie: 5 } }
    expect(trimIdentityRow(raw)).toEqual({ anilist_id: 1 })
  })

  it('anilist_id: 0 → key absent', () => {
    const raw = { anilist_id: 0, mal_id: 2 }
    expect(trimIdentityRow(raw)).toEqual({ mal_id: 2 })
  })

  it('anilist_id: -5 → key absent', () => {
    const raw = { anilist_id: -5, mal_id: 2 }
    expect(trimIdentityRow(raw)).toEqual({ mal_id: 2 })
  })

  it('row whose only survivor is mal_id returns with just that key', () => {
    const raw = { mal_id: 42, anidb_id: 0 }
    const result = trimIdentityRow(raw)
    expect(result).toEqual({ mal_id: 42 })
  })

  it('junk inputs (null, "x", []) → null', () => {
    expect(trimIdentityRow(null)).toBeNull()
    expect(trimIdentityRow('x')).toBeNull()
    expect(trimIdentityRow([])).toBeNull()
  })

  it('dead columns do not leak: type, season, animecountdown_id, animenewsnetwork_id, anime-planet_id, anisearch_id, livechart_id all absent', () => {
    const raw = {
      type: 'TV',
      season: 'Winter',
      anilist_id: 1,
      animecountdown_id: 5,
      animenewsnetwork_id: 3,
      anime_planet_id: 'ap',
      anisearch_id: 7,
      livechart_id: 9,
    }
    const result = trimIdentityRow(raw)
    // only anilist_id survives; dead keys must not appear
    expect(result).toEqual({ anilist_id: 1 })
  })
})