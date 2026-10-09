import { HttpClient } from '../net/http.js';
import { parseIncomingId } from './ids.js';
import type { AnimeIdentity } from '../domain/anime.js';
import type { BundleIndices } from './bundle.js';

// Budget constants — shared deadline, never a fresh clock
export const IDENTITY_BUDGET_MS = 1500;
export const KITSU_TIER_CAP_MS = 700;
export const TIER_SKIP_FLOOR_MS = 200;

const KITSU_API_BASE = 'https://kitsu.io/api/edge';

// Map inbound namespace prefixes to Kitsu externalSite values for forward lookups.
// Case-sensitive: exact strings must match the Kitsu API vocabulary.
const NS_TO_KITSU_EXTERNAL_SITE: Record<string, string> = {
  anilist: 'anilist/anime',
  mal: 'myanimelist/anime',
  anidb: 'anidb',
  tvdb: 'thetvdb/series',
};

// Build the Kitsu forward lookup URL from a parsed inbound id.
// The fake HttpClient inspects the URL and options; never add page[limit] on
// single-id lookups.
function buildKitsuForwardUrl(parsed: { ns: string; value: string }): URL {
  const url = new URL(KITSU_API_BASE + '/mappings');
  url.searchParams.set('filter[externalSite]', NS_TO_KITSU_EXTERNAL_SITE[parsed.ns] || parsed.ns);
  url.searchParams.set('filter[externalId]', parsed.value);
  url.searchParams.set('include', 'item');
  // page[limit] is deliberately NOT added for single-id lookups
  return url;
}

// Build the Kitsu reverse lookup URL for a kitsu id.
function buildKitsuReverseUrl(kitsuId: number): URL {
  const url = new URL(KITSU_API_BASE + `/anime/${kitsuId}/mappings`);
  return url;
}

// --- Tier 0: Bundle lookup -----------------------------------------------------

function tryResolveFromBundle(
  parsed: ReturnType<typeof parseIncomingId> | null,
  bundle: BundleIndices
): AnimeIdentity | null {
  if (!parsed) return null;

  switch (parsed.ns) {
    case 'anilist': {
      const row = bundle.byAnilist.get(Number(parsed.value));
      if (row === undefined) return null;
      return {
        anilist: row.anilist_id,
        ...(row.mal_id !== undefined && { mal: row.mal_id }),
        ...(row.kitsu_id !== undefined && { kitsu: String(row.kitsu_id) }),
        ...(row.anidb_id !== undefined && { anidb: row.anidb_id }),
        ...(row.themoviedb_id !== null && row.themoviedb_id !== undefined &&
          typeof row.themoviedb_id === 'object' &&
          {
            tmdb: {
              tv: row.themoviedb_id.tv,
              movie: row.themoviedb_id.movie,
            },
          }),
        ...(row.imdb_id !== undefined && { imdb: row.imdb_id }),
        ...(row.tvdb_id !== undefined && { tvdb: row.tvdb_id }),
        ...(row.simkl_id !== undefined && { simkl: row.simkl_id }),
      } as AnimeIdentity;
    }
    case 'kitsu': {
      const row = bundle.byKitsu.get(Number(parsed.value));
      if (row === undefined) return null;
      return {
        anilist: row.anilist_id,
        ...(row.mal_id !== undefined && { mal: row.mal_id }),
        ...(row.kitsu_id !== undefined && { kitsu: String(row.kitsu_id) }),
        ...(row.anidb_id !== undefined && { anidb: row.anidb_id }),
        ...(row.themoviedb_id !== null && row.themoviedb_id !== undefined &&
          typeof row.themoviedb_id === 'object' &&
          {
            tmdb: {
              tv: row.themoviedb_id.tv,
              movie: row.themoviedb_id.movie,
            },
          }),
        ...(row.imdb_id !== undefined && { imdb: row.imdb_id }),
        ...(row.tvdb_id !== undefined && { tvdb: row.tvdb_id }),
        ...(row.simkl_id !== undefined && { simkl: row.simkl_id }),
      } as AnimeIdentity;
    }
    case 'mal': {
      const row = bundle.byMal.get(Number(parsed.value));
      if (row === undefined) return null;
      return {
        anilist: row.anilist_id,
        ...(row.mal_id !== undefined && { mal: row.mal_id }),
        ...(row.kitsu_id !== undefined && { kitsu: String(row.kitsu_id) }),
        ...(row.anidb_id !== undefined && { anidb: row.anidb_id }),
        ...(row.themoviedb_id !== null && row.themoviedb_id !== undefined &&
          typeof row.themoviedb_id === 'object' &&
          {
            tmdb: {
              tv: row.themoviedb_id.tv,
              movie: row.themoviedb_id.movie,
            },
          }),
        ...(row.imdb_id !== undefined && { imdb: row.imdb_id }),
        ...(row.tvdb_id !== undefined && { tvdb: row.tvdb_id }),
        ...(row.simkl_id !== undefined && { simkl: row.simkl_id }),
      } as AnimeIdentity;
    }
    case 'anidb': {
      // anidb is carried but not indexed for inbound resolution in this task
      return null;
    }
    default:
      return null;
  }
}

// --- Tier 1: Kitsu forward lookup (external site + id) -----------------------

interface KitsuMapping {
  id: string;
  type: string;
  attributes: {
    externalSite: string;
    externalId: string;
  };
  relationships: {
    item: {
      data: {
        type: string;
        id: string;
      };
    };
  };
}

