import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AniListSource } from '../src/sources/anilist/adapter.js';
import { CATALOG_DEFS, PAGE_SIZE, ANILIST_PER_PAGE } from '../src/sources/catalog-def.js';
import { CATALOG_QUERY, SEARCH_QUERY } from '../src/sources/anilist/queries.js';
import type { SourceErrorKind } from '../src/domain/errors.js';
import { SourceError } from '../src/domain/errors.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

function deps(payloads: unknown[]) {
  const queue = [...payloads];
  // Typed with the (url, init) arity the tests inspect, so mock.calls[0]
  // destructures to a real tuple instead of [].
  const getJson = vi.fn<
    (url: string, init?: { method?: string; body?: unknown }) => Promise<{
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

const page1 = load('./fixtures/catalog-trending.json');
const page2 = load('./fixtures/catalog-trending-p2.json');

describe('AniListSource.fetchPage', () => {
  it('posts CATALOG_QUERY to graphql.anilist.co with sort as a list', async () => {
    const d = deps([page1]);
    await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 });
    const [url, init] = d._getJson.mock.calls[0]!;
    expect(url).toBe('https://graphql.anilist.co');
    expect(init!.method).toBe('POST');
    const sent = JSON.parse(String(init!.body));
    expect(sent.query).toBe(CATALOG_QUERY);
    expect(sent.variables.sort).toEqual(['TRENDING_DESC']); // a LIST, per verified schema
  });

  it('returns normalised Anime items and the page total', async () => {
    const d = deps([page1]);
    const r = await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.identity.anilist).toBeTypeOf('number');
    expect(r.total).toBe(page1.data.Page.pageInfo.total);
  });

  it('throws kind=rate_limited with retryAfterSeconds when AniList 429s', async () => {
    const err = Object.assign(new Error('Too Many Requests.'), { kind: 'rate_limited' as SourceErrorKind, retryAfterSeconds: 42 });
    await expect(new AniListSource(deps([err])).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 42 });
  });

  it('unwraps the data envelope, because the live API returns {"data":{"Page":…}}', async () => {
    // A bare-PagePayload adapter passes every other test here and returns nothing
    // in production. This test is the guard.
    const page = load('./fixtures/catalog-trending.json').data.Page;
    const d = deps([{ data: { Page: page } }]);
    const r = await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.identity.anilist).toBeTypeOf('number');
  });

  it('throws kind=not_found when AniList returns a null Page', async () => {
    await expect(new AniListSource(deps([{ data: { Page: null } }]))
      .fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('throws kind=not_found when the Page carries a null media list', async () => {
    await expect(new AniListSource(deps([{ data: { Page: { pageInfo: {}, media: null } } }]))
      .fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('surfaces a GraphQL errors array as invalid_request even on HTTP 200', async () => {
    await expect(new AniListSource(deps([{ errors: [{ message: 'Variable "$sort" … expecting type "[MediaSort]".', status: 400 }] }]))
      .fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 })).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
  });

  it('never calls fetch when the limiter has no token', async () => {
    const d = deps([page1]);
    (d.limiter as unknown as { tryAcquire: () => boolean }).tryAcquire = () => false;
    await expect(new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    expect(d._getJson).not.toHaveBeenCalled();
  });

  it('uses the top-rated sort vocabulary for the top-rated catalogue', async () => {
    const d = deps([page1]);
    await new AniListSource(d).fetchPage({ catalogId: 'anime-top-rated', skip: 0, limit: 10 });
    const sent = JSON.parse(String(d._getJson.mock.calls[0]![1]!.body));
    expect(sent.variables.sort).toEqual(['SCORE_DESC']);
  });

  it('forwards genre to the AniList query when the request carries one', async () => {
    const d = deps([page1]);
    await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10, genre: 'Action' });
    const sent = JSON.parse(String(d._getJson.mock.calls[0]![1]!.body));
    expect(sent.variables.genre).toBe('Action');
  });
});

describe('AniListSource.fetchPage stitching', () => {
  // The fixtures hold 10 media each, but AniList serves 50 per page. Build
  // full-size pages with distinct ids so offset assertions can tell kept items
  // apart from discarded ones.
  function fullPage(idsFrom: number, count: number, total: number) {
    const media = Array.from({ length: count }, (_, i) => ({
      ...page1.data.Page.media[i % page1.data.Page.media.length],
      id: idsFrom + i,
    }));
    return { data: { Page: { pageInfo: { total }, media } } };
  }

  it('issues two upstream requests for a 100-item Nuvio page', async () => {
    const d = deps([fullPage(1, 50, 5000), fullPage(1001, 50, 5000)]);
    const r = await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 100 });
    expect(d._getJson).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(d._getJson.mock.calls[0]![1]!.body));
    const second = JSON.parse(String(d._getJson.mock.calls[1]![1]!.body));
    expect(first.variables.page).toBe(1);
    expect(first.variables.perPage).toBe(50);
    expect(first.variables.sort).toEqual(['TRENDING_DESC']);
    expect(second.variables.page).toBe(2);
    expect(r.items).toHaveLength(100);
    expect(r.total).toBe(5000);
  });

  it('translates skip=60 to page 2 and discards the first 10 items', async () => {
    const d = deps([fullPage(1, 50, 5000), fullPage(1001, 50, 5000), fullPage(2001, 10, 5000)]);
    const r = await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 60, limit: 100 });
    expect(d._getJson).toHaveBeenCalledTimes(3);
    const first = JSON.parse(String(d._getJson.mock.calls[0]![1]!.body));
    expect(first.variables.page).toBe(2);
    expect(first.variables.perPage).toBe(50);
    expect(r.items).toHaveLength(100);
    expect(r.items[0]!.identity.anilist).toBe(11);
    expect(r.items[40]!.identity.anilist).toBe(1001);
    expect(r.items[90]!.identity.anilist).toBe(2001);
    expect(r.total).toBe(5000);
  });
});

