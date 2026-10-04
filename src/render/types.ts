import type { MetaPreview, MetaDetail } from 'stremio-addon-sdk';

/** Nuvio reads `banner` in preference to `background`. Not in the SDK's types. */
export interface StremioMetaPreview extends MetaPreview {
  banner?: string;
  landscapePoster?: string;
}

/**
 * `Omit<MetaDetail, 'videos'>` because the SDK types `videos?: MetaVideo[]` and we
 * replace it with our own shape. `country`/`language` are Nuvio's names; the standard
 * `countryOfOrigin`/`audioLanguage` are emitted alongside them.
 */
export interface StremioMetaDetail extends Omit<MetaDetail, 'videos'> {
  banner?: string;
  country?: string;
  countryOfOrigin?: string;
  language?: string;
  audioLanguage?: string;
  hashtags?: string[];
  videos: StremioMetaVideo[];
}

export interface StremioMetaVideo {
  id: string;
  title: string;
  released?: string;
  season?: number;
  episode?: number;
  overview?: string;
  thumbnail?: string;
  runtime?: number;
}
