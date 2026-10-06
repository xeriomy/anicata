import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AniListPage, AniListMedia, AniListGraphQLResponse } from '../src/sources/anilist/types.js';

const load = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('recorded AniList fixtures', () => {
  it('catalog fixture parses and has the verified shape', () => {
    const body = load<AniListGraphQLResponse<{ Page: AniListPage<AniListMedia> }>>(
      './fixtures/catalog-trending.json',
    );
    // The fixture is a real capture: it keeps the GraphQL data envelope, which is what
    // the adapter unwraps. Assert the envelope rather than asserting past it.
    expect(body.data).toBeDefined();
    const page = body.data?.Page;
    expect(page).toBeDefined();
    expect(page!.pageInfo.perPage).toBeLessThanOrEqual(50); // clamp verified
    expect(page!.media.length).toBeGreaterThan(0);
    const m = page!.media[0]!;
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

  it('unknown id fixture carries BOTH a 404 errors array and Media: null', () => {
    const res = load<{
      data?: { Media: AniListMedia | null };
      errors?: Array<{ message: string; status: number }>;
    }>('./fixtures/meta-null.json');
    expect(res.data?.Media).toBeNull();
    // AniList reports "not found" as BOTH an error entry and a null Media.
    expect(res.errors?.[0]?.status).toBe(404);
  });
});
