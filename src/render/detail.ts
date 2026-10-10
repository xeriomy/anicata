import type { Anime, AnimeIdentity } from '../domain/anime.js';
import { renderPreview } from './preview.js';
import type { StremioMetaDetail, StremioMetaVideo } from './types.js';

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

export function renderDetail(a: Anime, videos?: StremioMetaVideo[]): StremioMetaDetail {
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
    links: buildLinks(a.identity),
    // Phase 4 episodes. Omitted when the tier produced nothing, so a title
    // whose episode data could not be had does not claim to have no episodes.
    ...(videos !== undefined && videos.length > 0 ? { videos } : {}),
  };
  return stripUndefined(full) as StremioMetaDetail;
}

/**
 * `links[]` for AniList, MyAnimeList, Kitsu and AniDB — spec §5 (D1).
 *
 * Emitted even though Nuvio parses but never displays them (verified at Nuvio
 * HEAD 966a52b): other Stremio clients do render links, and the cost is a few
 * hundred bytes on a response that already carries a poster URL.
 *
 * Two rules that must not drift:
 *  - exactly three keys per entry (`name`, `category`, `url`) — all three are
 *    required by Nuvio's `MetaDetailsParser.links()`;
 *  - an entry is omitted when its id is unknown. Never invent one: a
 *    `kitsu.io/anime/undefined` link is worse than no link, and this is
 *    precisely what the previous unconditional Kitsu branch produced.
 *
 * Categories are database names, so they can never collide with Nuvio's
 * people-mining filters (which look for cast/crew style categories).
 */
function buildLinks(identity: AnimeIdentity): Array<{ name: string; category: string; url: string }> {
  const links: Array<{ name: string; category: string; url: string }> = [];
  // `kitsu` is a string on the anilist-carrying branch (cross-id) and a number
  // on the Kitsu-only branch (ADR-016). Both stringify identically for a URL.
  const kitsu = identity.kitsu !== undefined ? String(identity.kitsu) : undefined;

  if (identity.anilist !== undefined) {
    links.push({
      name: 'AniList',
      category: 'AniList',
      url: `https://anilist.co/anime/${identity.anilist}`,
    });
  }
  if (identity.mal !== undefined) {
    links.push({
      name: 'MyAnimeList',
      category: 'MyAnimeList',
      url: `https://myanimelist.net/anime/${identity.mal}`,
    });
  }
  if (kitsu !== undefined) {
    links.push({ name: 'Kitsu', category: 'Kitsu', url: `https://kitsu.app/anime/${kitsu}` });
  }
  // `anidb` exists only on the anilist-carrying branch of the union; the
  // Kitsu-only branch (ADR-016) cannot carry one. `in` is the narrowing that
  // respects the union instead of asserting past it.
  const anidb = 'anidb' in identity ? identity.anidb : undefined;

  if (anidb !== undefined) {
    links.push({
      name: 'AniDB',
      category: 'AniDB',
      url: `https://anidb.net/anime/${anidb}`,
    });
  }
  return links;
}
