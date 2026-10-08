// TypeScript interfaces describing AniList's GraphQL response shapes.
// Shapes were pinned against live responses recorded in test/fixtures/.
// Rule: any field AniList can return `null` for is `| null`; only
// `AniListMedia.id` is non-nullable `number` (per introspection).

export interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

export interface AniListCover {
  extraLarge: string | null;
  large: string | null;
  medium: string | null;
  color: string | null;
}

export interface AniListFuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface AniListNextEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring: number;
}

export interface AniListTag {
  id: number;
  name: string;
  rank: number;
  category: string | null;
  isMediaSpoiler: boolean | null;
  isAdult: boolean | null;
}

export interface AniListStudioEdge {
  isMain: boolean;
  node: { id: number; name: string };
}

export interface AniListRelationEdge {
  relationType: string;
  node: {
    id: number;
    type: string;
    title: AniListTitle;
    format: string | null;
    status: string | null;
  };
}

export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: AniListTitle;
  synonyms: string[] | null;
  description: string | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  favourites: number | null;
  isAdult: boolean | null;
  source: string | null;
  countryOfOrigin: string | null;
  hashtag: string | null;
  startDate: AniListFuzzyDate | null;
  endDate: AniListFuzzyDate;
  season: string | null;
  seasonYear: number | null;
  coverImage: AniListCover;
  bannerImage: string | null;
  genres: string[] | null;
  tags: AniListTag[] | null;
  studios: { edges: AniListStudioEdge[] | null } | null;
  relations: { edges: AniListRelationEdge[] | null } | null;
  nextAiringEpisode: AniListNextEpisode | null;
  siteUrl: string | null;
}

export interface AniListPage<T> {
  pageInfo: {
    total: number;
    currentPage: number;
    lastPage: number;
    hasNextPage: boolean;
    perPage: number;
  };
  media: T[];
}

export interface AniListGraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string; status: number }>;
}
