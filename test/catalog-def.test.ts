import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CATALOG_DEFS,
  GENRE_OPTIONS,
  catalogDefFor,
  seasonalCatalogId,
  type CatalogId,
} from '../src/sources/catalog-def.js';

// Captured live from AniList's own GenreCollection. The 18 options must be the
// exact strings AniList accepts: its `genre` filter is an exact,
// case-insensitive match, not a substring, so a misspelt option returns an
// empty page — a 200 that silently shows nothing rather than an error.
const captured = JSON.parse(
  readFileSync(new URL('./fixtures/anilist-genres.json', import.meta.url), 'utf8'),
) as { data: { GenreCollection: string[] } };

const IDS = Object.keys(CATALOG_DEFS) as CatalogId[];

describe('catalogue definitions — the 15 catalogues', () => {
  it('declares every catalogue the Phase 5 roadmap names', () => {
    const fixed = [
      'anime-trending', 'anime-top-rated', 'anime-search', 'anime-popular',
      'anime-airing', 'anime-upcoming', 'anime-recent', 'anime-movies',
      'anime-ova', 'anime-genres', 'anime-top-genres', 'movie-trending',
      'movie-top-rated', 'movie-search',
    ];
    expect([...IDS].sort()).toEqual([...fixed].sort());
  });

  it('gives every catalogue a unique id and a name', () => {
    const ids = Object.values(CATALOG_DEFS).map((d) => d.id);
    const names = Object.values(CATALOG_DEFS).map((d) => d.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const def of Object.values(CATALOG_DEFS)) {
      expect(def.name.length).toBeGreaterThan(0);
    }
  });

  it('routes movie catalogues under type movie and anime ones under type anime', () => {
    // Nuvio requests /catalog/{type}/{id} and routes on BOTH, so a catalogue's
    // declared type decides which resource path it is ever called on.
    for (const def of Object.values(CATALOG_DEFS)) {
      if (def.id.startsWith('movie-')) {
        expect(def.type, def.id).toBe('movie');
      } else {
        expect(def.type, def.id).toBe('anime');
      }
    }
    expect(Object.values(CATALOG_DEFS).filter((d) => d.type === 'movie')).toHaveLength(3);
  });

  it('declares search as required on every search catalogue', () => {
    // Without isRequired the catalogue is also published to Home, which puts a
    // "Search …" row on the Board that returns an unfiltered feed until a query
    // is typed.
    const searchable = Object.values(CATALOG_DEFS).filter((d) => d.supportsSearch);
    expect(searchable.map((d) => d.id).sort()).toEqual(
      ['anime-search', 'movie-search'].sort(),
    );
    for (const def of searchable) {
      expect(def.searchRequired, def.id).toBe(true);
    }
    for (const def of Object.values(CATALOG_DEFS).filter((d) => !d.supportsSearch)) {
      expect(def.searchRequired).not.toBe(true);
    }
  });

  it('gives every genre catalogue the genre filter', () => {
    const genreCatalogues = Object.values(CATALOG_DEFS).filter((d) => d.supportsGenre);
    expect(genreCatalogues.map((d) => d.id).sort()).toEqual(
      ['anime-genres', 'anime-top-genres'].sort(),
    );
  });
});

describe('GENRE_OPTIONS', () => {
  it('is the AniList GenreCollection minus adult content', () => {
    expect(GENRE_OPTIONS).toHaveLength(18);
    expect(GENRE_OPTIONS).not.toContain('Hentai');
    for (const genre of GENRE_OPTIONS) {
      // Every option must be a genre AniList actually knows, or the filtered
      // request silently returns nothing.
      expect(captured.data.GenreCollection, genre).toContain(genre);
    }
    // The curated set is exactly "everything AniList has, minus Hentai".
    expect(GENRE_OPTIONS).toEqual(captured.data.GenreCollection.filter((g) => g !== 'Hentai'));
  });

  it('keeps the exact AniList spelling, including mixed case and spacing', () => {
    // "Sci-Fi" and "Slice of Life" are the two that break a naive list.
    expect(GENRE_OPTIONS).toContain('Sci-Fi');
    expect(GENRE_OPTIONS).toContain('Slice of Life');
    expect(GENRE_OPTIONS).toContain('Mahou Shoujo');
  });
});

describe('seasonal catalogue id', () => {
  it('carries the season and year in the id so the cache key rotates', () => {
    // A stable `anime-seasonal` id with a clock-dependent query would keep
    // serving the previous season from cache for a quarter of a year.
    const june = new Date(Date.UTC(2026, 5, 15));
    const january = new Date(Date.UTC(2027, 0, 3));
    expect(seasonalCatalogId(june)).toBe('anime-seasonal-2026-summer');
    expect(seasonalCatalogId(january)).toBe('anime-seasonal-2027-winter');
  });

  it('routes December into the next year’s winter', () => {
    // AniList lists Winter anime under the following calendar year.
    const december = new Date(Date.UTC(2026, 11, 15));
    expect(seasonalCatalogId(december)).toBe('anime-seasonal-2027-winter');
  });

  it('resolves a generated id back to a definition, and rejects impostors', () => {
    const id = seasonalCatalogId(new Date(Date.UTC(2026, 5, 15)));
    const def = catalogDefFor(id);
    expect(def).toMatchObject({ id, type: 'anime' });
    expect(def?.name).toBe('Summer 2026 Anime');

    for (const bad of [
      'anime-seasonal-26-summer',
      'anime-seasonal-2026-monsoon',
      'anime-seasonal-2026',
      'anime-seasonal-2026-fall-x',
      'anime-seasonal-2026-Fall',
    ]) {
      expect(catalogDefFor(bad), bad).toBeUndefined();
    }
  });

  it('still resolves the fixed catalogues, and rejects unknown ids', () => {
    expect(catalogDefFor('anime-trending')?.id).toBe('anime-trending');
    expect(catalogDefFor('movie-search')?.type).toBe('movie');
    expect(catalogDefFor('nope')).toBeUndefined();
    expect(catalogDefFor('')).toBeUndefined();
  });
});
