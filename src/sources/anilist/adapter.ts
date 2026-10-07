import { SourceError } from '../../domain/errors.js';
import type { Anime } from '../../domain/anime.js';
import type { HttpClient } from '../../net/http.js';
import type { TokenBucket } from '../../net/limiter.js';
import type { Logger } from '../../util/logger.js';
import type { AniListMedia, AniListGraphQLResponse, AniListPage } from './types.js';
import { CATALOG_QUERY, META_QUERY, SEARCH_QUERY } from './queries.js';
import { ANILIST_PER_PAGE } from '../catalog-def.js';
import type { AnimeSource, PageRequest, SourcePage, SourceId, SortKey } from '../types.js';
import { normalizeMedia } from '../../normalize/anime.js';

const ANILIST_URL = 'https://graphql.anilist.co';
const IDS_CHUNK_SIZE = 50; // AniList supports id_in batches of at least this size

// Page query reusing CATALOG_QUERY's media selection, keyed by id_in for
// batch fetches. Declared separately because CATALOG_QUERY has no $ids var.
const IDS_QUERY =
  'query($ids:[Int],$perPage:Int){Page(perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(id_in:$ids,type:ANIME,isAdult:false){id idMal title{romaji english native} format status episodes duration averageScore popularity coverImage{extraLarge large medium color} bannerImage genres season seasonYear startDate{year month day} isAdult nextAiringEpisode{episode airingAt timeUntilAiring}}}}';

export interface AniListSourceDeps {
  http: HttpClient;
  limiter: TokenBucket;
  log?: Logger;
  titleLang?: 'english' | 'romaji' | 'native';
}

// Catalogue (Page) responses arrive in the standard GraphQL envelope:
// {"data":{"Page":{pageInfo, media}}}. A null Page or a null media list means
// the page is exhausted or filtered out, not a transient failure.
type CatalogResponse = AniListGraphQLResponse<{ Page: AniListPage<AniListMedia> | null }>;

interface GraphQLError {
  message: string;
  status?: number;
}

function toSourceError(err: GraphQLError): SourceError {
  const message = `AniList GraphQL error: ${err.message}`;
  if (err.status === 429) {
    return new SourceError('rate_limited', message, 429);
  }
  return new SourceError('invalid_request', message, err.status);
}

function sortForKey(key: SortKey): string[] {
  switch (key) {
    case 'trending':
      return ['TRENDING_DESC'];
    case 'top_rated':
      return ['SCORE_DESC'];
    case 'search_match':
      return ['SEARCH_MATCH'];
  }
}

function sortForCatalog(catalogId: string): string[] {
  if (catalogId === 'anime-top-rated') {
    return sortForKey('top_rated');
  }
  if (catalogId === 'anime-search') {
    return sortForKey('search_match');
  }
  return sortForKey('trending');
}

export class AniListSource implements AnimeSource {
  private readonly http: HttpClient;
  private readonly limiter: TokenBucket;
  private readonly log: Logger | undefined;
  private readonly titleLang: 'english' | 'romaji' | 'native';

  readonly id: SourceId = 'anilist';

  constructor(deps: AniListSourceDeps) {
    this.http = deps.http;
    this.limiter = deps.limiter;
    this.log = deps.log;
    this.titleLang = deps.titleLang ?? 'english';
  }

  async fetchPage(req: PageRequest): Promise<SourcePage> {
    const sort = sortForCatalog(req.catalogId);
    const collected: Anime[] = [];
    let total = 0;
    let page = Math.floor(req.skip / ANILIST_PER_PAGE) + 1;
    let offset = req.skip % ANILIST_PER_PAGE;
    while (collected.length < req.limit) {
      const variables: Record<string, unknown> = {
        perPage: ANILIST_PER_PAGE,
        page,
        sort,
      };
      if (req.genre !== undefined) {
        variables.genre = req.genre;
      }
      const body = await this.post<CatalogResponse>(CATALOG_QUERY, variables, req.timeoutMs);
      const res = this.toPageResult(body);
      total = res.total;
      collected.push(...(offset > 0 ? res.items.slice(offset) : res.items));
      offset = 0;
      if (res.items.length < ANILIST_PER_PAGE) {
        break;
      }
      page += 1;
    }
    return { items: collected.slice(0, req.limit), total };
  }

