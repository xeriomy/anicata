// Catalogue registry: Nuvio catalogue id -> catalogue metadata. Pagination
// and sort vocabulary live in each source adapter (a Nuvio page costs two
// AniList requests of ANILIST_PER_PAGE); this file only describes the
// catalogues Nuvio may request.

export const PAGE_SIZE = 100; // Nuvio CATALOG_PAGE_SIZE
export const ANILIST_PER_PAGE = 50; // AniList silently clamps perPage to 50

export type Season = 'winter' | 'spring' | 'summer' | 'fall';

/**
 * The 14 catalogues with a fixed id. `anime-seasonal-<year>-<season>` is
 * deliberately absent: its id is generated from the wall clock so the season
 * travels in the cache key (Phase 5 spec §5), and it resolves through
 * `catalogDefFor`.
 */
export type FixedCatalogId =
  | 'anime-trending'
  | 'anime-top-rated'
  | 'anime-search'
  | 'anime-popular'
  | 'anime-airing'
  | 'anime-upcoming'
  | 'anime-recent'
  | 'anime-movies'
  | 'anime-ova'
  | 'anime-genres'
  | 'anime-top-genres'
  | 'movie-trending'
  | 'movie-top-rated'
  | 'movie-search';

export const SEASONAL_ID_PREFIX = 'anime-seasonal';
/** Matches `anime-seasonal-2026-fall`. */
const SEASONAL_ID_RE = /^anime-seasonal-(\d{4})-(winter|spring|summer|fall)$/;

export type CatalogId = FixedCatalogId | `anime-seasonal-${number}-${Season}`;

export interface CatalogDefinition {
  id: CatalogId;
  type: 'anime' | 'movie';
  name: string;
  /** True when Nuvio may request this catalogue for a search term. */
  supportsSearch: boolean;
  /**
   * True when `supportsSearch` must carry `isRequired: true`, which is what
   * keeps the catalogue off the Home/Board. Without it the client also treats
   * the catalogue as a feed and publishes a "Search …" row that returns an
   * unfiltered page until a query is typed.
   */
  searchRequired?: boolean;
  /** True when Nuvio may request this catalogue with a `genre` filter. */
  supportsGenre?: boolean;
}

/**
 * The current season pair for a moment in time, as AniList spells them.
 *
 * AniList's `season` is capitalised (`WINTER`) while `seasonYear` is a number.
 * The calendar is UTC so a deploy timezone cannot shift the boundary.
 */
export function currentSeason(date = new Date()): { season: Season; year: number } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-based
  if (month <= 1) return { season: 'winter', year };
  if (month <= 4) return { season: 'spring', year };
  if (month <= 7) return { season: 'summer', year };
  if (month <= 10) return { season: 'fall', year };
  return { season: 'winter', year: year + 1 };
}

/**
 * The seasonal catalogue id for a moment in time.
 *
 * Generated rather than fixed because the season must live in the CACHE KEY: a
 * stable `anime-seasonal` id with a clock-dependent query would keep serving
 * the previous season from cache for a quarter of a year after the boundary.
 */
export function seasonalCatalogId(date = new Date()): CatalogId {
  const { season, year } = currentSeason(date);
  return `${SEASONAL_ID_PREFIX}-${year}-${season}`;
}

/**
 * Every fixed catalogue. Seasonal entries are not here — see
 * `seasonalCatalogId` and `catalogDefFor`.
 */
