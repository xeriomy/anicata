import { ANIZIP_API_BASE, NS_TO_ANIZIP_PARAM } from '../identity/resolver.js';
import type { HttpClient } from '../net/http.js';
import type { Logger } from '../util/logger.js';

/**
 * The episode tier's own budget (roadmap Phase 4: "enrichment runs in parallel
 * under a 1.5 s budget each").
 *
 * It is deliberately separate from `IDENTITY_BUDGET_MS`: identity resolution
 * and episode enrichment are started together and must not consume each
 * other's time, so a slow identity tier cannot shorten the episode fetch and
 * a slow episode fetch cannot shorten identity.
 */
export const EPISODE_BUDGET_MS = 1500;

/**
 * Fetches AniZip's `episodes` block for a title.
 *
 * Split out from the identity resolver on purpose. T7's design truncates
 * `episodes` and `images` because the One Piece response is 1.87 MB and
 * identity must not pay for them — so the resolver never reads this block at
 * all, and this service is what finally does.
 *
 * Every failure degrades to `null`. A meta that renders without episodes is a
 * worse meta; a meta that 500s is a broken add-on, and one of those is not
 * acceptable (roadmap gate: "AniZip down → meta renders without videos, no
 * error").
 */
export class EpisodeService {
  private readonly http: HttpClient;
  private readonly log: Logger | undefined;

  constructor(deps: { http: HttpClient; log?: Logger }) {
    this.http = deps.http;
    this.log = deps.log;
  }

  /**
   * Fetches by inbound namespace directly.
   *
   * Takes a namespace rather than an `AnimeIdentity` because the caller has a
   * parsed id and nothing else yet: `mal:21` on its own is not a valid
   * identity (the union requires `anilist` or `kitsu`), and building `{anilist:
   * 21}` to smuggle it through would be a fabricated fact. Asking AniZip with
   * the namespace we were handed also lets this run in parallel with identity
   * resolution instead of waiting for its answer.
   */
  async episodesFor(ns: string, value: string): Promise<Record<string, unknown> | null> {
    const param = NS_TO_ANIZIP_PARAM[ns];
    if (param === undefined) return null;

    const url = new URL(ANIZIP_API_BASE);
    url.searchParams.set(param, value);

    try {
      const result = await this.http.getJson<Record<string, unknown>>(url.toString(), {
        timeoutMs: EPISODE_BUDGET_MS,
        headers: { Accept: 'application/json', 'User-Agent': 'anicata-resolver/1.0' },
      });
      const episodes = result.data?.episodes;
      if (typeof episodes !== 'object' || episodes === null || Array.isArray(episodes)) {
        return null;
      }
      return episodes as Record<string, unknown>;
    } catch (err) {
      // A miss is not an error to propagate: every failure mode degrades to a
      // tier miss, preserving the never-5xx invariant of the whole add-on.
      this.log?.debug('episode fetch failed', {
        param,
        kind: err instanceof Error ? err.message : 'unknown',
      });
      return null;
    }
  }
}
