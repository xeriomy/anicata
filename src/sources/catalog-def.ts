// Phase 1 catalogue definitions: Nuvio catalogue id -> AniList page query.
// The two-page stitching (PAGE_SIZE = 2 x ANILIST_PER_PAGE) happens in the
// service layer; buildQuery returns a single upstream page query.

export const PAGE_SIZE = 100; // Nuvio CATALOG_PAGE_SIZE
export const ANILIST_PER_PAGE = 50; // AniList silently clamps perPage to 50

export type CatalogId = 'anime-trending' | 'anime-top-rated' | 'anime-search';

export interface AniListPageQuery {
  sort: string[];
  search?: string;
  genre?: string;
  page: number;
  perPage: number;
}

export interface CatalogDefinition {
  id: CatalogId;
  type: 'anime';
  name: string;
  supportsSearch: boolean;
  buildQuery(skip: number, search?: string): AniListPageQuery;
}

function pageFor(skip: number): number {
  // Nuvio always sends skip as a multiple of PAGE_SIZE, so this is exact.
  return Math.floor(skip / ANILIST_PER_PAGE) + 1;
}

export const CATALOG_DEFS: Record<CatalogId, CatalogDefinition> = {
  'anime-trending': {
    id: 'anime-trending',
    type: 'anime',
    name: 'Trending Anime',
    supportsSearch: false,
    buildQuery(skip: number): AniListPageQuery {
      return { sort: ['TRENDING_DESC'], page: pageFor(skip), perPage: ANILIST_PER_PAGE };
    },
  },
  'anime-top-rated': {
    id: 'anime-top-rated',
    type: 'anime',
    name: 'Top Rated Anime',
    supportsSearch: false,
    buildQuery(skip: number): AniListPageQuery {
      return { sort: ['SCORE_DESC'], page: pageFor(skip), perPage: ANILIST_PER_PAGE };
    },
  },
  'anime-search': {
    id: 'anime-search',
    type: 'anime',
    name: 'Search Anime',
    supportsSearch: true,
    buildQuery(skip: number, search?: string): AniListPageQuery {
      const base = { sort: ['SEARCH_MATCH'], page: pageFor(skip), perPage: ANILIST_PER_PAGE };
      return search === undefined ? base : { ...base, search };
    },
  },
};
