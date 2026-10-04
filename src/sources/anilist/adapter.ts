import { SourceError } from '../../domain/errors.js';
import type { Anime } from '../../domain/anime.js';
import type { HttpClient } from '../../net/http.js';
import type { TokenBucket } from '../../net/limiter.js';
import type { Logger } from '../../util/logger.js';
import type { AniListMedia, AniListGraphQLResponse, AniListPage } from './types.js';
import { CATALOG_QUERY, META_QUERY, SEARCH_QUERY } from './queries.js';
import { ANILIST_PER_PAGE } from '../catalog-def.js';
import type { AniListPageQuery } from '../catalog-def.js';
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

export class AniListSource {
  private readonly http: HttpClient;
  private readonly limiter: TokenBucket;
  private readonly log: Logger | undefined;
  private readonly titleLang: 'english' | 'romaji' | 'native';

  constructor(deps: AniListSourceDeps) {
    this.http = deps.http;
    this.limiter = deps.limiter;
    this.log = deps.log;
    this.titleLang = deps.titleLang ?? 'english';
  }

  async fetchCatalogPage(q: AniListPageQuery): Promise<{ items: Anime[]; total: number }> {
    const variables: Record<string, unknown> = {
      perPage: q.perPage,
      page: q.page,
      sort: q.sort,
    };
    if (q.search !== undefined) {
      variables.search = q.search;
    }
    if (q.genre !== undefined) {
      variables.genre = q.genre;
    }
    const body = await this.post<CatalogResponse>(CATALOG_QUERY, variables);
    return this.toPageResult(body);
  }

  async search(term: string, page: number): Promise<{ items: Anime[]; total: number }> {
    const body = await this.post<CatalogResponse>(SEARCH_QUERY, {
      search: term,
      perPage: ANILIST_PER_PAGE,
      page,
      sort: ['SEARCH_MATCH'],
    });
    return this.toPageResult(body);
  }

  async fetchById(anilistId: number): Promise<Anime | null> {
    const body = await this.post<AniListGraphQLResponse<{ Media: AniListMedia | null }>>(
      META_QUERY,
      { id: anilistId },
    );
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

  private async post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.limiter.tryAcquire()) {
      throw new SourceError('rate_limited', 'anilist limiter empty');
    }
    this.log?.debug('anilist request', { url: ANILIST_URL });
    const res = await this.http.getJson<T>(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return res.data;
  }
}
