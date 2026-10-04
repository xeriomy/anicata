import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeMedia } from '../src/normalize/anime.js';
import { renderPreview, renderDetail } from '../src/render/index.js';
import type { AniListMedia } from '../src/sources/anilist/types.js';

const raw = (JSON.parse(
  readFileSync(new URL('./fixtures/meta-21.json', import.meta.url), 'utf8'),
) as { data: { Media: AniListMedia } }).data.Media!;

const anime = normalizeMedia(raw, { titleLang: 'english' });

describe('renderPreview', () => {
  const p = renderPreview(anime);

  it('always emits non-blank id, type and name, the three Nuvio requires', () => {
    expect(p.id).toBe('anilist:21');
    expect(p.type).toBe('anime');
    expect(p.name.trim()).toBe('ONE PIECE');
  });

  it('prefixes the id so Nuvio does not read it as a Trakt id', () => {
    expect(p.id).toMatch(/^anilist:\d+$/);
  });

  it('emits banner as well as background; Nuvio prefers banner', () => {
    expect(p.banner).toBe(anime.images.background);
    expect(p.background).toBe(anime.images.background);
  });

  it('formats imdbRating as a string, because Nuvio reads it as one', () => {
    expect(typeof p.imdbRating).toBe('string');
    expect(Number(p.imdbRating)).toBeGreaterThan(0);
    expect(Number(p.imdbRating)).toBeLessThanOrEqual(10);
  });

  it('never includes internal underscore-prefixed fields', () => {
    for (const k of Object.keys(p)) expect(k.startsWith('_')).toBe(false);
  });

  it('omits optional fields rather than emitting undefined keys', () => {
    const bare = renderPreview(normalizeMedia({ id: 7 } as AniListMedia, { titleLang: 'english' }));
    expect(JSON.parse(JSON.stringify(bare))).not.toHaveProperty('description');
    expect(bare.name).toBe('Untitled');
  });
});

describe('renderDetail', () => {
  const d = renderDetail(anime);

  it('emits both country and countryOfOrigin for Nuvio and the Stremio spec', () => {
    expect(d.country).toBe('JP');
    expect(d.countryOfOrigin).toBe('JP');
  });

  it('emits both language and audioLanguage', () => {
    expect(d.language).toBeDefined();
    expect(d.audioLanguage).toBe(d.language);
  });

  it('includes required id, type and name', () => {
    expect(d.id).toBe('anilist:21');
    expect(d.type).toBe('anime');
    expect(d.name.trim()).toBe('ONE PIECE');
  });

  it('emits links with all three of name, category and url', () => {
    expect(d.links!.length).toBeGreaterThan(0);
    for (const l of d.links!) {
      expect(l.name).toBeTruthy();
      expect(l.category).toBeTruthy();
      expect(l.url).toMatch(/^https?:\/\//);
    }
    expect(d.links!.map(l => l.category)).toContain('AniList');
    expect(d.links!.map(l => l.category)).toContain('MyAnimeList');
  });

  it('emits an AniList link built from the canonical id', () => {
    expect(d.links!.find(l => l.category === 'AniList')!.url).toBe('https://anilist.co/anime/21');
  });

  it('omits the MyAnimeList link when idMal is absent', () => {
    const noMal = renderDetail(normalizeMedia({ ...raw, idMal: null }, { titleLang: 'english' }));
    expect(noMal.links!.map(l => l.category)).not.toContain('MyAnimeList');
  });

  it('emits an empty videos array in Phase 1, never undefined', () => {
    expect(d.videos).toEqual([]);
  });

  it('omits runtime rather than inventing one when duration is unknown', () => {
    const noDur = renderDetail(normalizeMedia({ ...raw, duration: null }, { titleLang: 'english' }));
    expect(noDur.runtime).toBeUndefined();
    const withDur = renderDetail(normalizeMedia({ ...raw, duration: 24 }, { titleLang: 'english' }));
    expect(withDur.runtime).toBe('24 min');
  });

  it('emits genres as a plain string array', () => {
    expect(Array.isArray(d.genres)).toBe(true);
    for (const g of d.genres!) expect(typeof g).toBe('string');
  });

  it('serialises to JSON without throwing on a minimal Anime', () => {
    expect(() => JSON.stringify(renderDetail(normalizeMedia({ id: 1 } as AniListMedia, { titleLang: 'english' })))).not.toThrow();
  });
});
