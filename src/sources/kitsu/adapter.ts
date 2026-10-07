import { SourceError } from '../../domain/errors.js';
import type { Anime, AnimeFormat, AnimeStatus, AnimeTitle } from '../../domain/anime.js';
import type { HttpClient } from '../../net/http.js';
import type { TokenBucket } from '../../net/limiter.js';
import type { Logger } from '../../util/logger.js';
import type { KitsuAnime, KitsuImageSet, KitsuIncluded, KitsuListResponse, KitsuSingleResponse } from './types.js';
import { buildByIdUrl, buildPageUrl, buildSearchUrl } from './queries.js';
import type { AnimeSource, PageRequest, SourcePage, SourceId, SortKey } from '../types.js';
import { normalizeDescription, resolveDisplayTitle } from '../../normalize/text.js';

export interface KitsuSourceDeps {
  http: HttpClient;
  limiter: TokenBucket;
  log?: Logger;
  titleLang?: 'english' | 'romaji' | 'native';
}

export function kitsuSort(sort: SortKey): string {
  switch (sort) {
    case 'top_rated':
      return '-averageRating';
    case 'trending':
      // Deliberate approximation, NOT an exact mapping: Kitsu has no trending
      // sort. `trending`, `recently_popular`, `relevance`, `title` and
      // `favorites` are all rejected with HTTP 400 ("<value> is not a valid
      // sort criteria for anime"); only `average_rating`, `userCount` and
      // `popularityRank` are accepted (verified 2026-10-07). Most-favorited
      // (-userCount) is the closest popularity signal, and a blank trending
      // row reads as broken, so trending is proxied onto it.
      return '-userCount';
    case 'search_match':
      // No sort: `filter[text]` already ranks by relevance server-side, and
      // any explicit sort would override that ranking. Callers omit the
      // `sort` param when this returns ''.
      return '';
  }
}

function sortForCatalog(catalogId: string): string {
  if (catalogId === 'anime-top-rated') {
    return kitsuSort('top_rated');
  }
  if (catalogId === 'anime-search') {
    return kitsuSort('search_match');
  }
  return kitsuSort('trending');
}

function normalizeKitsuFormat(raw: string | null | undefined): AnimeFormat {
  const upper = (raw ?? '').toUpperCase();
  switch (upper) {
    case 'TV':
    case 'MOVIE':
    case 'SPECIAL':
    case 'OVA':
    case 'ONA':
    case 'MUSIC':
      return upper as AnimeFormat;
    default:
      return 'OTHER';
  }
}

function normalizeKitsuStatus(raw: string | null | undefined): AnimeStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'finished':
      return 'FINISHED';
    case 'current':
      return 'RELEASING';
    case 'upcoming':
    case 'unreleased':
    case 'tba':
      return 'NOT_YET_RELEASED';
    default:
      return 'UNKNOWN';
  }
}

// Kitsu types averageRating as a string ("82.27"), not a number. Coerce it
// and drop it when it does not parse: a NaN score would poison every
// downstream comparison, so this returns undefined instead of NaN.
function parseScore(raw: string | null | undefined): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickImage(set: KitsuImageSet | null | undefined): string | undefined {
  return (
    set?.original ?? set?.large ?? set?.medium ?? set?.small ?? set?.tiny ?? undefined
  );
}

const START_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Genre names live in `included`, never on the record: match
// `relationships.genres.data[].id` against entries with `type === 'genres'`.
// An anime with no genres yields an empty array, never undefined.
function genresFor(record: KitsuAnime, included: KitsuIncluded[] | undefined): string[] {
  const refs = record.relationships?.genres?.data;
  if (refs == null || refs.length === 0) {
    return [];
  }
  const names = new Map<string, string>();
  for (const entry of included ?? []) {
    if (entry.type === 'genres') {
      const name = entry.attributes?.name;
      if (typeof name === 'string' && name.length > 0) {
        names.set(entry.id, name);
      }
    }
  }
  const out: string[] = [];
  for (const ref of refs) {
    const name = names.get(ref.id);
    if (name !== undefined) {
      out.push(name);
    }
  }
  return out;
}

