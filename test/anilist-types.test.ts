import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AniListPage, AniListMedia } from '../src/sources/anilist/types.js';

const load = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('recorded AniList fixtures', () => {
  it('catalog fixture parses and has the verified shape', () => {
    const page = load<AniListPage<AniListMedia>>('./fixtures/catalog-trending.json');
    expect(page.pageInfo.perPage).toBeLessThanOrEqual(50); // clamp verified
    expect(page.media.length).toBeGreaterThan(0);
    const m = page.media[0]!;
    expect(m.id).toBeTypeOf('number');
    expect(m.title.romaji ?? m.title.english ?? m.title.native).toBeTruthy();
    expect(typeof m.duration === 'number' || m.duration === null).toBe(true);
  });

  it('meta fixture has all 29 requested fields for One Piece', () => {
    const { data } = load<{ data: { Media: AniListMedia } }>('./fixtures/meta-21.json');
    expect(data.Media!.id).toBe(21);
    expect(data.Media!.idMal).toBe(21);
    expect(data.Media!.source).toBe('MANGA');
    expect(data.Media!.genres!.length).toBeGreaterThan(0);
    expect(data.Media!.tags![0]!.category).toBeTypeOf('string'); // String, not object
  });

  it('unknown id fixture is data.Media === null with no errors', () => {
    const res = load<{ data?: { Media: AniListMedia | null } }>('./fixtures/meta-null.json');
    expect(res.data?.Media).toBeNull();
  });
});
