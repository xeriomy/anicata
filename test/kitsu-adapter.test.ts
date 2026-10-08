import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { KitsuSource, kitsuSort, KITSU_PER_CALL_RESERVE_MS } from '../src/sources/kitsu/adapter.js';
import type { AnimeSource } from '../src/sources/types.js';
import { SourceError } from '../src/domain/errors.js';
import { renderPreview } from '../src/render/preview.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

function deps(payloads: unknown[]) {
  const queue = [...payloads];
  // Typed with the (url, init) arity the tests inspect, so mock.calls entries
  // carry the url and init the helpers read instead of typing as [].
  const getJson = vi.fn<
    (url: string, init?: { headers?: Record<string, string> }) => Promise<{
      data: unknown;
      headers: Record<string, string>;
      status: number;
    }>
  >(async () => {
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

describe('KitsuSource page[limit] cap stitching', () => {
  // Kitsu rejects page[limit] > 20 with HTTP 400 (measured live 2026-10-08:
  // limit=20 -> 200, limit=21 -> 400), so any limit above the cap must be
  // stitched from sequential upstream calls of at most 20. These tests pin
  // that: a limit-100 request must never emit page[limit]=100.
  function pageOf(size: number, startId: number, total: number): unknown {
    const records = pageFixture.data as unknown[];
    const data = [];
    for (let i = 0; i < size; i++) {
      const clone = JSON.parse(JSON.stringify(records[i % records.length])) as { id: string };
      clone.id = String(startId + i);
      data.push(clone);
    }
    return { data, meta: { count: total } };
  }

  function fullHundred(): unknown[] {
    return [
      pageOf(20, 1, 500),
      pageOf(20, 21, 500),
      pageOf(20, 41, 500),
      pageOf(20, 61, 500),
      pageOf(20, 81, 500),
    ];
  }

  function limitsOf(d: ReturnType<typeof deps>): (string | null)[] {
    return d._getJson.mock.calls.map((_, i) => calledUrl(d, i).searchParams.get('page[limit]'));
  }

  function offsetsOf(d: ReturnType<typeof deps>): (string | null)[] {
    return d._getJson.mock.calls.map((_, i) => calledUrl(d, i).searchParams.get('page[offset]'));
  }

  it('never requests page[limit] above 20 for a limit-100 fetchPage', async () => {
    const d = deps(fullHundred());
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100 });
    expect(d._getJson).toHaveBeenCalledTimes(5);
    for (const limit of limitsOf(d)) {
      expect(Number(limit)).toBeLessThanOrEqual(20);
    }
    expect(r.items).toHaveLength(100);
  });

  it('walks offsets 0/20/40/60/80 for a limit-100 fetchPage and reads total from meta.count', async () => {
    const d = deps(fullHundred());
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100 });
    expect(offsetsOf(d)).toEqual(['0', '20', '40', '60', '80']);
    expect(r.total).toBe(500);
    expect(new Set(r.items.map((a) => a.identity.kitsu)).size).toBe(100);
  });

  it('offsets a skip-100 page as 100/120/140/160/180', async () => {
    const d = deps(fullHundred());
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-trending', skip: 100, limit: 100 });
    expect(d._getJson).toHaveBeenCalledTimes(5);
    expect(offsetsOf(d)).toEqual(['100', '120', '140', '160', '180']);
    expect(r.items).toHaveLength(100);
  });

  it('stops the fetchPage sequence early when an upstream page comes up short', async () => {
    const d = deps([pageOf(20, 1, 27), pageOf(7, 21, 27)]);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100 });
    expect(d._getJson).toHaveBeenCalledTimes(2);
    expect(r.items).toHaveLength(27);
    expect(r.total).toBe(27);
  });

  it('stitches a limit-100 search from capped calls with filter[text] and no sort', async () => {
    const d = deps(fullHundred());
    const r = await new KitsuSource(d).search('frieren', 0, 100);
    expect(d._getJson).toHaveBeenCalledTimes(5);
    for (const limit of limitsOf(d)) {
      expect(Number(limit)).toBeLessThanOrEqual(20);
    }
    expect(offsetsOf(d)).toEqual(['0', '20', '40', '60', '80']);
    const first = calledUrl(d);
    expect(first.searchParams.get('filter[text]')).toBe('frieren');
    expect(first.searchParams.has('sort')).toBe(false);
    expect(r.items).toHaveLength(100);
    expect(r.total).toBe(500);
  });

  it('stops the search sequence early when an upstream page comes up short', async () => {
    const d = deps([pageOf(20, 1, 32), pageOf(12, 21, 32)]);
    const r = await new KitsuSource(d).search('frieren', 0, 100);
    expect(d._getJson).toHaveBeenCalledTimes(2);
    expect(r.items).toHaveLength(32);
  });

  it('forwards the per-attempt timeoutMs to every upstream call of a stitched sequence', async () => {
    // Ample budget so all five calls start; each carries the remaining budget
    // at its start (first call the full bound, later calls whatever is left).
    const dPage = deps(fullHundred());
    await new KitsuSource(dPage).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100, timeoutMs: 20000 });
    expect(dPage._getJson).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      const init = dPage._getJson.mock.calls[i]![1] as { timeoutMs?: number };
      expect(init.timeoutMs).toBeGreaterThan(20000 - 1000);
      expect(init.timeoutMs).toBeLessThanOrEqual(20000);
    }

    const dSearch = deps(fullHundred());
    await new KitsuSource(dSearch).search('frieren', 0, 100, 20000);
    expect(dSearch._getJson).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      const init = dSearch._getJson.mock.calls[i]![1] as { timeoutMs?: number };
      expect(init.timeoutMs).toBeGreaterThan(20000 - 1000);
      expect(init.timeoutMs).toBeLessThanOrEqual(20000);
    }
  });
});