  async search(term: string, skip: number, limit: number, timeoutMs?: number): Promise<SourcePage> {
    const page = Math.floor(skip / ANILIST_PER_PAGE) + 1;
    const offset = skip % ANILIST_PER_PAGE;
    const body = await this.post<CatalogResponse>(SEARCH_QUERY, {
      search: term,
      perPage: ANILIST_PER_PAGE,
      page,
      sort: sortForKey('search_match'),
    }, timeoutMs);
    const res = this.toPageResult(body);
    return { items: res.items.slice(offset, offset + limit), total: res.total };
  }

  async fetchById(anilistId: number, timeoutMs?: number): Promise<Anime | null> {
    let body: AniListGraphQLResponse<{ Media: AniListMedia | null }>;
    try {
      body = await this.post<AniListGraphQLResponse<{ Media: AniListMedia | null }>>(
        META_QUERY,
        { id: anilistId },
        timeoutMs,
      );
    } catch (err) {
      // AniList answers an unknown Media id with HTTP 404 (not HTTP 200 with
      // data.Media null), and HttpClient surfaces that as a SourceError with
      // status 404. A Media(id:) 404 means "no such title", so resolve null
      // and let MetaService write its 60 s negative-cache entry. Only 404 is
      // converted: a malformed query surfaces as 400 and must still throw.
      if (err instanceof SourceError && err.status === 404) {
        return null;
      }
      throw err;
    }
    // Check data.Media BEFORE errors[]: an unknown id carries both a 404
    // errors array AND data.Media null, and that shape means "not found".
    if (body.data != null && body.data.Media == null) {
      return null;
    }
    const firstError = body.errors?.[0];
    if (firstError !== undefined) {
      throw toSourceError(firstError);
    }
    const media = body.data?.Media;
    if (media == null) {
      throw new SourceError('invalid_request', `AniList returned no data for id ${anilistId}`);
    }
    return normalizeMedia(media, { titleLang: this.titleLang });
  }

  async fetchByIds(anilistIds: number[]): Promise<Anime[]> {
    const out: Anime[] = [];
    for (let i = 0; i < anilistIds.length; i += IDS_CHUNK_SIZE) {
      const chunk = anilistIds.slice(i, i + IDS_CHUNK_SIZE);
      const body = await this.post<CatalogResponse>(IDS_QUERY, {
        ids: chunk,
        perPage: IDS_CHUNK_SIZE,
      });
      const firstError = body.errors?.[0];
      if (firstError !== undefined) {
        throw toSourceError(firstError);
      }
      for (const m of body.data?.Page?.media ?? []) {
        if (m != null) {
          out.push(normalizeMedia(m, { titleLang: this.titleLang }));
        }
      }
    }
    return out;
  }

  private toPageResult(body: CatalogResponse): { items: Anime[]; total: number } {
    const firstError = body.errors?.[0];
    if (firstError !== undefined) {
      throw toSourceError(firstError);
    }
    const page = body.data?.Page;
    if (page == null) {
      throw new SourceError('not_found', 'AniList returned a null Page for this query');
    }
    if (page.media == null) {
      throw new SourceError('not_found', 'AniList returned no media for this page');
    }
    return {
      items: page.media.map((m) => normalizeMedia(m, { titleLang: this.titleLang })),
      total: page.pageInfo.total,
    };
  }

  private async post<T>(query: string, variables: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.limiter.tryAcquire()) {
      throw new SourceError('rate_limited', 'anilist limiter empty');
    }
    this.log?.debug('anilist request', { url: ANILIST_URL });
    const res = await this.http.getJson<T>(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return res.data;
  }
}