describe('AniListSource.search', () => {
  it('uses SEARCH_QUERY and returns matching items', async () => {
    const d = deps([load('./fixtures/catalog-search.json')]);
    const r = await new AniListSource(d).search('cowboy bebop', 0, 50);
    expect(r.items.length).toBeGreaterThan(0);
    const sent = JSON.parse(String(d._getJson.mock.calls[0]![1]!.body));
    expect(sent.query).toBe(SEARCH_QUERY);
    expect(sent.variables.search).toBe('cowboy bebop');
  });
});

describe('AniListSource.fetchById', () => {
  it('returns the Anime for a known id', async () => {
    const d = deps([{ data: { Media: load('./fixtures/meta-21.json').data.Media } }]);
    const a = await new AniListSource(d).fetchById(21);
    expect(a!.identity.anilist).toBe(21);
  });

  it('returns null, NOT an error, when data.Media is null', async () => {
    const d = deps([{ data: { Media: null } }]);
    expect(await new AniListSource(d).fetchById(99999999)).toBeNull();
  });

  it('still returns null when a 404 errors array accompanies Media: null', async () => {
    // The real AniList shape. An "errors present -> throw" rule would fail here.
    const d = deps([{ errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } }]);
    await expect(new AniListSource(d).fetchById(99999999)).resolves.toBeNull();
  });

  it('preserves that null-media behaviour across the HttpClient boundary', async () => {
    // AniList answers HTTP 200 for an unknown id; the adapter must still yield null.
    const d = deps([{ data: { Media: null } }]);
    await expect(new AniListSource(d).fetchById(99999999)).resolves.toBeNull();
  });

  it('returns null when HttpClient rejects with a 404 SourceError (live unknown-id shape)', async () => {
    // Live AniList answers an unknown Media id with HTTP 404, so HttpClient
    // throws before the adapter can inspect the body. That 404 means
    // "not found" and must resolve to null so MetaService negative-caches it.
    const d = deps([new SourceError('invalid_request', 'GET https://graphql.anilist.co failed with status 404', 404)]);
    await expect(new AniListSource(d).fetchById(99999999)).resolves.toBeNull();
  });

  it('still throws invalid_request when HttpClient rejects with a 400 SourceError', async () => {
    // Guard against blanket-converting every 4xx to null: a malformed query
    // surfaces as 400 and must remain an error, not a missing title.
    const d = deps([new SourceError('invalid_request', 'GET https://graphql.anilist.co failed with status 400', 400)]);
    await expect(new AniListSource(d).fetchById(21)).rejects.toMatchObject({ kind: 'invalid_request', status: 400 });
  });
});

