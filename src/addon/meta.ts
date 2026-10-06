import type { Cache } from 'stremio-addon-sdk';
import type { MetaService } from '../services/meta.service.js';
import { renderDetail } from '../render/detail.js';
import type { StremioMetaDetail } from '../render/types.js';

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
}): (args: MetaArgs) => Promise<{ meta: StremioMetaDetail } & Cache> {
  return async (args: MetaArgs): Promise<{ meta: StremioMetaDetail } & Cache> => {
    try {
      const parsed = parseMetaId(args.id);
      if (parsed === null) {
        return { meta: minimalMeta(args), cacheMaxAge: 60 };
      }
      if (parsed.namespace === 'kitsu') {
        return { meta: minimalMeta(args), cacheMaxAge: 60 };
      }
      const result = await deps.metaService.getByAnilistId(Number(parsed.value));
      if (result.anime === null) {
        return { meta: minimalMeta(args), cacheMaxAge: 60 };
      }
      return { meta: renderDetail(result.anime), cacheMaxAge: result.cacheMaxAge };
    } catch {
      return { meta: minimalMeta(args), cacheMaxAge: 10 };
    }
  };
}