export function normalizeKitsuAnime(
  record: KitsuAnime,
  included: KitsuIncluded[] | undefined,
  opts: { titleLang: 'english' | 'romaji' | 'native' },
): Anime {
  const attrs = record.attributes;
  const format = normalizeKitsuFormat(attrs.showType ?? attrs.subtype);
  const status = normalizeKitsuStatus(attrs.status);

  // Kitsu's title vocabulary maps onto AniList's one field-for-field: `en`
  // is the English title, `en_jp` the romanised Japanese title, `ja_jp` the
  // Japanese-script title.
  const title: AnimeTitle = {
    synonyms: attrs.abbreviatedTitles ?? [],
    ...(attrs.titles?.en_jp != null ? { romaji: attrs.titles.en_jp } : {}),
    ...(attrs.titles?.en != null ? { english: attrs.titles.en } : {}),
    ...(attrs.titles?.ja_jp != null ? { native: attrs.titles.ja_jp } : {}),
  };
  const resolved = resolveDisplayTitle(title, opts.titleLang);
  // Kitsu always sends a canonicalTitle (its own display name), so prefer it
  // over 'Untitled' when no structured title survived.
  const displayTitle =
    resolved === 'Untitled' && attrs.canonicalTitle != null ? attrs.canonicalTitle : resolved;

  const description = normalizeDescription(attrs.synopsis ?? attrs.description);
  const score = parseScore(attrs.averageRating);

  const numericId = Number.parseInt(record.id, 10);
  if (!Number.isSafeInteger(numericId)) {
    throw new SourceError('invalid_request', `Kitsu returned a non-numeric anime id: ${record.id}`);
  }

  const startDate = attrs.startDate != null && START_DATE_RE.test(attrs.startDate) ? attrs.startDate : undefined;
  const releaseYear = startDate !== undefined ? Number.parseInt(startDate.slice(0, 4), 10) : undefined;
  const poster = pickImage(attrs.posterImage);
  const background = pickImage(attrs.coverImage);

  // Kitsu exposes no AniList id (that mapping lives in its `mappings`
  // relationship, which this adapter does not fetch), and `AnimeIdentity`
  // requires a numeric `anilist` id. The Kitsu numeric id is the only id
  // available, so it fills that field; namespacing Kitsu ids downstream is
  // the fallback chain's concern, not this adapter's.
  return {
    identity: { anilist: numericId },
    title,
    displayTitle,
    ...(description !== undefined ? { description } : {}),
    format,
    status,
    type: format === 'MOVIE' ? 'movie' : 'anime',
    ...(attrs.episodeCount != null ? { episodes: attrs.episodeCount } : {}),
    ...(attrs.episodeLength != null ? { durationMinutes: attrs.episodeLength } : {}),
    ...(startDate !== undefined ? { releaseDate: startDate } : {}),
    ...(releaseYear !== undefined ? { releaseYear } : {}),
    genres: genresFor(record, included),
    tags: [],
    studios: [],
    relations: [],
    images: {
      ...(poster !== undefined ? { poster } : {}),
      ...(background !== undefined ? { background } : {}),
    },
    ...(score !== undefined ? { scoreAnilist: score } : {}),
    ...(attrs.slug != null ? { siteUrl: `https://kitsu.io/anime/${attrs.slug}` } : {}),
    hashtags: [],
  };
}

export class KitsuSource implements AnimeSource {
  private readonly http: HttpClient;
  private readonly limiter: TokenBucket;
  private readonly log: Logger | undefined;
  private readonly titleLang: 'english' | 'romaji' | 'native';

  readonly id: SourceId = 'kitsu';

  constructor(deps: KitsuSourceDeps) {
    this.http = deps.http;
    this.limiter = deps.limiter;
    this.log = deps.log;
    this.titleLang = deps.titleLang ?? 'english';
  }

  async fetchPage(req: PageRequest): Promise<SourcePage> {
    // Kitsu takes page[offset]/page[limit] directly with no silent clamp
    // (unlike AniList's 50-per-request clamp), so ask for what is needed in a
    // single request instead of stitching pages.
    const params: { sort: string; limit: number; offset: number; genre?: string } = {
      sort: sortForCatalog(req.catalogId),
      limit: req.limit,
      offset: req.skip,
    };
    if (req.genre !== undefined) {
      params.genre = req.genre;
    }
    const body = await this.get<KitsuListResponse>(buildPageUrl(params));
    return this.toPageResult(body);
  }

  async search(term: string, skip: number, limit: number): Promise<SourcePage> {
    const body = await this.get<KitsuListResponse>(buildSearchUrl(term, limit, skip));
    return this.toPageResult(body);
  }

  async fetchById(kitsuId: number): Promise<Anime | null> {
    let body: KitsuSingleResponse;
    try {
      body = await this.get<KitsuSingleResponse>(buildByIdUrl(kitsuId));
    } catch (err) {
      // Kitsu answers an unknown anime id with HTTP 404 (verified 2026-10-07:
      // {"errors":[{"title":"Record not found",...,"status":"404"}]}), and
      // HttpClient surfaces that as a SourceError with status 404. A 404
      // means "no such title", so resolve null and let MetaService write its
      // negative-cache entry. Only 404 is converted: a malformed query
      // surfaces as 400 and must still throw.
      if (err instanceof SourceError && err.status === 404) {
        return null;
      }
      throw err;
    }
    if (body.data == null) {
      return null;
    }
    return normalizeKitsuAnime(body.data, body.included, { titleLang: this.titleLang });
  }

  private toPageResult(body: KitsuListResponse): SourcePage {
    if (!Array.isArray(body.data)) {
      throw new SourceError('invalid_request', 'Kitsu returned no data array for this query');
    }
    return {
      items: body.data.map((r) => normalizeKitsuAnime(r, body.included, { titleLang: this.titleLang })),
      total: body.meta?.count ?? body.data.length,
    };
  }

  private async get<T>(url: string): Promise<T> {
    if (!this.limiter.tryAcquire()) {
      throw new SourceError('rate_limited', 'kitsu limiter empty');
    }
    this.log?.debug('kitsu request', { url });
    const res = await this.http.getJson<T>(url, {
      headers: { Accept: 'application/vnd.api+json' },
    });
    return res.data;
  }
}