describe('KitsuSource budget-aware partial fill', () => {
  // A single 20-item Kitsu call costs 1.1–1.6 s live, so a 100-item fill
  // (~5–7 s) does not fit the 4.5 s chain budget. The adapter must stop before
  // starting a call the remaining budget cannot fit and serve what it has:
  // 100 items when Kitsu is fast, fewer when slow, never a doomed call. Time
  // advances once per upstream call here, simulating slow Kitsu deterministically.
  function pageOf(size: number, startId: number, total: number): unknown {
    const records = pageFixture.data as unknown[];
    const data = [];
    for (let i = 0; i < size; i++) {
      const clone = JSON.parse(JSON.stringify(records[i % records.length])) as { id: string };
      clone.id = String(startId + i);
      data.push(clone);
    }
    return { data, meta: { count: total } };
  }

  function fullHundred(): unknown[] {
    return [
      pageOf(20, 1, 500),
      pageOf(20, 21, 500),
      pageOf(20, 41, 500),
      pageOf(20, 61, 500),
      pageOf(20, 81, 500),
    ];
  }

  function budgetDeps(payloads: unknown[], tickMs: number) {
    let nowMs = 0;
    const d = deps(payloads);
    const inner = d._getJson.getMockImplementation();
    d._getJson.mockImplementation(async (url, init) => {
      nowMs += tickMs;
      if (inner === undefined) {
        throw new Error('budgetDeps: no inner mock implementation');
      }
      return inner(url, init);
    });
    return { http: d.http, limiter: d.limiter, log: d.log, now: () => nowMs, _getJson: d._getJson };
  }

  function callTimeouts(d: ReturnType<typeof budgetDeps>): (number | undefined)[] {
    return d._getJson.mock.calls.map(
      (c) => (c[1] as { headers?: Record<string, string>; timeoutMs?: number } | undefined)?.timeoutMs,
    );
  }

  it('pins the per-call reserve at 2000 ms, the honest floor for a 1.1–1.6 s call', () => {
    expect(KITSU_PER_CALL_RESERVE_MS).toBe(2000);
  });

  it('still fills to 100 with an ample budget', async () => {
    const d = budgetDeps(fullHundred(), 1300);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100, timeoutMs: 20000 });
    expect(d._getJson).toHaveBeenCalledTimes(5);
    expect(r.items).toHaveLength(100);
    expect(r.total).toBe(500);
  });

  it('returns a partial page, not an empty one, when the budget is tight', async () => {
    // 2500 ms budget, 1300 ms per call: the first call always starts, then
    // 2500 − 1300 = 1200 < 2000 reserve stops the sequence at 20 items.
    const d = budgetDeps(fullHundred(), 1300);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100, timeoutMs: 2500 });
    expect(d._getJson).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(20);
  });

  it('never starts a call it cannot afford and shrinks each per-call timeout to what is left', async () => {
    // 4000 ms budget, 1300 ms per call: call 1 (timeout 4000), then
    // 4000 − 1300 = 2700 ≥ 2000 so call 2 (timeout 2700), then
    // 4000 − 2600 = 1400 < 2000 so stop — the third call is never started.
    const d = budgetDeps(fullHundred(), 1300);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100, timeoutMs: 4000 });
    expect(d._getJson).toHaveBeenCalledTimes(2);
    expect(r.items).toHaveLength(40);
    expect(callTimeouts(d)).toEqual([4000, 2700]);
  });

  it('keeps total meaningful for client paging when the fill was truncated', async () => {
    const d = budgetDeps(fullHundred(), 1300);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100, timeoutMs: 2500 });
    expect(r.items).toHaveLength(20);
    expect(r.total).toBe(500);
  });

  it('a short upstream page still terminates early under a budget', async () => {
    const d = deps([pageOf(20, 1, 27), pageOf(7, 21, 27)]);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100, timeoutMs: 4000 });
    expect(d._getJson).toHaveBeenCalledTimes(2);
    expect(r.items).toHaveLength(27);
    expect(r.total).toBe(27);
  });

  it('fills fully with no bound even when each call is slow', async () => {
    // The reserve only applies when the chain threaded a budget in; outside
    // a chain (live probes, unit tests) fills run to completion.
    const d = budgetDeps(fullHundred(), 5000);
    const r = await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 100 });
    expect(d._getJson).toHaveBeenCalledTimes(5);
    expect(r.items).toHaveLength(100);
  });

  it('stitches search the same way: full with ample budget, partial when tight', async () => {
    const dFull = budgetDeps(fullHundred(), 1300);
    const rFull = await new KitsuSource(dFull).search('frieren', 0, 100, 20000);
    expect(dFull._getJson).toHaveBeenCalledTimes(5);
    expect(rFull.items).toHaveLength(100);
    expect(rFull.total).toBe(500);

    const dTight = budgetDeps(fullHundred(), 1300);
    const rTight = await new KitsuSource(dTight).search('frieren', 0, 100, 2500);
    expect(dTight._getJson).toHaveBeenCalledTimes(1);
    expect(rTight.items).toHaveLength(20);
    expect(rTight.total).toBe(500);
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

  it('renders under the kitsu: namespace, never anilist:', async () => {
    // A Kitsu id published as `anilist:<id>` points at a different show on
    // AniList (the namespaces collide), so the meta link and artwork would
    // describe two different titles. This assertion would have caught that.
    const d = deps([anime1Fixture]);
    const a = await new KitsuSource(d).fetchById(1);
    expect(renderPreview(a!).id).toBe('kitsu:1');
  });
});

