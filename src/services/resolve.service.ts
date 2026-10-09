import type { HttpClient } from '../net/http.js';
import type { BundleIndices } from '../identity/bundle.js';
import { resolveToCanonical, IDENTITY_BUDGET_MS } from '../identity/resolver.js';
import type { Logger } from '../util/logger.js';
import { stremioIdFor } from '../domain/anime.js';
import type { AnimeIdentity } from '../domain/anime.js';
import { loadBundle } from '../identity/bundle.js';

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

  constructor(deps: { http: HttpClient; bundle: BundleIndices; log?: Logger }) {
    this.http = deps.http;
    this.bundle = deps.bundle;
    this.log = deps.log;
  }

  /**
   * Resolves any inbound namespace to a canonical identity, inside the shared
   * identity deadline. A miss returns null — never a guess.
   */
  async resolveToCanonical(
    input: string,
  ): Promise<{ identity: AnimeIdentity; canonicalId: string } | null> {
    const identity = await resolveToCanonical(input, this.http, this.bundle, IDENTITY_BUDGET_MS);
    if (identity === null) return null;
    return { identity, canonicalId: stremioIdFor(identity) };
  }
}

export { loadBundle };
