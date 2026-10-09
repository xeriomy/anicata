import type { Cache } from 'stremio-addon-sdk';
import type { MetaService } from '../services/meta.service.js';
import type { ResolveService } from '../services/resolve.service.js';
import { parseIncomingId } from '../identity/ids.js';
import { mergeIdentity } from '../identity/merge.js';
import { renderDetail } from '../render/detail.js';
import type { StremioMetaDetail } from '../render/types.js';
import type { AnimeIdentity } from '../domain/anime.js';

export type ParsedMetaId = { namespace: 'anilist' | 'kitsu'; value: string };

export interface MetaArgs {
  type: string;
  id: string;
}

const INT_RE = /^\d+$/;

/**
 * Strict, case-sensitive id parser. A bare number is rejected: Nuvio reads an
 * unprefixed number as a Trakt id, so accepting one would resolve the wrong
 * title. A trailing `:season:episode` video suffix is tolerated and ignored.
 */
export function parseMetaId(raw: string): ParsedMetaId | null {
  const parts = raw.trim().split(':');
  if (parts.length < 2 || parts.length > 4) return null;
  const namespace = parts[0];
  const value = parts[1];
  if (namespace !== 'anilist' && namespace !== 'kitsu') return null;
  if (value === undefined || !INT_RE.test(value)) return null;
  for (const tail of parts.slice(2)) {
    if (!INT_RE.test(tail)) return null;
  }
  return { namespace, value };
}

/**
 * Same widening as `render/preview.ts`: `type` stays the caller's string
 * (usually `'anime'`, outside the SDK's union). The single `as` carries it;
 * no `any` involved.
 */
type MinimalOut = Omit<StremioMetaDetail, 'type'> & { type: string };

/**
 * Nuvio's `MetaDetailsParser` requires `id`, `type` and `name` — a missing
 * one makes it throw and Nuvio skips the add-on entirely. Every failure path
 * returns this shape so a failure is always a clean "no results".
 */
function minimalMeta(args: MetaArgs): StremioMetaDetail {
  const full: MinimalOut = {
    id: args.id,
    type: args.type,
    name: 'Unavailable',
    videos: [],
  };
  return full as StremioMetaDetail;
}

export function createMetaHandler(deps: {
  metaService: MetaService;
  resolve?: ResolveService;
}): (args: MetaArgs) => Promise<{ meta: StremioMetaDetail } & Cache> {
  return async (args: MetaArgs): Promise<{ meta: StremioMetaDetail } & Cache> => {
    try {
      // Parse before anything is looked up: a bare number is a Trakt id and a
      // malformed prefix is not ours at all, and both must cost zero upstream
      // calls (roadmap gate 5).
      const parsed = parseIncomingId(args.id);
      if (parsed === null) {
        return { meta: minimalMeta(args), cacheMaxAge: 60 };
      }

      // Identity tier (Phase 3, spec §7.2).
      //
      // An `anilist:` id is already canonical, so it is fetched directly: the
      // resolver cannot add anything to it except live-tier latency, and its
      // failure would turn a perfectly fetchable title into a placeholder.
      // Only other namespaces need translating — and a miss there is a clean
      // "no results", never a fallback fetch under the wrong namespace
      // (roadmap gate 4).
      //
      // Reached through the service so the protocol layer never imports the
      // resolver's HTTP layer directly.
      let canonical: string;
      let resolvedIdentity: AnimeIdentity | null = null;
      if (deps.resolve === undefined) {
        // No identity tier wired: fetch as given.
        canonical = `${parsed.ns}:${parsed.value}`;
      } else if (parsed.ns === 'anilist') {
        // Already canonical, so there is nothing to translate — but the bundle
        // can still enrich it with ids the source omits. Bundle-only, so a
        // miss costs no live-tier latency.
        canonical = `anilist:${parsed.value}`;
        resolvedIdentity = deps.resolve.enrichFromBundle(args.id);
      } else {
        const resolved = await deps.resolve.resolveToCanonical(args.id);
        // A miss is NOT a dead end. The source chain can still serve the id in
        // its own namespace — Kitsu publishes under `kitsu:` for Kitsu-only
        // titles (ADR-016) — so we fall back to the parsed id rather than
        // returning a placeholder for a title we never actually asked for.
        canonical = resolved?.canonicalId ?? `${parsed.ns}:${parsed.value}`;
        resolvedIdentity = resolved?.identity ?? null;
      }

      const result = await deps.metaService.getById(canonical);
      if (result.anime === null) {
        return { meta: minimalMeta(args), cacheMaxAge: 60 };
      }
      // Overlay the resolved identity onto what the source supplied. The source
      // owns the canonical id; the resolved tier only fills what it was
      // missing — which is what turns links[] from 2 entries into 4.
      const anime =
        resolvedIdentity === null
          ? result.anime
          : { ...result.anime, identity: mergeIdentity(result.anime.identity, resolvedIdentity) };
      return { meta: renderDetail(anime), cacheMaxAge: result.cacheMaxAge };
    } catch {
      return { meta: minimalMeta(args), cacheMaxAge: 10 };
    }
  };
}
