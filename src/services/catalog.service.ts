import { CATALOG_DEFS, PAGE_SIZE } from '../sources/catalog-def.js';
import type { CatalogDefinition } from '../sources/catalog-def.js';
import type { PageRequest, SourceId } from '../sources/types.js';
import type { SourceChain } from '../sources/chain.js';
import type { Anime } from '../domain/anime.js';
import type { TTLCache } from '../cache/store.js';
import type { Logger } from '../util/logger.js';

export const CATALOG_TTL_MS = 15 * 60 * 1000;
export const CATALOG_STALE_MS = 6 * 60 * 60 * 1000;
export const SEARCH_TTL_MS = 30 * 60 * 1000;

export interface CatalogPageResult {
  items: Anime[];
  cacheMaxAge: number;
  freshness: 'fresh' | 'stale';
}

export interface CatalogServiceDeps {
  source: SourceChain;
  cache: TTLCache;
  log?: Logger;
}

export function catalogCacheKey(
  sourceId: SourceId,
  catalogId: string,
  genre: string | undefined,
  skip: number,
): string {
  return `catalog:${sourceId}:${catalogId}:${genre ?? ''}:${skip}`;
}

export function searchCacheKey(sourceId: SourceId, term: string, skip: number): string {
  return `search:${sourceId}:${term}:${skip}`;
}

/**
 * What the cache holds. The `sourceId` travels with the page because the key
 * itself is built from it: the key can only be computed after the chain
 * reports which source served, so the loader's value must carry it out to the
 * key-building site.
 */
interface CachedPage {
  items: Anime[];
  total: number;
  sourceId: SourceId;
}

function coerceSkip(skip: number): number {
  if (!Number.isFinite(skip) || skip < 0) {
    return 0;
  }
  return Math.floor(skip);
}

/**
 * In-flight rendezvous keys. Deliberately source-agnostic and distinct from the
 * cache keys: nothing is ever stored under one (see `TTLCache.dedupe`), so two
 * concurrent callers share a flight no matter which source ends up serving.
 */
function catalogRendezvous(catalogId: string, genre: string | undefined, skip: number): string {
  return `catalog-req:${catalogId}:${genre ?? ''}:${skip}`;
}

function searchRendezvous(term: string, skip: number): string {
  return `search-req:${term}:${skip}`;
}

export class CatalogService {
  private readonly source: SourceChain;
  private readonly cache: TTLCache;
  private readonly log: Logger | undefined;

  constructor(deps: CatalogServiceDeps) {
    this.source = deps.source;
    this.cache = deps.cache;
    this.log = deps.log;
  }

  async getCatalogPage(args: {
    catalogId: string;
    type: string;
    genre?: string;
    skip: number;
  }): Promise<CatalogPageResult> {
    try {
      const def = (CATALOG_DEFS as Record<string, CatalogDefinition | undefined>)[args.catalogId];
      if (def === undefined || def.type !== args.type) {
        return { items: [], cacheMaxAge: 60, freshness: 'fresh' };
      }
      const skip = coerceSkip(args.skip);
      const genre = args.genre;
      // The caller owns its stickiness scope: one entry per catalogue+genre so
      // a mid-scroll fallback sticks for the rest of the scroll. Always passed
      // explicitly — an omitted key would silently disable stickiness.
      const stickyKey = `${args.catalogId}:${genre ?? ''}`;
      const req: PageRequest = { catalogId: args.catalogId, skip, limit: PAGE_SIZE };
      if (genre !== undefined) {
        req.genre = genre;
      }
      // The serving source is only known after the fetch, so consult the cache
      // under the sticky-predicted source; on a cold key (or a misprediction)
      // fetch first, then store under the source that actually served.
      //
      // KNOWN LIMITATION (availability, not correctness): the cold path never
      // consults the cache — there is no "try every source's key" lookup (that
      // was considered and deliberately deferred). So after a container
      // restart, or once the sticky entry lapses, both-sources-down plus a
      // warm cache under the other source's key still yields degraded-empty
      // rather than stale. The response is still HTTP 200; do not assume a
      // warm cache implies a stale serve on this path.
      const predicted = this.source.peekSticky(stickyKey);
      if (predicted !== undefined) {
        const hit = this.cache.get<CachedPage>(catalogCacheKey(predicted, args.catalogId, genre, skip));
        if (hit !== undefined) {
          if (hit.freshness === 'fresh') {
            return this.toResult(hit.value, 'fresh');
          }
          this.refreshCatalog(stickyKey, args.catalogId, req, genre, skip);
          return this.toResult(hit.value, 'stale');
        }
      }
      const value = await this.cache.dedupe(
        catalogRendezvous(args.catalogId, genre, skip),
        () => this.fetchAndStoreCatalog(stickyKey, args.catalogId, req, genre, skip),
      );
      return this.toResult(value, 'fresh');
    } catch (err) {
      this.log?.error('catalog page failed', { catalogId: args?.catalogId, err });
      return { items: [], cacheMaxAge: 10, freshness: 'fresh' };
    }
  }

