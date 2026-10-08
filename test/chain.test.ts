import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../src/net/breaker.js';
import { SourceError } from '../src/domain/errors.js';
import type { Anime } from '../src/domain/anime.js';
import type {
  AnimeSource,
  PageRequest,
  SourceId,
  SourcePage,
} from '../src/sources/types.js';
import { SourceChain } from '../src/sources/chain.js';
import { chainBudgetForHttpTimeout } from '../src/index.js';

function anime(n: number, source: SourceId): Anime {
  return {
    identity: source === 'anilist' ? { anilist: n } : { kitsu: n },
    title: { synonyms: [] },
    displayTitle: `Title ${String(n)}`,
    format: 'TV',
    status: 'FINISHED',
    type: 'anime',
    genres: [],
    tags: [],
    studios: [],
    relations: [],
    images: {},
    hashtags: [],
  };
}

function page(ids: number[], source: SourceId, total: number): SourcePage {
  return { items: ids.map((n) => anime(n, source)), total };
}

const REQ: PageRequest = { catalogId: 'trending', skip: 0, limit: 20 };

interface FakeSource extends AnimeSource {
  fetchPageMock: ReturnType<typeof vi.fn<(req: PageRequest) => Promise<SourcePage>>>;
  searchMock: ReturnType<typeof vi.fn<(term: string, skip: number, limit: number, timeoutMs?: number) => Promise<SourcePage>>>;
  fetchByIdMock: ReturnType<typeof vi.fn<(id: number, timeoutMs?: number) => Promise<Anime | null>>>;
}

function fakeSource(id: SourceId): FakeSource {
  const fetchPageMock = vi.fn<(req: PageRequest) => Promise<SourcePage>>();
  const fetchByIdMock = vi.fn<(id: number, timeoutMs?: number) => Promise<Anime | null>>();
  const searchMock = vi.fn<(term: string, skip: number, limit: number, timeoutMs?: number) => Promise<SourcePage>>();
  return {
    id,
    fetchPage: (req: PageRequest) => fetchPageMock(req),
    search: (term: string, skip: number, limit: number, timeoutMs?: number) => {
      if (timeoutMs === undefined) {
        return searchMock(term, skip, limit);
      }
      return searchMock(term, skip, limit, timeoutMs);
    },
    fetchById: (num: number, timeoutMs?: number) => {
      if (timeoutMs === undefined) {
        return fetchByIdMock(num);
      }
      return fetchByIdMock(num, timeoutMs);
    },
    fetchPageMock,
    searchMock,
    fetchByIdMock,
  };
}

function breakers(
  now: () => number,
  failureThreshold: number,
): Map<SourceId, CircuitBreaker> {
  return new Map<SourceId, CircuitBreaker>([
    ['anilist', new CircuitBreaker({ failureThreshold, cooldownMs: 30_000, now })],
    ['kitsu', new CircuitBreaker({ failureThreshold, cooldownMs: 30_000, now })],
  ]);
}

function setup(opts?: {
  budgetMs?: number;
  stickyTtlMs?: number;
  threshold?: number;
  realClock?: boolean;
}): {
  chain: SourceChain;
  primary: FakeSource;
  fallback: FakeSource;
  breakerMap: Map<SourceId, CircuitBreaker>;
  advance: (ms: number) => void;
} {
  let now = 0;
  const advance = (ms: number): void => {
    now += ms;
  };
  const primary = fakeSource('anilist');
  const fallback = fakeSource('kitsu');
  const clock = (): number => now;
  const breakerMap = breakers(opts?.realClock === true ? Date.now : clock, opts?.threshold ?? 5);
  const chain = new SourceChain({
    sources: [primary, fallback],
    breakers: breakerMap,
    budgetMs: opts?.budgetMs ?? 4000,
    stickyTtlMs: opts?.stickyTtlMs ?? 600_000,
    ...(opts?.realClock === true ? {} : { now: clock }),
  });
  return { chain, primary, fallback, breakerMap, advance };
}

