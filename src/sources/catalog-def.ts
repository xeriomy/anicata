// Catalogue registry: Nuvio catalogue id -> catalogue metadata. Pagination
// and sort vocabulary live in each source adapter (a Nuvio page costs two
// AniList requests of ANILIST_PER_PAGE); this file only describes the
// catalogues Nuvio may request.

export const PAGE_SIZE = 100; // Nuvio CATALOG_PAGE_SIZE
export const ANILIST_PER_PAGE = 50; // AniList silently clamps perPage to 50

export type CatalogId = 'anime-trending' | 'anime-top-rated' | 'anime-search';

export interface CatalogDefinition {
  id: CatalogId;
  type: 'anime';
  name: string;
  supportsSearch: boolean;
}

export const CATALOG_DEFS: Record<CatalogId, CatalogDefinition> = {
  'anime-trending': {
    id: 'anime-trending',
    type: 'anime',
    name: 'Trending Anime',
    supportsSearch: false,
  },
  'anime-top-rated': {
    id: 'anime-top-rated',
    type: 'anime',
    name: 'Top Rated Anime',
    supportsSearch: false,
  },
  'anime-search': {
    id: 'anime-search',
    type: 'anime',
    name: 'Search Anime',
    supportsSearch: true,
  },
};
