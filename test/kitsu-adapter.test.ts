import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { KitsuSource, kitsuSort } from '../src/sources/kitsu/adapter.js';
import type { AnimeSource } from '../src/sources/types.js';
import { SourceError } from '../src/domain/errors.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

function deps(payloads: unknown[]) {
  const queue = [...payloads];
  const getJson = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { data: next, headers: {}, status: 200 };
  });
  const limiter = { tryAcquire: () => true, available: () => 25, msUntilNextToken: () => 0 };
  return {
    http: { getJson } as never,
    limiter: limiter as never,
    log: { debug(){}, info(){}, warn(){}, error(){} },
    _getJson: getJson,
  };
}

function calledUrl(d: ReturnType<typeof deps>, call = 0): URL {
  return new URL(String(d._getJson.mock.calls[call]![0]));
}

function calledHeaders(d: ReturnType<typeof deps>, call = 0): Record<string, string> {
  const init = d._getJson.mock.calls[call]![1] as { headers?: Record<string, string> };
  return init?.headers ?? {};
}

const pageFixture = load('./fixtures/kitsu-page.json');
const anime1Fixture = load('./fixtures/kitsu-anime-1.json');

describe('kitsuSort', () => {
  it("maps top_rated to Kitsu's average-rating sort", () => {
    expect(kitsuSort('top_rated')).toBe('-averageRating');
  });

  it('maps trending to -userCount, the documented most-favorited proxy', () => {
    // Kitsu has no trending sort (verified 2026-10-07: trending,
    // recently_popular, relevance, title and favorites all 400), so trending
    // is deliberately approximated, not exact.
    expect(kitsuSort('trending')).toBe('-userCount');
  });

  it('maps search_match to no sort, because filter[text] ranks by relevance', () => {
    expect(kitsuSort('search_match')).toBe('');
  });
});

describe('KitsuSource identity', () => {
  it("has id 'kitsu' and satisfies the source-agnostic port", () => {
    const src = new KitsuSource(deps([]));
    const asPort: AnimeSource = src;
    expect(asPort.id).toBe('kitsu');
  });
});

describe('KitsuSource.fetchPage', () => {
  it('requests the Kitsu edge anime collection with sort, paging, genres and the JSON:API header', async () => {
    const d = deps([pageFixture]);
    await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3 });
    const url = calledUrl(d);
    expect(`${url.origin}${url.pathname}`).toBe('https://kitsu.io/api/edge/anime');
    expect(url.searchParams.get('sort')).toBe('-averageRating');
    expect(url.searchParams.get('page[limit]')).toBe('3');
    expect(url.searchParams.get('page[offset]')).toBe('0');
    expect(url.searchParams.get('include')).toBe('genres');
    expect(calledHeaders(d).Accept).toBe('application/vnd.api+json');
  });

  it('uses the -userCount proxy sort for the trending catalogue', async () => {
    const d = deps([pageFixture]);
    await new KitsuSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 3 });
    expect(calledUrl(d).searchParams.get('sort')).toBe('-userCount');
  });

  it('translates skip/limit directly to page[offset]/page[limit]', async () => {
    const d = deps([pageFixture]);
    await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 20, limit: 10 });
    const url = calledUrl(d);
    expect(url.searchParams.get('page[offset]')).toBe('20');
    expect(url.searchParams.get('page[limit]')).toBe('10');
  });

  it('forwards genre as filter[genres] when the request carries one', async () => {
    const d = deps([pageFixture]);
    await new KitsuSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 3, genre: 'Action' });
    expect(calledUrl(d).searchParams.get('filter[genres]')).toBe('Action');
  });

  it('unwraps the JSON:API data envelope and reads the total from meta.count', async () => {
    const d = deps([pageFixture]);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3 });
    expect(r.items).toHaveLength(pageFixture.data.length);
    expect(r.total).toBe(pageFixture.meta.count);
  });

  it('yields an empty genres array, never undefined, when the record has none', async () => {
    // The page fixture's records carry an empty genres relationship and no
    // `included` section at all.
    expect(pageFixture.included).toBeUndefined();
    const d = deps([pageFixture]);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3 });
    for (const item of r.items) {
      expect(item.genres).toEqual([]);
    }
  });

  it('maps a movie record to MOVIE format with type movie', async () => {
    const d = deps([pageFixture]);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3 });
    const movie = r.items.find((a) => a.format === 'MOVIE')!;
    expect(movie.displayTitle).toBe(pageFixture.data[0].attributes.titles.en);
    expect(movie.type).toBe('movie');
    expect(movie.status).toBe('FINISHED');
  });

  it('never calls fetch when the limiter has no token', async () => {
    const d = deps([pageFixture]);
    (d.limiter as unknown as { tryAcquire: () => boolean }).tryAcquire = () => false;
    await expect(new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3 }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    expect(d._getJson).not.toHaveBeenCalled();
  });
});

