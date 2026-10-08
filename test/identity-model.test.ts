import { describe, it, expect } from 'vitest';
import {
  stremioIdFor,
  IDENTITY_NAMESPACE_REGISTRY,
  type AnimeIdentity,
} from '../src/domain/anime.js';

// Task 1: AnimeIdentity carries optional cross-source ids; emit paths unchanged
// (canonical `anilist:<n>` when present, else `kitsu:<id>` — ADR-016).
describe('AnimeIdentity cross-source ids', () => {
  it('accepts every optional cross-id alongside the canonical anilist id', () => {
    const identity: AnimeIdentity = {
      anilist: 21,
      mal: 21,
      kitsu: '12',
      anidb: 69,
      tmdb: { tv: 37854 },
      imdb: 'tt0388629',
      tvdb: 81797,
      simkl: 12345,
    };
    expect(identity.anilist).toBe(21);
    expect(identity.mal).toBe(21);
    expect(identity.tvdb).toBe(81797);
    expect(identity.simkl).toBe(12345);
  });

  it('types kitsu as a string and tmdb as a {tv,movie} object', () => {
    const identity: AnimeIdentity = {
      anilist: 21,
      kitsu: '12',
      tmdb: { tv: 37854, movie: 123456 },
    };
    expect(typeof identity.kitsu).toBe('string');
    expect(identity.tmdb).toEqual({ tv: 37854, movie: 123456 });
  });

  it('accepts a bare identity with only the canonical id (optional keys omitted)', () => {
    const identity: AnimeIdentity = { anilist: 21 };
    expect(stremioIdFor(identity)).toBe('anilist:21');
  });

  it('still emits anilist:<n> when present, else kitsu:<id>', () => {
    const full: AnimeIdentity = {
      anilist: 21,
      mal: 21,
      kitsu: '12',
      anidb: 69,
      tmdb: { tv: 37854 },
      imdb: 'tt0388629',
      tvdb: 81797,
      simkl: 12345,
    };
    expect(stremioIdFor(full)).toBe('anilist:21');
    expect(stremioIdFor({ kitsu: 1376 })).toBe('kitsu:1376');
  });

  it('exposes one registry row per namespace (ADR-018 binding seam)', () => {
    const byKey = new Map(IDENTITY_NAMESPACE_REGISTRY.map((row) => [row.key, row]));
    for (const key of [
      'anilist',
      'mal',
      'kitsu',
      'anidb',
      'tmdb',
      'imdb',
      'tvdb',
      'simkl',
    ] as const) {
      expect(byKey.has(key)).toBe(true);
    }
    expect(byKey.get('anilist')?.prefix).toBe('anilist:');
    expect(byKey.get('anilist')?.emits).toBe(true);
    expect(byKey.get('kitsu')?.emits).toBe(true);
    expect(byKey.get('tmdb')?.shape).toBe('object');
    expect(byKey.get('imdb')?.prefix).toBe('imdb:');
  });
});
