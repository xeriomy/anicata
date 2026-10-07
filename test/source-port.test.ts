import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AnimeSource } from '../src/sources/types.js';
import { AniListSource } from '../src/sources/anilist/adapter.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

function deps(payloads: unknown[]) {
  const queue = [...payloads];
  // Typed with the (url, init) arity the test inspects, so mock.calls[0]
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

function pageOf(idsFrom: number, count: number, total: number) {
  const fixture = load('./fixtures/catalog-trending.json').data.Page;
  const media = Array.from({ length: count }, (_, i) => ({
    ...fixture.media[i % fixture.media.length],
    id: idsFrom + i,
  }));
  return { data: { Page: { pageInfo: { total }, media } } };
}

describe('AnimeSource port', () => {
  it('AniListSource satisfies the source-agnostic port', () => {
    const src = new AniListSource({} as never);
    const asPort: AnimeSource = src;
    expect(asPort.id).toBe('anilist');
  });

  it('fetchPage takes skip/limit, not an AniList query', async () => {
    const d = deps([pageOf(1000, 50, 5000)]);
    const src = new AniListSource(d);
    // The caller supplies no AniList vocabulary: no sort, no page, no perPage.
    const req = { catalogId: 'anime-trending', skip: 60, limit: 30 };
    expect(req).not.toHaveProperty('sort');
    expect(req).not.toHaveProperty('page');
    expect(req).not.toHaveProperty('perPage');
    const res = await src.fetchPage(req);
    // skip=60, limit=30 -> one AniList request for page 2, perPage 50, then the
    // first 10 items are discarded and the rest truncated to the limit.
    expect(d._getJson).toHaveBeenCalledTimes(1);
    const [url, init] = d._getJson.mock.calls[0]!;
    expect(url).toBe('https://graphql.anilist.co');
    const sent = JSON.parse(String(init!.body));
    expect(sent.variables.page).toBe(2);
    expect(sent.variables.perPage).toBe(50);
    expect(sent.variables.sort).toEqual(['TRENDING_DESC']);
    expect(res.items).toHaveLength(30);
    expect(res.items[0]!.identity.anilist).toBe(1010);
    expect(res.total).toBe(5000);
  });
});