export const CATALOG_DEFS: Record<FixedCatalogId, CatalogDefinition> = {
  'anime-trending': { id: 'anime-trending', type: 'anime', name: 'Trending Anime', supportsSearch: false },
  'anime-top-rated': { id: 'anime-top-rated', type: 'anime', name: 'Top Rated Anime', supportsSearch: false },
  'anime-search': { id: 'anime-search', type: 'anime', name: 'Search Anime', supportsSearch: true, searchRequired: true },
  'anime-popular': { id: 'anime-popular', type: 'anime', name: 'Popular Anime', supportsSearch: false },
  'anime-airing': { id: 'anime-airing', type: 'anime', name: 'Airing Now', supportsSearch: false },
  'anime-upcoming': { id: 'anime-upcoming', type: 'anime', name: 'Upcoming Anime', supportsSearch: false },
  'anime-recent': { id: 'anime-recent', type: 'anime', name: 'Recently Aired', supportsSearch: false },
  'anime-movies': { id: 'anime-movies', type: 'anime', name: 'Anime Movies', supportsSearch: false },
  'anime-ova': { id: 'anime-ova', type: 'anime', name: 'OVAs & ONAs', supportsSearch: false },
  'anime-genres': {
    id: 'anime-genres',
    type: 'anime',
    name: 'Browse by Genre',
    supportsSearch: false,
    supportsGenre: true,
  },
  'anime-top-genres': {
    id: 'anime-top-genres',
    type: 'anime',
    name: 'Top Rated by Genre',
    supportsSearch: false,
    supportsGenre: true,
  },
  // `type: movie` catalogues. Nuvio routes on /catalog/{type}/{id}, so a
  // catalogue cannot be shared across the two types — which is why the two
  // movie rows are their own ids rather than an `anime-movies` variant.
  'movie-trending': { id: 'movie-trending', type: 'movie', name: 'Trending Anime Movies', supportsSearch: false },
  'movie-top-rated': { id: 'movie-top-rated', type: 'movie', name: 'Top Rated Anime Movies', supportsSearch: false },
  'movie-search': { id: 'movie-search', type: 'movie', name: 'Search Anime Movies', supportsSearch: true, searchRequired: true },
};

/**
 * Resolves any catalogue id — including a seasonal one — to its definition, or
 * `undefined` when the id is not ours.
 *
 * This is the single lookup the manifest, the catalogue service and the
 * adapters all use, so a generated seasonal id cannot be accepted by one layer
 * and rejected by another.
 */
export function catalogDefFor(id: string): CatalogDefinition | undefined {
  const fixed = CATALOG_DEFS[id as FixedCatalogId];
  if (fixed !== undefined) return fixed;
  const seasonal = parseSeasonalCatalogId(id);
  if (seasonal === undefined) return undefined;
  return { id: id as CatalogId, type: 'anime', name: `${capitalise(seasonal.season)} ${seasonal.year} Anime`, supportsSearch: false };
}

/**
 * Parses `anime-seasonal-<year>-<season>` into its season pair, or `undefined`
 * when the id is not a parsable seasonal id.
 *
 * The exported seam for the AniList adapter's season/seasonYear descriptor
 * fields (Phase 5 Task 2): the regex stays private here, and the caller
 * uppercases the `Season` to AniList's spelling.
 */
export function parseSeasonalCatalogId(id: string): { season: Season; year: number } | undefined {
  const match = SEASONAL_ID_RE.exec(id);
  if (match === null) return undefined;
  // The regex has already established the shape, so this is the one place the
  // runtime match is narrowed to the `Season` type.
  return { season: match[2] as Season, year: Number(match[1]) };
}

/**
 * The 18 genres offered to Nuvio's genre picker.
 *
 * AniList's `genre` filter is an exact, case-insensitive match, not a
 * substring, so a genre string AniList does not know returns an empty page —
 * a 200 that silently shows nothing. This list is therefore the *captured*
 * `GenreCollection`, curated rather than written from memory: AniList's real
 * vocabulary minus adult content, which `behaviorHints.adult: false` already
 * declares we do not carry (test/fixtures/anilist-genres.json).
 *
 * 19 known genres minus Hentai is exactly the 18 the roadmap specifies.
 */
export const GENRE_OPTIONS: readonly string[] = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Horror',
  'Mahou Shoujo',
  'Mecha',
  'Music',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
