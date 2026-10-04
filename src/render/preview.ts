import { stremioIdFor, type Anime } from '../domain/anime.js';
import type { StremioMetaPreview } from './types.js';

/**
 * Nuvio catalogues use `type: 'anime'` with `posterShape: 'poster'`; the SDK's
 * `ContentType` has no `'anime'` and its `posterShape` has no `'poster'`.
 * Widened at this one spot so the declared return keeps handlers assignable
 * to the SDK. The single `as` at the return carries these two runtime values.
 */
type PreviewOut = Omit<StremioMetaPreview, 'type' | 'posterShape'> & {
  type: string;
  posterShape: string;
  releaseInfo?: string | undefined;
  released?: string | undefined;
  imdbRating?: string | undefined;
  genres?: string[];
};

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  // Documented: carries the widened `type`/`posterShape` past the SDK's
  // narrower unions. No `any` involved.
  return out as unknown as T;
}

export function renderPreview(a: Anime): StremioMetaPreview {
  const full: PreviewOut = {
    id: stremioIdFor(a.identity),
    type: a.type,
    name: a.displayTitle,
    poster: a.images.poster,
    posterShape: 'poster',
    ...(a.images.background !== undefined
      ? { banner: a.images.background, background: a.images.background }
      : {}),
    description: a.description,
    releaseInfo: a.releaseYear != null ? String(a.releaseYear) : undefined,
    released: a.releaseDate,
    imdbRating: a.scoreAnilist != null ? (a.scoreAnilist / 10).toFixed(1) : undefined,
    genres: a.genres,
  };
  return stripUndefined(full) as StremioMetaPreview;
}
