export type AnimeFormat =
  'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC' | 'OTHER';

export type AnimeStatus =
  'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS' | 'UNKNOWN';

export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export interface TmdbIds {
  tv?: number;
  movie?: number;
}

// ADR-018 binding seam: namespace/id handling is table-driven from this single
// registry — one row per namespace (prefix, emit eligibility, shape, value
// type), so enabling/disabling namespaces later is a filter over the table,
// not a rewrite. `AnimeIdentity` below is deliberately NOT derived from this
// table via mapped types: deriving the anilist-required-on-emit XOR union from
// a value table is not expressible without casts and would worsen narrowing in
// the emit paths (`stremioIdFor`) under `exactOptionalPropertyTypes` /
// `noUncheckedIndexedAccess`. Explicit union kept for clarity; adding a
// namespace is one registry row + one optional field, and this table is the
// checklist that keeps the two in sync.
export interface IdentityNamespaceDef {
  readonly key:
    | 'anilist'
    | 'mal'
    | 'kitsu'
    | 'anidb'
    | 'tmdb'
    | 'imdb'
    | 'tvdb'
    | 'simkl';
  readonly prefix: string;
  readonly emits: boolean;
  readonly shape: 'scalar' | 'object';
  readonly value: 'number' | 'string';
}

export const IDENTITY_NAMESPACE_REGISTRY: readonly IdentityNamespaceDef[] = [
  { key: 'anilist', prefix: 'anilist:', emits: true, shape: 'scalar', value: 'number' },
  { key: 'kitsu', prefix: 'kitsu:', emits: true, shape: 'scalar', value: 'string' },
  { key: 'mal', prefix: 'mal:', emits: false, shape: 'scalar', value: 'number' },
  { key: 'anidb', prefix: 'anidb:', emits: false, shape: 'scalar', value: 'number' },
  // Object shape: Fribb `{tv, movie}` form; bare upstream strings fold into it.
  { key: 'tmdb', prefix: 'tmdb:', emits: false, shape: 'object', value: 'number' },
  // `tt…` strings with prefix; first element on multi rows.
  { key: 'imdb', prefix: 'imdb:', emits: false, shape: 'scalar', value: 'string' },
  { key: 'tvdb', prefix: 'tvdb:', emits: false, shape: 'scalar', value: 'number' },
  { key: 'simkl', prefix: 'simkl:', emits: false, shape: 'scalar', value: 'number' },
];

export type AnimeIdentity =
  | {
      anilist: number;
      mal?: number;
      kitsu?: string;
      anidb?: number;
      tmdb?: TmdbIds;
      imdb?: string;
      tvdb?: number;
      simkl?: number;
    }
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
