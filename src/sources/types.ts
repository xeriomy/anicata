import type { Anime } from '../domain/anime.js';

export type SourceId = 'anilist' | 'kitsu';
export type SortKey = 'trending' | 'top_rated' | 'search_match';

export interface PageRequest {
  catalogId: string;
  skip: number; // items to skip, source-agnostic
  limit: number; // max items wanted
  genre?: string;
  /**
   * Per-attempt wall-clock bound in ms, set by the chain from the shared
   * deadline's remaining budget. Adapters forward it to their HTTP call so a
   * slow primary times out with room left for the fallback. Absent when the
   * caller runs outside a chain (adapter unit tests, live probes).
   */
  timeoutMs?: number;
}

export interface SourcePage {
  items: Anime[];
  total: number;
}

export interface AnimeSource {
  readonly id: SourceId;
  fetchPage(req: PageRequest): Promise<SourcePage>;
  search(term: string, skip: number, limit: number, timeoutMs?: number): Promise<SourcePage>;
  /**
   * Numeric, not string: both id namespaces are integers (AniList `21`, Kitsu
   * `1376`), and `AniListSource.fetchById` already takes a number. The namespace
   * is the chain's concern, not the adapter's.
   */
  fetchById(id: number, timeoutMs?: number): Promise<Anime | null>;
}