  async search(args: { term: string; skip: number }): Promise<CatalogPageResult> {
    try {
      const trimmed = args.term.trim();
      if (trimmed === '') {
        return { items: [], cacheMaxAge: 60, freshness: 'fresh' };
      }
      const term = trimmed.slice(0, 200);
      const skip = coerceSkip(args.skip);
      const stickyKey = `search:${term}`;
      const predicted = this.source.peekSticky(stickyKey);
      if (predicted !== undefined) {
        const hit = this.cache.get<CachedPage>(searchCacheKey(predicted, term, skip));
        if (hit !== undefined) {
          if (hit.freshness === 'fresh') {
            return this.toSearchResult(hit.value, 'fresh');
          }
          this.refreshSearch(stickyKey, term, skip);
          return this.toSearchResult(hit.value, 'stale');
        }
      }
      const value = await this.cache.dedupe(searchRendezvous(term, skip), () =>
        this.fetchAndStoreSearch(stickyKey, term, skip),
      );
      return this.toSearchResult(value, 'fresh');
    } catch (err) {
      this.log?.error('catalog search failed', { err });
      return { items: [], cacheMaxAge: 10, freshness: 'fresh' };
    }
  }

  private toResult(value: CachedPage, freshness: 'fresh' | 'stale'): CatalogPageResult {
    if (value.items.length === 0) {
      return { items: value.items, cacheMaxAge: 60, freshness };
    }
    return { items: value.items, cacheMaxAge: freshness === 'stale' ? 30 : 900, freshness };
  }

  private toSearchResult(value: CachedPage, freshness: 'fresh' | 'stale'): CatalogPageResult {
    if (value.items.length === 0) {
      return { items: value.items, cacheMaxAge: 60, freshness };
    }
    return { items: value.items, cacheMaxAge: freshness === 'stale' ? 30 : 1800, freshness };
  }

  /**
   * Fetches through the chain and stores under the source that actually
   * served. Shared by the cold path and the stale background refresh so a
   * refresh heals a mispredicted entry instead of re-polluting the predicted one.
   */
  private async fetchAndStoreCatalog(
    stickyKey: string,
    catalogId: string,
    req: PageRequest,
    genre: string | undefined,
    skip: number,
  ): Promise<CachedPage> {
    const res = await this.source.fetchPage(catalogId, req, stickyKey);
    const value: CachedPage = {
      items: res.items.slice(0, PAGE_SIZE),
      total: res.total,
      sourceId: res.sourceId,
    };
    this.cache.set<CachedPage>(
      catalogCacheKey(res.sourceId, catalogId, genre, skip),
      value,
      { ttlMs: CATALOG_TTL_MS, staleMs: CATALOG_STALE_MS },
    );
    return value;
  }

  private async fetchAndStoreSearch(
    stickyKey: string,
    term: string,
    skip: number,
  ): Promise<CachedPage> {
    const res = await this.source.search(term, skip, PAGE_SIZE, stickyKey);
    const value: CachedPage = { items: res.items, total: res.total, sourceId: res.sourceId };
    this.cache.set<CachedPage>(searchCacheKey(res.sourceId, term, skip), value, {
      ttlMs: SEARCH_TTL_MS,
      staleMs: CATALOG_STALE_MS,
    });
    return value;
  }

  /**
   * Stale-while-revalidate: the stale page was already served; this only
   * replaces the entry on success and never throws, so a failed refresh
   * simply leaves the stale entry until its stale window expires. Joins the
   * in-flight load when one is already running, so concurrent stale hits cost
   * one refresh, not one each.
   */
  private refreshCatalog(
    stickyKey: string,
    catalogId: string,
    req: PageRequest,
    genre: string | undefined,
    skip: number,
  ): void {
    void this.cache
      .dedupe(catalogRendezvous(catalogId, genre, skip), () =>
        this.fetchAndStoreCatalog(stickyKey, catalogId, req, genre, skip),
      )
      .catch(() => undefined);
  }

  private refreshSearch(stickyKey: string, term: string, skip: number): void {
    void this.cache
      .dedupe(searchRendezvous(term, skip), () => this.fetchAndStoreSearch(stickyKey, term, skip))
      .catch(() => undefined);
  }
}
