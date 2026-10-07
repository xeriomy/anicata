export type AnimeFormat =
  'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC' | 'OTHER';

export type AnimeStatus =
  'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS' | 'UNKNOWN';

export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export type AnimeIdentity =
  | { anilist: number; kitsu?: never; mal?: number }
  | { kitsu: number; anilist?: never; mal?: number };

export interface AnimeTitle {
  romaji?: string;
  english?: string;
  native?: string;
  synonyms: string[];
}

export interface AnimeImages {
  poster?: string;
  background?: string;
}

export interface Tag {
  id: number;
  name: string;
  rank: number;
  category: string;
}

export interface Studio {
  id: number;
  name: string;
  isMain: boolean;
}

export interface Relation {
  id: number;
  relationType: string;
  title: string;
  format?: AnimeFormat;
  type: string;
}

export interface AiringInfo {
  nextEpisode?: number;
  nextAiringAt?: number;
}

export interface Anime {
  identity: AnimeIdentity;
  title: AnimeTitle;
  displayTitle: string;
  description?: string;
  format: AnimeFormat;
  status: AnimeStatus;
  type: 'anime' | 'movie';
  episodes?: number;
  durationMinutes?: number;
  releaseDate?: string;
  releaseYear?: number;
  season?: Season;
  seasonYear?: number;
  genres: string[];
  tags: Tag[];
  studios: Studio[];
  relations: Relation[];
  images: AnimeImages;
  scoreAnilist?: number;
  airing?: AiringInfo;
  siteUrl?: string;
  hashtags: string[];
  countryOfOrigin?: string;
}

export function stremioIdFor(identity: AnimeIdentity): string {
  if (identity.anilist !== undefined) {
    return `anilist:${identity.anilist}`;
  }
  return `kitsu:${identity.kitsu}`;
}
