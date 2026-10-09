import type { HttpClient } from '../net/http.js';
import type { BundleIndices } from '../identity/bundle.js';
import { resolveToCanonical, resolveFromBundleOnly, IDENTITY_BUDGET_MS } from '../identity/resolver.js';
import type { Logger } from '../util/logger.js';
import { stremioIdFor, type AnimeIdentity } from '../domain/anime.js';
import type { TTLCache } from '../cache/store.js';

/** Spec §6 — ids are stable, so a positive resolution is worth keeping. */
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POSITIVE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
/** Spec §6 — a miss is short-lived so newly-added titles appear promptly. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

/**
 * The identity tier of the meta path, reached only through this service.
 *
 * Boundaries (docs/architecture.md §6.1): `services/` may orchestrate the
 * resolver and the HTTP layer, but must never import a concrete source
 * adapter — identity resolution has to survive swapping or disabling a source,
 * which is also why `src/identity/**` may not import `sources/**`.
 */
export class ResolveService {
  private readonly http: HttpClient;
  private readonly bundle: BundleIndices;
  private readonly log: Logger | undefined;
  private readonly cache: TTLCache | undefined;

  constructor(deps: { http: HttpClient; bundle: BundleIndices; log?: Logger; cache?: TTLCache }) {
    this.http = deps.http;
    this.bundle = deps.bundle;
    this.log = deps.log;
    this.cache = deps.cache;
  }

  /**
   * Bundle-only enrichment for an id that is already canonical in our own
   * namespace. Never touches the network: a miss returns null and the source's
   * identity is used as-is.
   */
  enrichFromBundle(input: string): AnimeIdentity | null {
    return resolveFromBundleOnly(input, this.bundle);
  }

  /**
   * Resolves any inbound namespace to a canonical identity, inside the shared
   * identity deadline. A miss returns null — never a guess.
   *
   * Caching (spec §6) lives here rather than inside the resolver: the resolver's
   * tiers are pure single-shot logic, and this is the one place that knows a
   * result is worth remembering. A positive entry outlives the negative window
   * by design, so a stale-but-correct id survives a string of upstream failures
   * instead of the title going dark.
   */
  async resolveToCanonical(
    input: string,
  ): Promise<{ identity: AnimeIdentity; canonicalId: string } | null> {
    const cacheKey = `resolve:${input}`;

    if (this.cache !== undefined) {
      const hit = this.cache.get<{ identity: AnimeIdentity; canonicalId: string } | null>(
        cacheKey,
      );
      if (hit !== undefined) {
        // Stale-positive is still served: the identity is a stable fact and
        // serving it beats returning null for a title we already resolved once.
        return hit.value;
      }
    }

    const resolved = await this.resolveUncached(input);

    if (this.cache !== undefined) {
      if (resolved === null) {
        this.cache.set(cacheKey, null, { ttlMs: NEGATIVE_TTL_MS, staleMs: 0 });
      } else {
        this.cache.set(cacheKey, resolved, { ttlMs: POSITIVE_TTL_MS, staleMs: POSITIVE_STALE_MS });
      }
    }

    this.log?.debug('identity resolved', { input, hit: resolved !== null });
    return resolved;
  }

  private async resolveUncached(
    input: string,
  ): Promise<{ identity: AnimeIdentity; canonicalId: string } | null> {
    const identity = await resolveToCanonical(input, this.http, this.bundle, IDENTITY_BUDGET_MS);
    if (identity === null) return null;
    return { identity, canonicalId: stremioIdFor(identity) };
  }
}
