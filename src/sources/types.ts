import type { Anime } from '../domain/anime.js';

export type SourceId = 'anilist' | 'kitsu';
export type SortKey = 'trending' | 'top_rated' | 'search_match';

export interface PageRequest {
  catalogId: string;
  skip: number; // items to skip, source-agnostic
  limit: number; // max items wanted
  genre?: string;
}

export interface SourcePage {
  items: Anime[];
  total: number;
}

export interface AnimeSource {
  readonly id: SourceId;
  fetchPage(req: PageRequest): Promise<SourcePage>;
  search(term: string, skip: number, limit: number): Promise<SourcePage>;
  /**
   * Numeric, not string: both id namespaces are integers (AniList `21`, Kitsu
   * `1376`), and `AniListSource.fetchById` already takes a number. The namespace
   * is the chain's concern, not the adapter's.
   */
  fetchById(id: number): Promise<Anime | null>;
}
