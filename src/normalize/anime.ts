import type {
  Anime,
  AnimeFormat,
  AnimeStatus,
  AnimeTitle,
  Season,
} from '../domain/anime.js';
import type { AniListMedia } from '../sources/anilist/types.js';
import { normalizeDescription, resolveDisplayTitle } from './text.js';

export const TAG_MIN_RANK = 60;

export function normalizeFormat(raw: string | null | undefined): AnimeFormat {
  switch (raw) {
    case 'TV':
    case 'TV_SHORT':
    case 'MOVIE':
    case 'SPECIAL':
    case 'OVA':
    case 'ONA':
    case 'MUSIC':
      return raw;
    default:
      return 'OTHER';
  }
}

export function normalizeStatus(raw: string | null | undefined): AnimeStatus {
  switch (raw) {
    case 'FINISHED':
    case 'RELEASING':
    case 'NOT_YET_RELEASED':
    case 'CANCELLED':
    case 'HIATUS':
      return raw;
    default:
      return 'UNKNOWN';
  }
}

function normalizeSeason(raw: string | null | undefined): Season | undefined {
  switch (raw) {
    case 'WINTER':
    case 'SPRING':
    case 'SUMMER':
    case 'FALL':
      return raw;
    default:
      return undefined;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function normalizeMedia(
  m: AniListMedia,
  opts: { titleLang: 'english' | 'romaji' | 'native' },
): Anime {
  const format = normalizeFormat(m.format);
  const status = normalizeStatus(m.status);

  const titleFields = {
    ...(m.title?.romaji != null ? { romaji: m.title.romaji } : {}),
    ...(m.title?.english != null ? { english: m.title.english } : {}),
    ...(m.title?.native != null ? { native: m.title.native } : {}),
  };
  const title: AnimeTitle = { synonyms: m.synonyms ?? [], ...titleFields };
  // Resolve from the title fields only (m.title has no synonyms): a fully-null
  // title falls back to 'Untitled' even when synonyms are present.
  const displayTitle = resolveDisplayTitle({ synonyms: [], ...titleFields }, opts.titleLang);

  const description = normalizeDescription(m.description);
  const season = normalizeSeason(m.season);

  const year = m.startDate?.year;
  const releaseDate =
    year != null
      ? `${year}-${pad2(m.startDate?.month ?? 1)}-${pad2(m.startDate?.day ?? 1)}`
      : undefined;

  const nextAiring = m.nextAiringEpisode;

  return {
    identity: {
      anilist: m.id,
      ...(m.idMal != null ? { mal: m.idMal } : {}),
    },
    title,
    displayTitle,
    ...(description !== undefined ? { description } : {}),
    format,
    status,
    type: format === 'MOVIE' ? 'movie' : 'anime',
    ...(m.episodes != null ? { episodes: m.episodes } : {}),
    ...(m.duration != null ? { durationMinutes: m.duration } : {}),
    ...(releaseDate !== undefined ? { releaseDate } : {}),
    ...(year != null ? { releaseYear: year } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(m.seasonYear != null ? { seasonYear: m.seasonYear } : {}),
    genres: m.genres ?? [],
    tags: (m.tags ?? [])
      .filter(
        (t) =>
          t.rank >= TAG_MIN_RANK &&
          t.isMediaSpoiler !== true &&
          t.isAdult !== true,
      )
      .map((t) => ({
        id: t.id,
        name: t.name,
        rank: t.rank,
        category: t.category ?? 'Unknown',
      })),
    studios:
      m.studios?.edges?.map((e) => ({
        id: e.node.id,
        name: e.node.name,
        isMain: e.isMain,
      })) ?? [],
    relations:
      m.relations?.edges?.map((e) => ({
        id: e.node.id,
        relationType: e.relationType,
        title: resolveDisplayTitle(
          {
            synonyms: [],
            ...(e.node.title?.romaji != null ? { romaji: e.node.title.romaji } : {}),
            ...(e.node.title?.english != null ? { english: e.node.title.english } : {}),
          },
          opts.titleLang,
        ),
        format: normalizeFormat(e.node.format),
        type: e.node.type,
      })) ?? [],
    images: {
      ...(m.coverImage?.extraLarge != null ? { poster: m.coverImage.extraLarge } : {}),
      ...(m.bannerImage != null ? { background: m.bannerImage } : {}),
    },
    ...(m.averageScore != null ? { scoreAnilist: m.averageScore } : {}),
    ...(nextAiring != null
      ? {
          airing: {
            ...(nextAiring.episode != null ? { nextEpisode: nextAiring.episode } : {}),
            ...(nextAiring.airingAt != null ? { nextAiringAt: nextAiring.airingAt } : {}),
          },
        }
      : {}),
    ...(m.siteUrl != null ? { siteUrl: m.siteUrl } : {}),
    hashtags: m.hashtag ? [m.hashtag] : [],
    ...(m.countryOfOrigin != null ? { countryOfOrigin: m.countryOfOrigin } : {}),
  };
}
