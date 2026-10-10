import type { MetaPreview, MetaDetail } from 'stremio-addon-sdk';

/** Nuvio reads `banner` in preference to `background`. Not in the SDK's types. */
export interface StremioMetaPreview extends MetaPreview {
  banner?: string;
  landscapePoster?: string;
  /**
   * Emitted by `renderPreview` but declared on the SDK's `MetaDetail`, not
   * `MetaPreview`. Re-declared here so the catalog return type describes what
   * the renderer actually produces.
   */
  releaseInfo?: string | undefined;
  released?: string | undefined;
  imdbRating?: string | undefined;
  genres?: string[];
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
  /**
   * Present only when there is an episode list to send. Omitted rather than
   * sent as `[]` because an empty array is a claim that the series has no
   * episodes, which is not what "AniZip was unreachable" means (Phase 4;
   * Phase 1 always emitted `[]`).
   */
  videos?: StremioMetaVideo[];
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