describe('SourceChain.fetchPage', () => {
  it('primary healthy → fromFallback false, zero fallback calls', async () => {
    const { chain, primary, fallback } = setup();
    primary.fetchPageMock.mockResolvedValue(page([1, 2], 'anilist', 2));
    const res = await chain.fetchPage('trending', REQ);
    expect(res.sourceId).toBe('anilist');
    expect(res.fromFallback).toBe(false);
    expect(res.items).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('primary 5xx → fallback serves, fromFallback true', async () => {
    const { chain, primary, fallback } = setup();
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'boom'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    const res = await chain.fetchPage('trending', REQ);
    expect(res.sourceId).toBe('kitsu');
    expect(res.fromFallback).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(primary.fetchPageMock).toHaveBeenCalledTimes(1);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(1);
  });

  it('primary 429 → throws the rate_limited error, fallback spy shows 0 calls', async () => {
    const { chain, primary, fallback, breakerMap } = setup();
    const cause = new SourceError('rate_limited', 'slow down');
    primary.fetchPageMock.mockRejectedValue(cause);
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.fetchPage('trending', REQ)).rejects.toBe(cause);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
    // A 429 means the source is healthy: the breaker must not record a failure.
    expect(breakerMap.get('anilist')?.canAttempt()).toBe(true);
  });

  it('primary 404 → 0 fallback calls, error propagates', async () => {
    const { chain, primary, fallback } = setup();
    const cause = new SourceError('not_found', 'no such page');
    primary.fetchPageMock.mockRejectedValue(cause);
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.fetchPage('trending', REQ)).rejects.toBe(cause);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('primary invalid_request → 0 fallback calls, error propagates', async () => {
    const { chain, primary, fallback } = setup();
    const cause = new SourceError('invalid_request', 'our bug');
    primary.fetchPageMock.mockRejectedValue(cause);
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.fetchPage('trending', REQ)).rejects.toBe(cause);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('primary returns empty → success, 0 fallback calls', async () => {
    const { chain, primary, fallback } = setup();
    primary.fetchPageMock.mockResolvedValue({ items: [], total: 0 });
    const res = await chain.fetchPage('trending', REQ);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.fromFallback).toBe(false);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('open breaker on the primary → zero network calls to the primary', async () => {
    const { chain, primary, fallback, breakerMap } = setup({ threshold: 1 });
    breakerMap.get('anilist')?.recordFailure();
    expect(breakerMap.get('anilist')?.canAttempt()).toBe(false);
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    const res = await chain.fetchPage('trending', REQ);
    expect(res.sourceId).toBe('kitsu');
    expect(res.fromFallback).toBe(true);
    expect(primary.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('both fail → throws the last SourceError, never a raw rejection', async () => {
    const { chain, primary, fallback } = setup();
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'primary down'));
    const last = new SourceError('network', 'fallback down');
    fallback.fetchPageMock.mockRejectedValue(last);
    const err = await chain.fetchPage('trending', REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toBe(last);
  });

  it('a slow primary cannot push the total past budgetMs (injected clock)', async () => {
    const { chain, primary, fallback, advance } = setup({ budgetMs: 4000 });
    const cause = new SourceError('server_error', 'slow then down');
    primary.fetchPageMock.mockImplementation(() => {
      advance(5000);
      return Promise.reject(cause);
    });
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    // The primary consumed the whole budget, so the fallback must never start
    // and the primary error propagates.
    await expect(chain.fetchPage('trending', REQ)).rejects.toBe(cause);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('partial budget consumed → fallback still attempted with what remains', async () => {
    const { chain, primary, fallback, advance } = setup({ budgetMs: 4000 });
    primary.fetchPageMock.mockImplementation(() => {
      advance(1500);
      return Promise.reject(new SourceError('server_error', 'flaky'));
    });
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    const res = await chain.fetchPage('trending', REQ);
    expect(res.sourceId).toBe('kitsu');
    expect(res.fromFallback).toBe(true);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(1);
  });

  it('a hung primary is cut off by the real deadline; an expired deadline starts nothing', async () => {
    // Real clock here: only wall-clock time passes while a source hangs, so
    // only the real clock can observe the deadline expiring mid-request.
    const { chain, primary, fallback } = setup({ budgetMs: 50, realClock: true });
    primary.fetchPageMock.mockImplementation(() => new Promise<SourcePage>(() => {}));
    fallback.fetchPageMock.mockImplementation(() => new Promise<SourcePage>(() => {}));
    const started = Date.now();
    const err = await chain.fetchPage('trending', REQ).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe('timeout');
    // The primary burned the 50 ms budget hanging, so the fallback never starts.
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
    // Bounded well under any naive sequential sum: the hang cannot stall us.
    expect(elapsed).toBeLessThan(5000);
  });

  it('server_error counts as failure: the fifth consecutive failure opens the breaker', async () => {
    const { chain, primary, fallback, breakerMap } = setup({ threshold: 5 });
    const b = breakerMap.get('anilist');
    for (let i = 0; i < 4; i += 1) {
      b?.recordFailure();
    }
    expect(b?.canAttempt()).toBe(true);
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await chain.fetchPage('trending', REQ);
    // The chain recorded a failure (not success): the breaker is now open.
    expect(b?.state).toBe('open');
    expect(b?.canAttempt()).toBe(false);
  });

  it('not_found counts as success: repeated 404s never open the breaker', async () => {
    const { chain, primary, fallback, breakerMap } = setup({ threshold: 5 });
    const b = breakerMap.get('anilist');
    for (let i = 0; i < 4; i += 1) {
      b?.recordFailure();
    }
    primary.fetchPageMock.mockRejectedValue(new SourceError('not_found', 'absent'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.fetchPage('trending', REQ)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
    // A fifth failure would have opened it; success reset the count instead.
    expect(b?.canAttempt()).toBe(true);
    expect(b?.state).toBe('closed');
  });

  it('eligible failure is recorded: threshold reached opens the breaker', async () => {
    const { chain, primary, fallback, breakerMap } = setup({ threshold: 1 });
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await chain.fetchPage('trending', REQ);
    expect(breakerMap.get('anilist')?.canAttempt()).toBe(false);
  });
});

describe('SourceChain stickiness', () => {
  it('a sticky key returns the same source for a second call within the TTL', async () => {
    const { chain, primary, fallback } = setup({ stickyTtlMs: 1000 });
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    const first = await chain.fetchPage('trending', REQ, 'trending:Action');
    expect(first.sourceId).toBe('kitsu');
    expect(chain.peekSticky('trending:Action')).toBe('kitsu');
    const second = await chain.fetchPage('trending', REQ, 'trending:Action');
    expect(second.sourceId).toBe('kitsu');
    // The primary is skipped outright on the second call: still one call.
    expect(primary.fetchPageMock).toHaveBeenCalledTimes(1);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(2);
  });

  it('a different catalogue key has its own stickiness', async () => {
    const { chain, primary, fallback } = setup({ stickyTtlMs: 1000 });
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await chain.fetchPage('trending', REQ, 'trending:Action');
    // Top Rated never fell back: it still starts at the primary.
    primary.fetchPageMock.mockResolvedValue(page([1], 'anilist', 1));
    const res = await chain.fetchPage('top-rated', REQ, 'top-rated:Action');
    expect(res.sourceId).toBe('anilist');
    expect(res.fromFallback).toBe(false);
    expect(chain.peekSticky('top-rated:Action')).toBe('anilist');
    expect(chain.peekSticky('trending:Action')).toBe('kitsu');
  });

  it('after the TTL expires the choice is re-made', async () => {
    const { chain, primary, fallback, advance } = setup({ stickyTtlMs: 1000 });
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await chain.fetchPage('trending', REQ, 'trending:Action');
    expect(primary.fetchPageMock).toHaveBeenCalledTimes(1);
    advance(1001);
    expect(chain.peekSticky('trending:Action')).toBeUndefined();
    await chain.fetchPage('trending', REQ, 'trending:Action');
    // Expired entry pruned: the primary is attempted again.
    expect(primary.fetchPageMock).toHaveBeenCalledTimes(2);
  });

  it('peekSticky is undefined for unknown keys and no key means no stickiness', async () => {
    const { chain, primary, fallback } = setup();
    expect(chain.peekSticky('never-seen')).toBeUndefined();
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await chain.fetchPage('trending', REQ);
    expect(chain.peekSticky('trending:Action')).toBeUndefined();
  });

  it('a sticky source with an open breaker is not honoured', async () => {
    const { chain, primary, fallback, breakerMap, advance } = setup({
      stickyTtlMs: 1000,
      threshold: 5,
    });
    primary.fetchPageMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    await chain.fetchPage('trending', REQ, 'trending:Action');
    expect(chain.peekSticky('trending:Action')).toBe('kitsu');
    // Kitsu's breaker opens: the next call must not honour the sticky entry.
    const kitsuBreaker = breakerMap.get('kitsu');
    for (let i = 0; i < 5; i += 1) {
      kitsuBreaker?.recordFailure();
    }
    expect(kitsuBreaker?.canAttempt()).toBe(false);
    advance(10);
    primary.fetchPageMock.mockResolvedValue(page([1], 'anilist', 1));
    const res = await chain.fetchPage('trending', REQ, 'trending:Action');
    expect(res.sourceId).toBe('anilist');
    expect(primary.fetchPageMock).toHaveBeenCalledTimes(2);
  });
});

describe('SourceChain.search', () => {
  it('primary healthy → fromFallback false, zero fallback calls', async () => {
    const { chain, primary, fallback } = setup();
    primary.searchMock.mockResolvedValue(page([1, 2], 'anilist', 2));
    const res = await chain.search('bebop', 0, 20);
    expect(res.sourceId).toBe('anilist');
    expect(res.fromFallback).toBe(false);
    expect(res.items).toHaveLength(2);
    expect(primary.searchMock).toHaveBeenCalledWith('bebop', 0, 20, 4000);
    expect(fallback.searchMock).toHaveBeenCalledTimes(0);
  });

  it('primary 5xx → fallback serves, fromFallback true', async () => {
    const { chain, primary, fallback } = setup();
    primary.searchMock.mockRejectedValue(new SourceError('server_error', 'boom'));
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    const res = await chain.search('bebop', 0, 20);
    expect(res.sourceId).toBe('kitsu');
    expect(res.fromFallback).toBe(true);
    expect(primary.searchMock).toHaveBeenCalledTimes(1);
    expect(fallback.searchMock).toHaveBeenCalledTimes(1);
  });

  it('primary 429 → throws the rate_limited error, fallback spy shows 0 calls', async () => {
    const { chain, primary, fallback } = setup();
    const cause = new SourceError('rate_limited', 'slow down');
    primary.searchMock.mockRejectedValue(cause);
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.search('bebop', 0, 20)).rejects.toBe(cause);
    expect(fallback.searchMock).toHaveBeenCalledTimes(0);
  });

  it('primary 404 → 0 fallback calls, error propagates', async () => {
    const { chain, primary, fallback } = setup();
    const cause = new SourceError('not_found', 'no such page');
    primary.searchMock.mockRejectedValue(cause);
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.search('bebop', 0, 20)).rejects.toBe(cause);
    expect(fallback.searchMock).toHaveBeenCalledTimes(0);
  });

  it('open breaker on the primary → zero network calls to the primary', async () => {
    const { chain, primary, fallback, breakerMap } = setup({ threshold: 1 });
    breakerMap.get('anilist')?.recordFailure();
    expect(breakerMap.get('anilist')?.canAttempt()).toBe(false);
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    const res = await chain.search('bebop', 0, 20);
    expect(res.sourceId).toBe('kitsu');
    expect(res.fromFallback).toBe(true);
    expect(primary.searchMock).toHaveBeenCalledTimes(0);
  });

  it('a slow primary cannot push the total past budgetMs (injected clock)', async () => {
    const { chain, primary, fallback, advance } = setup({ budgetMs: 4000 });
    const cause = new SourceError('server_error', 'slow then down');
    primary.searchMock.mockImplementation(() => {
      advance(5000);
      return Promise.reject(cause);
    });
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    await expect(chain.search('bebop', 0, 20)).rejects.toBe(cause);
    expect(fallback.searchMock).toHaveBeenCalledTimes(0);
  });

  it('a sticky key returns the same source for a second call within the TTL', async () => {
    const { chain, primary, fallback } = setup({ stickyTtlMs: 1000 });
    primary.searchMock.mockRejectedValue(new SourceError('server_error', 'down'));
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    const first = await chain.search('bebop', 0, 20, 'search:bebop');
    expect(first.sourceId).toBe('kitsu');
    expect(chain.peekSticky('search:bebop')).toBe('kitsu');
    const second = await chain.search('bebop', 20, 20, 'search:bebop');
    expect(second.sourceId).toBe('kitsu');
    // The primary is skipped outright on the second call: still one call.
    expect(primary.searchMock).toHaveBeenCalledTimes(1);
    expect(fallback.searchMock).toHaveBeenCalledTimes(2);
  });
});

describe('SourceChain.fetchById', () => {
  it("routes 'anilist:21' to AniList with the numeric id", async () => {
    const { chain, primary, fallback } = setup();
    primary.fetchByIdMock.mockResolvedValue(anime(21, 'anilist'));
    const res = await chain.fetchById('anilist:21');
    expect(res.sourceId).toBe('anilist');
    expect(res.anime?.displayTitle).toBe('Title 21');
    expect(primary.fetchByIdMock).toHaveBeenCalledWith(21, 4000);
    expect(fallback.fetchByIdMock).toHaveBeenCalledTimes(0);
  });

  it("routes 'kitsu:1376' to Kitsu with the numeric id", async () => {
    const { chain, primary, fallback } = setup();
    fallback.fetchByIdMock.mockResolvedValue(anime(1376, 'kitsu'));
    const res = await chain.fetchById('kitsu:1376');
    expect(res.sourceId).toBe('kitsu');
    expect(res.anime?.displayTitle).toBe('Title 1376');
    expect(fallback.fetchByIdMock).toHaveBeenCalledWith(1376, 4000);
    expect(primary.fetchByIdMock).toHaveBeenCalledTimes(0);
  });

  it('passes null through without falling back to the other source', async () => {
    const { chain, primary, fallback } = setup();
    primary.fetchByIdMock.mockResolvedValue(null);
    const res = await chain.fetchById('anilist:999999');
    expect(res).toEqual({ anime: null, sourceId: 'anilist' });
    expect(fallback.fetchByIdMock).toHaveBeenCalledTimes(0);
  });

  it('propagates a not_found without cross-source fallback', async () => {
    const { chain, primary, fallback } = setup();
    const cause = new SourceError('not_found', 'no such title');
    primary.fetchByIdMock.mockRejectedValue(cause);
    await expect(chain.fetchById('anilist:999999')).rejects.toBe(cause);
    expect(fallback.fetchByIdMock).toHaveBeenCalledTimes(0);
  });

  it('rejects an unknown namespace as invalid_request', async () => {
    const { chain, primary, fallback } = setup();
    const err = await chain.fetchById('jikan:21').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe('invalid_request');
    expect(primary.fetchByIdMock).toHaveBeenCalledTimes(0);
    expect(fallback.fetchByIdMock).toHaveBeenCalledTimes(0);
  });

  it.each(['anilist', 'anilist:', 'anilist:abc', 'kitsu:12x'])(
    'rejects malformed id %j as invalid_request',
    async (id) => {
      const { chain, primary, fallback } = setup();
      const err = await chain.fetchById(id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect((err as SourceError).kind).toBe('invalid_request');
      expect(primary.fetchByIdMock).toHaveBeenCalledTimes(0);
      expect(fallback.fetchByIdMock).toHaveBeenCalledTimes(0);
    },
  );

  it('an open breaker on the routed source fails without a network call', async () => {
    const { chain, primary, breakerMap } = setup({ threshold: 1 });
    breakerMap.get('anilist')?.recordFailure();
    const err = await chain.fetchById('anilist:21').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(primary.fetchByIdMock).toHaveBeenCalledTimes(0);
  });
});

describe('SourceChain slow-timeout fallback', () => {
  // Finding 1 regression: the primary dies by TIMEOUT (not an instant throw),
  // consuming its whole per-attempt window, and the fallback must still serve
  // with the total inside the chain budget. With budget == per-attempt timeout
  // (the old equality) the chain gives up here and this test fails.
  const PRIMARY_TIMEOUT_MS = 200;
  const BUDGET_MS = 400;

  function timeoutPrimary(): {
    fetchPage: (req: PageRequest) => Promise<SourcePage>;
    search: (term: string, skip: number, limit: number, timeoutMs?: number) => Promise<SourcePage>;
    fetchById: (id: number, timeoutMs?: number) => Promise<Anime | null>;
  } {
    const slowDeath = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new SourceError('timeout', `timed out after ${PRIMARY_TIMEOUT_MS}ms`)),
          PRIMARY_TIMEOUT_MS,
        );
      });
    return {
      fetchPage: () => slowDeath(),
      search: () => slowDeath(),
      fetchById: () => slowDeath(),
    };
  }

  function chainOver(primary: AnimeSource): { chain: SourceChain; fallback: FakeSource } {
    const fallback = fakeSource('kitsu');
    const chain = new SourceChain({
      sources: [primary, fallback],
      breakers: breakers(Date.now, 5),
      budgetMs: BUDGET_MS,
      now: Date.now,
    });
    return { chain, fallback };
  }

  it('a primary that times out still falls through to Kitsu inside the budget', async () => {
    const slow = timeoutPrimary();
    const seenPrimary: PageRequest[] = [];
    const primary: AnimeSource = {
      id: 'anilist',
      fetchPage: (req: PageRequest) => {
        seenPrimary.push(req);
        return slow.fetchPage(req);
      },
      ...{ search: slow.search, fetchById: slow.fetchById },
    };
    const { chain, fallback } = chainOver(primary);
    fallback.fetchPageMock.mockResolvedValue(page([9], 'kitsu', 1));
    const started = Date.now();
    const res = await chain.fetchPage('trending', REQ);
    const elapsed = Date.now() - started;
    expect(res.sourceId).toBe('kitsu');
    expect(res.fromFallback).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    // The chain threaded the remaining budget into each attempt: the primary
    // got the full budget and the fallback got what was left after the
    // primary's 200 ms timeout death.
    expect(seenPrimary).toHaveLength(1);
    expect(seenPrimary[0]?.timeoutMs).toBe(BUDGET_MS);
    const fallbackTimeout = fallback.fetchPageMock.mock.calls[0]?.[0]?.timeoutMs;
    expect(typeof fallbackTimeout).toBe('number');
    expect(fallbackTimeout as number).toBeGreaterThan(0);
    expect(fallbackTimeout as number).toBeLessThan(BUDGET_MS);
  });

  it('search threads the remaining budget to each attempt', async () => {
    const slow = timeoutPrimary();
    const primary: AnimeSource = { id: 'anilist', ...slow };
    const { chain, fallback } = chainOver(primary);
    fallback.searchMock.mockResolvedValue(page([9], 'kitsu', 1));
    const res = await chain.search('bebop', 0, 20);
    expect(res.sourceId).toBe('kitsu');
    const seen = fallback.searchMock.mock.calls[0]?.[3];
    expect(typeof seen).toBe('number');
    expect(seen as number).toBeGreaterThan(0);
    expect(seen as number).toBeLessThan(BUDGET_MS);
  });

  it('fetchPage threads the remaining budget to each attempt', async () => {
    const { chain, primary, fallback } = setup({ budgetMs: 4000 });
    primary.fetchPageMock.mockResolvedValue(page([1], 'anilist', 1));
    await chain.fetchPage('trending', REQ);
    // Untouched by wall-clock time on the injected clock: the full budget.
    expect(primary.fetchPageMock.mock.calls[0]?.[0]?.timeoutMs).toBe(4000);
    expect(fallback.fetchPageMock).toHaveBeenCalledTimes(0);
  });

  it('fetchById threads the remaining budget to the routed source', async () => {
    const { chain, primary } = setup({ budgetMs: 4000 });
    primary.fetchByIdMock.mockResolvedValue(anime(21, 'anilist'));
    await chain.fetchById('anilist:21');
    expect(primary.fetchByIdMock.mock.calls[0]?.[1]).toBe(4000);
  });
});

describe('chainBudgetForHttpTimeout', () => {
  it('adds one fallback window and caps below Nuvio 5000 ms budget', () => {
    // Default 3500 -> 4000 (1000 ms headroom); max 4000 -> 4500 (500 ms headroom).
    expect(chainBudgetForHttpTimeout(3500)).toBe(4000);
    expect(chainBudgetForHttpTimeout(4000)).toBe(4500);
    // An operator value above the config clamp still never reaches 5000.
    expect(chainBudgetForHttpTimeout(10000)).toBe(4500);
    // Strictly exceeds the per-attempt timeout, so a timeout death leaves room.
    for (const httpTimeoutMs of [100, 1000, 3500, 4000]) {
      const budget = chainBudgetForHttpTimeout(httpTimeoutMs);
      expect(budget).toBeGreaterThan(httpTimeoutMs);
      expect(budget).toBeLessThan(5000);
    }
  });
});