// resolveFromKitsuForward returns null for manga rows (item.type !== "anime")
// or when the response data is empty (unknown id → 200 + data:[] → tier miss).
async function resolveFromKitsuForward(
  parsed: { ns: string; value: string },
  http: HttpClient,
  remainingBudget: number
): Promise<AnimeIdentity | null> {
  // Budget floor check: skip tier if remaining < 200 ms
  if (remainingBudget < TIER_SKIP_FLOOR_MS) {
    return null;
  }

  const url = buildKitsuForwardUrl(parsed);

  const result = await http.getJson<KitsuMapping[]>(url.toString(), {
    timeoutMs: Math.min(KITSU_TIER_CAP_MS, remainingBudget),
    headers: {
      'Accept': 'application/vnd.api+json',
      'User-Agent': 'anicata-resolver/1.0',
    },
  });

  // HTTP errors are thrown by HttpClient; only 200 reaches here.
  // A 400-style body (e.g. `include=anime`) arrives without a `data` array —
  // that is a tier miss, never a throw, and never a wrong title.
  if (!Array.isArray(result.data)) {
    return null;
  }
  if (result.data.length === 0) {
    return null;
  }

  const mapping: unknown = result.data[0];
  const item = (mapping as { relationships?: { item?: { data?: { id?: string; type?: string } } } })
    .relationships?.item?.data;
  if (item === undefined) {
    return null;
  }

  // Manga rows: only item.type === "anime" may be accepted. Kitsu mixes manga
  // into mappings lookups (myanimelist/manga:1), so this check is mandatory.
  if (item.type !== 'anime' || item.id === undefined) {
    return null;
  }

  const kitsuId = item.id;

  return {
    anilist: Number(parsed.value),
    kitsu: kitsuId,
  };
}

// --- Tier 1: Kitsu reverse lookup (kitsu id → all external mappings) ---------

interface KitsuReverseMapping {
  id: string;
  type: string;
  attributes: {
    externalSite: string;
    externalId: string;
  };
}

async function resolveFromKitsuReverse(
  kitsuId: number,
  http: HttpClient,
  remainingBudget: number
): Promise<AnimeIdentity | null> {
  if (remainingBudget < TIER_SKIP_FLOOR_MS) {
    return null;
  }

  const url = buildKitsuReverseUrl(kitsuId);

  const { data: reverseData } = await http.getJson<KitsuReverseMapping[]>(url.toString(), {
    timeoutMs: Math.min(KITSU_TIER_CAP_MS, remainingBudget),
    headers: {
      'Accept': 'application/vnd.api+json',
      'User-Agent': 'anicata-resolver/1.0',
    },
  });

  // HTTP 200 with data; status check done by HttpClient

  // Dedupe TVB duplicate spellings on (site, value) and ignore aozora
  const seen = new Set<string>();
  const deduped: KitsuReverseMapping[] = [];

  for (const row of reverseData) {
    const { externalSite, externalId } = row.attributes;
    // Ignore aozora rows
    if (externalSite === 'aozora') continue;
    // Dedupe TVDB: both "thetvdb/series" and "thetvdb" with same id are (site,value) duplicates
    const dedupeKey = externalSite === 'thetvdb' ? 'thetvdb/series' : externalSite;
    const key = `${dedupeKey}:${externalId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }

  if (deduped.length === 0) {
    return null;
  }

  // Build AnimeIdentity from the first deduplicated reverse mapping
  const first = deduped[0];
  if (!first) return null;
  const site = first.attributes.externalSite;
  const id = first.attributes.externalId;

  switch (site) {
    case 'myanimelist/anime':
    case 'anilist/anime':
      return { anilist: Number(id) } as AnimeIdentity;
    case 'anidb':
      return { anidb: Number(id) } as AnimeIdentity;
    case 'thetvdb/series':
    case 'thetvdb':
      return { tvdb: Number(id) } as AnimeIdentity;
    case 'trakt':
      // carried but not resolved to a canonical field in this task
      return { kitsu: String(id) } as AnimeIdentity;
    default:
      // Unknown site → return null
      return null;
  }
}

// --- Main resolver ------------------------------------------------------------

export async function resolveToCanonical(
  input: string,
  http: HttpClient,
  bundle: BundleIndices,
  // The shared wall-clock deadline is passed in, exactly as `SourceChain` does
  // for source fallback. Defaulting it here would recreate the bug this
  // parameter exists to prevent: a hardcoded budget makes the tier-skip guard
  // unreachable, so the deadline is never honoured and the 5 s meta budget can
  // be blown from inside the identity path.
  remainingMs: number = IDENTITY_BUDGET_MS
): Promise<AnimeIdentity | null> {
  const remainingBudget = remainingMs;

  // --- Tier 0: Bundle lookup (in-memory, essentially 0 cost) ---
  const parsed = parseIncomingId(input);
  const bundleResult = tryResolveFromBundle(parsed, bundle);
  if (bundleResult) {
    return bundleResult;
  }

  // --- Tier 1: Kitsu live lookup ---
  // A tier is skipped unless at least TIER_SKIP_FLOOR_MS remains.
  if (remainingBudget < TIER_SKIP_FLOOR_MS) {
    return null;
  }

  // An unparseable input never reaches a tier: it resolves to nothing rather
  // than being forwarded with a bogus namespace.
  if (parsed === null) {
    return null;
  }

  // If we have a kitsu namespace, do a reverse lookup;
  // otherwise attempt a forward lookup from the parsed namespace.
  if (parsed.ns === 'kitsu') {
    const kitsuReverse = await resolveFromKitsuReverse(
      Number(parsed.value),
      http,
      remainingBudget,
    );
    if (kitsuReverse) return kitsuReverse;
  } else {
    const kitsuForward = await resolveFromKitsuForward(
      parsed,
      http,
      remainingBudget,
    );
    if (kitsuForward) return kitsuForward;
  }

  // Tiers 2–3 are stubbed to a clean miss (Task 7)
  return null;
}
