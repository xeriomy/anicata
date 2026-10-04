import type { Anime } from '../domain/anime.js';
import { renderPreview } from './preview.js';
import type { StremioMetaDetail } from './types.js';

/**
 * Same widening as `preview.ts` (`type: 'anime'`, `posterShape: 'poster'`),
 * plus `status`, which the SDK's `MetaDetail` does not declare at all.
 * Widened at this one spot; the single `as` at the return carries those
 * three, everything else already matches the extended SDK types.
 */
type DetailOut = Omit<StremioMetaDetail, 'type' | 'posterShape'> & {
  type: string;
  posterShape: string;
  status?: string;
};

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  // Documented: carries the widened fields past the SDK's narrower types.
  // No `any` involved.
  return out as unknown as T;
}

export function renderDetail(a: Anime): StremioMetaDetail {
  const preview = renderPreview(a);
  const language = a.countryOfOrigin === 'JP' ? 'ja' : undefined;
  const full: DetailOut = {
    ...preview,
    // Re-pinned: the spread types these as the SDK's narrower optionals.
    type: a.type,
    posterShape: 'poster',
    logo: undefined,
    runtime: a.durationMinutes != null ? `${a.durationMinutes} min` : undefined,
    status: a.status,
    ...(a.countryOfOrigin !== undefined
      ? { country: a.countryOfOrigin, countryOfOrigin: a.countryOfOrigin }
      : {}),
    ...(language !== undefined ? { language, audioLanguage: language } : {}),
    hashtags: a.hashtags,
    awards: undefined,
    links: [
      {
        name: 'AniList',
        category: 'AniList',
        url: `https://anilist.co/anime/${a.identity.anilist}`,
      },
      ...(a.identity.mal != null
        ? [
            {
              name: 'MyAnimeList',
              category: 'MyAnimeList',
              url: `https://myanimelist.net/anime/${a.identity.mal}`,
            },
          ]
        : []),
    ],
    videos: [],
  };
  return stripUndefined(full) as StremioMetaDetail;
}
