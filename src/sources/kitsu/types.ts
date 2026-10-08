// TypeScript interfaces describing Kitsu's JSON:API response shapes.
// Shapes were pinned against live responses recorded in
// test/fixtures/kitsu-page.json and test/fixtures/kitsu-anime-1.json
// (captured 2026-10-07 against https://kitsu.io/api/edge).
// Rule: any field Kitsu can return `null` for is `| null`; only
// `KitsuAnime.id` is non-nullable, and even that arrives as a `string`
// (both id namespaces are integers, but Kitsu serialises them as strings).

export interface KitsuTitles {
  en?: string | null;
  en_jp?: string | null;
  ja_jp?: string | null;
}

export interface KitsuImageSet {
  tiny?: string | null;
  small?: string | null;
  medium?: string | null;
  large?: string | null;
  original?: string | null;
}

export interface KitsuAttributes {
  canonicalTitle: string | null;
  titles: KitsuTitles | null;
  abbreviatedTitles: string[] | null;
  synopsis: string | null;
  description: string | null;
  // Kitsu's own vocabularies, mapped explicitly in adapter.ts: status is one
  // of finished/current/upcoming/tba/unreleased; showType/subtype is one of
  // TV/special/OVA/ONA/movie/music (either casing has been observed).
  status: string | null;
  subtype: string | null;
  showType: string | null;
  episodeCount: number | null;
  episodeLength: number | null;
  startDate: string | null;
  // Kitsu types this as a string ("82.27"), not a number. The adapter coerces
  // it and drops it when it does not parse, so it must never become NaN.
  averageRating: string | null;
  posterImage: KitsuImageSet | null;
  coverImage: KitsuImageSet | null;
  slug: string | null;
}

export interface KitsuAnime {
  id: string;
  type: 'anime';
  attributes: KitsuAttributes;
  relationships?: {
    genres?: {
      data?: Array<{ type: string; id: string }>;
    };
  };
}

// Genre entries arrive in `included`, never on the record: match
// `relationships.genres.data[].id` against entries with `type === 'genres'`
// and read `attributes.name`.
export interface KitsuIncluded {
  id: string;
  type: string;
  attributes?: {
    name?: string | null;
  };
}

export interface KitsuListResponse {
  data: KitsuAnime[];
  included?: KitsuIncluded[];
  meta?: { count?: number };
}

export interface KitsuSingleResponse {
  data: KitsuAnime | null;
  included?: KitsuIncluded[];
}