describe('AniListSource per-attempt timeout', () => {
  // The chain threads its remaining budget into each attempt; the adapter must
  // forward it to the HTTP call so a slow primary times out with room left for
  // the fallback. The key is omitted (not undefined) when no bound arrives.
  it('forwards timeoutMs to the HTTP call on fetchPage, search and fetchById', async () => {
    const dPage = deps([page1]);
    await new AniListSource(dPage).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10, timeoutMs: 123 });
    expect(
      dPage._getJson.mock.calls[0]![1] as { method?: string; body?: unknown; timeoutMs?: number },
    ).toMatchObject({ timeoutMs: 123 });

    const dSearch = deps([load('./fixtures/catalog-search.json')]);
    await new AniListSource(dSearch).search('cowboy bebop', 0, 50, 456);
    expect(
      dSearch._getJson.mock.calls[0]![1] as { method?: string; body?: unknown; timeoutMs?: number },
    ).toMatchObject({ timeoutMs: 456 });

    const dMeta = deps([{ data: { Media: load('./fixtures/meta-21.json').data.Media } }]);
    await new AniListSource(dMeta).fetchById(21, 789);
    expect(
      dMeta._getJson.mock.calls[0]![1] as { method?: string; body?: unknown; timeoutMs?: number },
    ).toMatchObject({ timeoutMs: 789 });
  });

  it('omits the timeoutMs key when the caller passes no bound', async () => {
    const d = deps([page1]);
    await new AniListSource(d).fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 10 });
    const init = d._getJson.mock.calls[0]![1] as Record<string, unknown> | undefined;
    expect('timeoutMs' in (init ?? {})).toBe(false);
  });
});

describe('catalog definitions', () => {
  it('declares exactly three Phase 1 catalogues, all type anime', () => {
    expect(Object.keys(CATALOG_DEFS).sort()).toEqual(['anime-search', 'anime-top-rated', 'anime-trending']);
    for (const c of Object.values(CATALOG_DEFS)) expect(c.type).toBe('anime');
  });

  it('marks only anime-search as searchable', () => {
    expect(CATALOG_DEFS['anime-search'].supportsSearch).toBe(true);
    expect(CATALOG_DEFS['anime-trending'].supportsSearch).toBe(false);
    expect(CATALOG_DEFS['anime-top-rated'].supportsSearch).toBe(false);
  });

  it('pins PAGE_SIZE to 100 and ANILIST_PER_PAGE to AniList\'s verified clamp', () => {
    expect(PAGE_SIZE).toBe(100);
    expect(ANILIST_PER_PAGE).toBe(50);
    expect(PAGE_SIZE % ANILIST_PER_PAGE).toBe(0); // exactly 2 upstream pages per Nuvio page
  });
});

describe('page 1 and page 2 are disjoint (Review Focus #1)', () => {
  it('has no overlapping ids across the two recorded pages', () => {
    const a = new Set(page1.data.Page.media.map((m: { id: number }) => m.id));
    const b = page2.data.Page.media.map((m: { id: number }) => m.id);
    expect(page1.data.Page.media.some((m: { id: number }) => b.includes(m.id))).toBe(false);
    expect(a.size).toBe(page1.data.Page.media.length);
  });
});