describe('KitsuSource per-attempt timeout', () => {
  // The chain threads its remaining budget into each attempt; the adapter must
  // forward it to the HTTP call so the fallback attempt is itself bounded. The
  // key is omitted (not undefined) when no bound arrives.
  it('forwards timeoutMs to the HTTP call on fetchPage, search and fetchById', async () => {
    const dPage = deps([pageFixture]);
    await new KitsuSource(dPage).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3, timeoutMs: 123 });
    expect(
      dPage._getJson.mock.calls[0]![1] as { headers?: Record<string, string>; timeoutMs?: number },
    ).toMatchObject({ timeoutMs: 123 });

    const dSearch = deps([pageFixture]);
    await new KitsuSource(dSearch).search('cowboy bebop', 0, 3, 456);
    expect(
      dSearch._getJson.mock.calls[0]![1] as { headers?: Record<string, string>; timeoutMs?: number },
    ).toMatchObject({ timeoutMs: 456 });

    const dMeta = deps([anime1Fixture]);
    await new KitsuSource(dMeta).fetchById(1, 789);
    expect(
      dMeta._getJson.mock.calls[0]![1] as { headers?: Record<string, string>; timeoutMs?: number },
    ).toMatchObject({ timeoutMs: 789 });
  });

  it('omits the timeoutMs key when the caller passes no bound', async () => {
    const d = deps([pageFixture]);
    await new KitsuSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 3 });
    const init = d._getJson.mock.calls[0]![1] as Record<string, unknown> | undefined;
    expect('timeoutMs' in (init ?? {})).toBe(false);
  });
});
