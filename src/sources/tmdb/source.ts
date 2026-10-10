import type { HttpClient } from '../../net/http.js';
import type { Logger } from '../../util/logger.js';
import type { AnimeIdentity } from '../../domain/anime.js';
import { pickArtwork, type TmdbArtwork } from '../../render/artwork.js';

const TMDB_API = 'https://api.themoviedb.org/3';

/**
 * The artwork tier's own budget (roadmap Phase 4: "enrichment runs in parallel
 * under a 1.5 s budget each"). Deliberately separate from the identity and
 * episode budgets: the three tiers are started together and must not consume
 * one another's time.
 */
export const TMDB_BUDGET_MS = 1500;

/**
 * TMDB as an OPTIONAL artwork source (Phase 4).
 *
 * Gated on an operator-supplied key, which is never hardcoded: this class
 * takes it as a constructor argument and the only place it is read is
 * `AppConfig.tmdbApiKey`, from `TMDB_API_KEY`. With no key the tier makes no
 * request at all, which is what makes "TMDB key unset -> everything else works
 * identically" true rather than aspirational.
 *
 * Everything degrades to an empty result. A 401 from a wrong key, a 404 from an
 * unknown id, an empty `tv_results` array (which is a **200**) and a body that
 * is not JSON at all all produce `{}` — never a throw, never a 5xx.
 */
export class TmdbArtworkSource {
  private readonly http: HttpClient;
  private readonly log: Logger | undefined;
  private readonly apiKey: string | undefined;

  constructor(deps: { http: HttpClient; apiKey: string | undefined; log?: Logger }) {
    this.http = deps.http;
    this.log = deps.log;
    this.apiKey = deps.apiKey;
  }

  /**
   * Logo and backdrop for a title, or `{}` when it cannot be had.
   *
   * Two requests, both cheapest-first semantics: `/find` to get the TMDB id,
   * then `/tv/{id}/images`. The `/find` step is a savings as much as a
   * resolution — an anime has at most one TMDB id, so the artwork call would
   * otherwise have to be issued per inbound namespace.
   */
  async artworkFor(identity: AnimeIdentity): Promise<TmdbArtwork> {
    if (this.apiKey === undefined || this.apiKey === '') return {};

    const externalId = this.externalIdFor(identity);
    if (externalId === undefined) return {};

    const tmdbId = await this.findTmdbId(externalId);
    if (tmdbId === undefined) return {};

    return this.imagesFor(tmdbId);
  }

  /**
   * Prefers the TMDB-side TVDB id over IMDb.
   *
   * Both work, but `tvdb` is the id Fribb's mappings carry for nearly every
   * title (it is also what AniIndex uses for episode numbering), so it is the
   * path most titles can actually take. `imdb` is the fallback for the
   * minority that lack a TVDB id.
   */
  private externalIdFor(identity: AnimeIdentity): { source: string; id: string } | undefined {
    if (identity.anilist === undefined) {
      // Kitsu-only branch: TVDB and IMDb are not carried on it at all.
      return undefined;
    }
    const tvdb = 'tvdb' in identity ? identity.tvdb : undefined;
    if (typeof tvdb === 'number') return { source: 'tvdb_id', id: String(tvdb) };
    const imdb = 'imdb' in identity ? identity.imdb : undefined;
    if (typeof imdb === 'string' && imdb !== '') return { source: 'imdb_id', id: imdb };
    return undefined;
  }

  private async findTmdbId(external: { source: string; id: string }): Promise<number | undefined> {
    const url = new URL(`${TMDB_API}/find/${encodeURIComponent(external.id)}`);
    url.searchParams.set('external_source', external.source);
    url.searchParams.set('api_key', this.apiKey ?? '');

    let body: unknown;
    try {
      const result = await this.http.getJson<unknown>(url.toString(), {
        timeoutMs: TMDB_BUDGET_MS,
        headers: { Accept: 'application/json' },
      });
      body = result.data;
    } catch (err) {
      // A miss is not an error to propagate: every failure mode degrades to no
      // artwork, preserving the never-5xx invariant of the whole add-on.
      this.log?.debug('tmdb find failed', {
        source: external.source,
        kind: err instanceof Error ? err.message : 'unknown',
      });
      return undefined;
    }

    if (typeof body !== 'object' || body === null) return undefined;
    const results = (body as Record<string, unknown>).tv_results;
    if (!Array.isArray(results) || results.length === 0) return undefined;
    const first = results[0];
    if (typeof first !== 'object' || first === null) return undefined;
    const id = (first as Record<string, unknown>).id;
    return typeof id === 'number' ? id : undefined;
  }

  private async imagesFor(tmdbId: number): Promise<TmdbArtwork> {
    const url = new URL(`${TMDB_API}/tv/${tmdbId}/images`);
    url.searchParams.set('api_key', this.apiKey ?? '');

    try {
      const result = await this.http.getJson<unknown>(url.toString(), {
        timeoutMs: TMDB_BUDGET_MS,
        headers: { Accept: 'application/json' },
      });
      return pickArtwork(result.data);
    } catch (err) {
      this.log?.debug('tmdb images failed', {
        tmdbId,
        kind: err instanceof Error ? err.message : 'unknown',
      });
      return {};
    }
  }
}
