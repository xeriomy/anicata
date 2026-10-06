import type { Anime } from '../domain/anime.js';
import type { TTLCache } from '../cache/store.js';
import type { Logger } from '../util/logger.js';

export const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const META_STALE_MS = 30 * 24 * 60 * 60 * 1000;

const NULL_TTL_MS = 60 * 1000;
const NULL_CACHE_MAX_AGE = 60;
const STALE_CACHE_MAX_AGE = 30;
const FAILURE_CACHE_MAX_AGE = 10;

export interface MetaResult {
  anime: Anime | null;
  cacheMaxAge: number;
  freshness: 'fresh' | 'stale';
}

export interface MetaServiceDeps {
  source: { fetchById(id: number): Promise<Anime | null> };
  cache: TTLCache;
  log?: Logger;
}

export class MetaService {
  private readonly source: { fetchById(id: number): Promise<Anime | null> };
  private readonly cache: TTLCache;
  private readonly log: Logger | undefined;

  constructor(deps: MetaServiceDeps) {
    this.source = deps.source;
    this.cache = deps.cache;
    this.log = deps.log;
  }

  async getByAnilistId(id: number): Promise<MetaResult> {
    try {
      if (!Number.isInteger(id) || id <= 0) {
        return { anime: null, cacheMaxAge: FAILURE_CACHE_MAX_AGE, freshness: 'fresh' };
      }
      const key = `meta:anilist:${id}`;
      const hit = this.cache.get<Anime | null>(key);
      if (hit !== undefined && hit.freshness === 'fresh' && hit.value !== null) {
        return { anime: hit.value, cacheMaxAge: META_TTL_MS / 1000, freshness: 'fresh' };
      }
      try {
        const anime = await this.source.fetchById(id);
        if (anime === null) {
          this.cache.set<Anime | null>(key, null, { ttlMs: NULL_TTL_MS, staleMs: 0 });
          return { anime: null, cacheMaxAge: NULL_CACHE_MAX_AGE, freshness: 'fresh' };
        }
        this.cache.set(key, anime, { ttlMs: META_TTL_MS, staleMs: META_STALE_MS });
        return { anime, cacheMaxAge: META_TTL_MS / 1000, freshness: 'fresh' };
      } catch (err) {
        const cached = this.cache.get<Anime | null>(key);
        if (cached !== undefined && cached.value !== null) {
          return { anime: cached.value, cacheMaxAge: STALE_CACHE_MAX_AGE, freshness: 'stale' };
        }
        this.log?.error('meta fetch failed', { id, err });
        return { anime: null, cacheMaxAge: FAILURE_CACHE_MAX_AGE, freshness: 'fresh' };
      }
    } catch (err) {
      this.log?.error('meta fetch failed', { err });
      return { anime: null, cacheMaxAge: FAILURE_CACHE_MAX_AGE, freshness: 'fresh' };
    }
  }
}
