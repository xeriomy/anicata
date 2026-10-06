import { CATALOG_DEFS, PAGE_SIZE, ANILIST_PER_PAGE } from '../sources/catalog-def.js';
import type { AniListPageQuery, CatalogDefinition } from '../sources/catalog-def.js';
import type { Anime } from '../domain/anime.js';
import type { TTLCache } from '../cache/store.js';
import type { Logger } from '../util/logger.js';

export interface AnimeSource {
  fetchCatalogPage(q: AniListPageQuery): Promise<{ items: Anime[]; total: number }>;
  search(term: string, page: number): Promise<{ items: Anime[]; total: number }>;
}

export const CATALOG_TTL_MS = 15 * 60 * 1000;
export const CATALOG_STALE_MS = 6 * 60 * 60 * 1000;
export const SEARCH_TTL_MS = 30 * 60 * 1000;

export interface CatalogPageResult {
  items: Anime[];
  cacheMaxAge: number;
  freshness: 'fresh' | 'stale';
}

export interface CatalogServiceDeps {
  source: AnimeSource;
  cache: TTLCache;
  log?: Logger;
}

function coerceSkip(skip: number): number {
  if (!Number.isFinite(skip) || skip < 0) {
    return 0;
  }
  return Math.floor(skip);
}

export class CatalogService {
  private readonly source: AnimeSource;
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
      const key = `catalog:${args.catalogId}:${genre ?? ''}:${skip}`;
      const base = def.buildQuery(skip);
      const loader = async (): Promise<{ items: Anime[]; total: number }> => {
        const collected: Anime[] = [];
        let total = 0;
        let page = Math.floor(skip / ANILIST_PER_PAGE) + 1;
        let offset = skip % ANILIST_PER_PAGE;
        while (collected.length < PAGE_SIZE) {
          const q: AniListPageQuery = { ...base, page };
          if (genre !== undefined) {
            q.genre = genre;
          }
          const res = await this.source.fetchCatalogPage(q);
          total = res.total;
          collected.push(...(offset > 0 ? res.items.slice(offset) : res.items));
          offset = 0;
          if (res.items.length < ANILIST_PER_PAGE) {
            break;
          }
          page += 1;
        }
        return { items: collected.slice(0, PAGE_SIZE), total };
      };
      const { value, freshness } = await this.cache.wrap(
        key,
        { ttlMs: CATALOG_TTL_MS, staleMs: CATALOG_STALE_MS },
        loader,
      );
      if (value.items.length === 0) {
        return { items: value.items, cacheMaxAge: 60, freshness };
      }
      return { items: value.items, cacheMaxAge: freshness === 'stale' ? 30 : 900, freshness };
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
      const page = Math.floor(skip / ANILIST_PER_PAGE) + 1;
      const key = `search:${term}:${skip}`;
      const { value, freshness } = await this.cache.wrap(
        key,
        { ttlMs: SEARCH_TTL_MS, staleMs: CATALOG_STALE_MS },
        async () => this.source.search(term, page),
      );
      if (value.items.length === 0) {
        return { items: value.items, cacheMaxAge: 60, freshness };
      }
      return { items: value.items, cacheMaxAge: freshness === 'stale' ? 30 : 1800, freshness };
    } catch (err) {
      this.log?.error('catalog search failed', { err });
      return { items: [], cacheMaxAge: 10, freshness: 'fresh' };
    }
  }
}