describe('KitsuSource genres', () => {
  // Wrap the single-anime fixture's record in a list envelope so the join
  // runs through fetchPage exactly as production responses do.
  function singleAsPage() {
    return { data: [anime1Fixture.data], included: anime1Fixture.included, meta: { count: 1 } };
  }

  it('joins genre names from included, not from the record', async () => {
    expect(anime1Fixture.data.relationships.genres.data.length).toBeGreaterThan(0);
    expect(anime1Fixture.data.attributes.genres).toBeUndefined();
    const d = deps([singleAsPage()]);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 1 });
    expect(r.items[0]!.genres).toContain('Action');
    expect(r.items[0]!.genres.length).toBe(anime1Fixture.data.relationships.genres.data.length);
  });
});

describe('KitsuSource.search', () => {
  it('uses filter[text] with no sort param, keeping server-side relevance ranking', async () => {
    const d = deps([pageFixture]);
    const r = await new KitsuSource(d).search('cowboy bebop', 0, 3);
    const url = calledUrl(d);
    expect(url.searchParams.get('filter[text]')).toBe('cowboy bebop');
    expect(url.searchParams.has('sort')).toBe(false);
    expect(url.searchParams.get('include')).toBe('genres');
    expect(r.items.length).toBeGreaterThan(0);
  });

  it('translates skip/limit to page[offset]/page[limit]', async () => {
    const d = deps([pageFixture]);
    await new KitsuSource(d).search('frieren', 10, 5);
    const url = calledUrl(d);
    expect(url.searchParams.get('page[offset]')).toBe('10');
    expect(url.searchParams.get('page[limit]')).toBe('5');
  });
});

describe('KitsuSource.fetchById', () => {
  it('returns the Anime for a known id', async () => {
    const d = deps([anime1Fixture]);
    const a = await new KitsuSource(d).fetchById(1);
    expect(calledUrl(d).pathname).toBe('/api/edge/anime/1');
    expect(a!.displayTitle).toBe('Cowboy Bebop');
    expect(a!.status).toBe('FINISHED');
    expect(a!.format).toBe('TV');
    expect(a!.episodes).toBe(26);
    expect(a!.genres).toContain('Action');
  });

  it('coerces the string averageRating Kitsu sends', () => {
    // The fixture carries attributes.averageRating === "82.27" (a string).
    expect(anime1Fixture.data.attributes.averageRating).toBe('82.27');
  });

  it('exposes that coerced rating as scoreAnilist 82.27, never NaN', async () => {
    const d = deps([anime1Fixture]);
    const a = await new KitsuSource(d).fetchById(1);
    expect(a!.scoreAnilist).toBe(82.27);
    expect(Number.isNaN(a!.scoreAnilist)).toBe(false);
  });

  it('returns null, NOT an error, when HttpClient rejects with a 404 SourceError', async () => {
    // Live Kitsu answers an unknown anime id with HTTP 404, so HttpClient
    // throws before the adapter can inspect the body. That 404 means
    // "not found" and must resolve to null so the negative cache applies.
    const d = deps([new SourceError('invalid_request', 'GET https://kitsu.io/api/edge/anime/999999999 failed with status 404', 404)]);
    await expect(new KitsuSource(d).fetchById(999999999)).resolves.toBeNull();
  });

  it('returns null when the body carries a null data record', async () => {
    const d = deps([{ data: null }]);
    await expect(new KitsuSource(d).fetchById(999999999)).resolves.toBeNull();
  });

  it('still throws invalid_request when HttpClient rejects with a 400 SourceError', async () => {
    // Guard against blanket-converting every 4xx to null: a malformed query
    // surfaces as 400 and must remain an error, not a missing title.
    const d = deps([new SourceError('invalid_request', 'GET https://kitsu.io/api/edge/anime failed with status 400', 400)]);
    await expect(new KitsuSource(d).fetchById(1)).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
  });
});
