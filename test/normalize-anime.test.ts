import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AniListMedia } from '../src/sources/anilist/types.js';
import { normalizeMedia, normalizeFormat, normalizeStatus, TAG_MIN_RANK } from '../src/normalize/anime.js';

const meta = JSON.parse(
  readFileSync(new URL('./fixtures/meta-21.json', import.meta.url), 'utf8'),
) as { data: { Media: AniListMedia } };
const onePiece = meta.data.Media!;

describe('normalizeFormat / normalizeStatus', () => {
  it('maps every AniList format value', () => {
    for (const f of ['TV','TV_SHORT','MOVIE','SPECIAL','OVA','ONA','MUSIC'])
      expect(normalizeFormat(f)).toBe(f);
  });
  it('maps unknown or null format to OTHER', () => {
    expect(normalizeFormat(null)).toBe('OTHER');
    expect(normalizeFormat('MANGA')).toBe('OTHER');
  });
  it('maps every AniList status value, including CANCELLED not DELAYED', () => {
    for (const s of ['FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS'])
      expect(normalizeStatus(s)).toBe(s);
  });
  it('maps unknown or null status to UNKNOWN', () => {
    expect(normalizeStatus(null)).toBe('UNKNOWN');
    expect(normalizeStatus('DELAYED')).toBe('UNKNOWN');
  });
});

describe('normalizeMedia', () => {
  const a = normalizeMedia(onePiece, { titleLang: 'english' });

  it('maps identity and produces the prefixed stremio id', () => {
    expect(a.identity).toEqual({ anilist: 21, mal: 21 });
  });

  it('resolves a display title', () => {
    expect(a.displayTitle).toBe('ONE PIECE');
  });

  it('strips html and attribution from the description', () => {
    expect(a.description).toBeTruthy();
    expect(a.description).not.toMatch(/<[a-z]/i);
    expect(a.description!.length).toBeLessThanOrEqual(900);
  });

  it('uses duration as an integer number of minutes', () => {
    expect(a.durationMinutes).toBe(24);
  });

  it('keeps the AniList 0-100 score as-is; rendering divides by 10', () => {
    expect(a.scoreAnilist).toBe(onePiece.averageScore!);
    expect(a.scoreAnilist).toBeGreaterThan(0);
    expect(a.scoreAnilist).toBeLessThanOrEqual(100);
  });

  it('uses extraLarge for the poster, never the mis-sized large', () => {
    expect(a.images.poster).toBe(onePiece.coverImage!.extraLarge);
    expect(a.images.poster).toContain('/cover/large/');
  });

  it('maps tags, dropping spoiler tags and low-rank tags', () => {
    const b = normalizeMedia({
      ...onePiece,
      tags: [
        { id: 1, name: 'Good', rank: 90, category: 'Theme', isMediaSpoiler: false, isAdult: false },
        { id: 2, name: 'Spoiler', rank: 90, category: 'Theme', isMediaSpoiler: true, isAdult: false },
        { id: 3, name: 'Weak', rank: 5, category: 'Theme', isMediaSpoiler: false, isAdult: false },
        { id: 4, name: 'Adult', rank: 90, category: 'Theme', isMediaSpoiler: false, isAdult: true },
      ],
    }, { titleLang: 'english' });
    expect(b.tags.map(t => t.name)).toEqual(['Good']);
    expect(TAG_MIN_RANK).toBe(60);
  });

  it('maps studios with the isMain flag from StudioEdge', () => {
    expect(a.studios).toContainEqual({ id: 18, name: 'Toei Animation', isMain: true });
  });

  it('maps relations and tolerates a null relation list', () => {
    expect(a.relations.length).toBeGreaterThan(0);
    expect(a.relations[0]).toMatchObject({ relationType: expect.any(String) });
    expect(normalizeMedia({ ...onePiece, relations: null }, { titleLang: 'english' }).relations).toEqual([]);
  });

  it('survives a fully-null title by falling back to Untitled', () => {
    const b = normalizeMedia({ ...onePiece, title: { romaji: null, english: null, native: null } },
                              { titleLang: 'english' });
    expect(b.displayTitle).toBe('Untitled');
  });

  it('survives an entirely empty payload without throwing', () => {
    const b = normalizeMedia({ id: 1 } as AniListMedia, { titleLang: 'english' });
    expect(b.displayTitle).toBe('Untitled');
    expect(b.genres).toEqual([]);
    expect(b.images.poster).toBeUndefined();
  });

  it('carries countryOfOrigin through so the renderer can emit both spellings', () => {
    expect(a.countryOfOrigin).toBe('JP');
  });

  it('maps MOVIE format to stremio type movie and everything else to anime', () => {
    expect(normalizeMedia({ ...onePiece, format: 'MOVIE' }, { titleLang: 'english' }).type).toBe('movie');
    expect(normalizeMedia({ ...onePiece, format: 'TV' }, { titleLang: 'english' }).type).toBe('anime');
    expect(normalizeMedia({ ...onePiece, format: 'OVA' }, { titleLang: 'english' }).type).toBe('anime');
  });

  it('builds an ISO release date and a release year from startDate', () => {
    expect(a.releaseDate).toBe('1999-10-20');
    expect(a.releaseYear).toBe(1999);
  });

  it('omits the release date when startDate is entirely null', () => {
    const b = normalizeMedia({ ...onePiece, startDate: null }, { titleLang: 'english' });
    expect(b.releaseDate).toBeUndefined();
    expect(b.releaseYear).toBeUndefined();
  });

  it('maps nextAiringEpisode into airing, and omits it when null', () => {
    expect(a.airing).toMatchObject({ nextEpisode: 1181 });
    const b = normalizeMedia({ ...onePiece, nextAiringEpisode: null }, { titleLang: 'english' });
    expect(b.airing).toBeUndefined();
  });
});
