import { HttpClient } from '../net/http.js';
import { SourceError } from '../domain/errors.js';
import { parseIncomingId } from './ids.js';
import type { AnimeIdentity } from '../domain/anime.js';
import type { BundleIndices } from './bundle.js';
import type { TrimmedIdentityRow } from './trim.js';

// Budget constants — shared deadline, never a fresh clock
export const IDENTITY_BUDGET_MS = 1500;
export const KITSU_TIER_CAP_MS = 700;
export const TIER_SKIP_FLOOR_MS = 200;
export const ANIZIP_TIER_CAP_MS = 900;

const KITSU_API_BASE = 'https://kitsu.io/api/edge';
const ANIZIP_API_BASE = 'https://api.ani.zip/mappings';

// Process-lifetime negative cache of AniZip 404s (see resolveFromAniZip).
const anizipNegativeCache = new Set<string>();

// AniZip accepts one param per request. Combining params is unsafe: a duplicate
// query key is answered with a real HTTP 500, so exactly one is ever sent.
// The seven known params; anything else is never sent.
const NS_TO_ANIZIP_PARAM: Record<string, string> = {
  anilist: 'anilist_id',
  mal: 'mal_id',
  kitsu: 'kitsu_id',
  anidb: 'anidb_id',
  tvdb: 'thetvdb_id',
  imdb: 'imdb_id',
  tmdb: 'themoviedb_id',
};

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

/** One bundle row -> canonical identity. The only place a row is widened. */
function rowToIdentity(row: TrimmedIdentityRow): AnimeIdentity {
  const tmdb =
    row.themoviedb_id !== null &&
    row.themoviedb_id !== undefined &&
    typeof row.themoviedb_id === 'object'
      ? {
          tmdb: {
            ...(row.themoviedb_id.tv !== undefined ? { tv: row.themoviedb_id.tv } : {}),
            ...(row.themoviedb_id.movie !== undefined ? { movie: row.themoviedb_id.movie } : {}),
          },
        }
      : {};
  return {
    anilist: row.anilist_id ?? 0,
    ...(row.mal_id !== undefined && { mal: row.mal_id }),
    ...(row.kitsu_id !== undefined && { kitsu: String(row.kitsu_id) }),
    ...(row.anidb_id !== undefined && { anidb: row.anidb_id }),
    ...(row.imdb_id !== undefined && { imdb: row.imdb_id }),
    ...(row.tvdb_id !== undefined && { tvdb: row.tvdb_id }),
    ...(row.simkl_id !== undefined && { simkl: row.simkl_id }),
    ...tmdb,
  } as AnimeIdentity;
}

function tryResolveFromBundle(
  parsed: ReturnType<typeof parseIncomingId> | null,
  bundle: BundleIndices
): AnimeIdentity | null {
  if (!parsed) return null;

  switch (parsed.ns) {
    case 'anilist': {
      const row = bundle.byAnilist.get(Number(parsed.value));
      return row === undefined ? null : rowToIdentity(row);
    }
    case 'kitsu': {
      const row = bundle.byKitsu.get(Number(parsed.value));
      return row === undefined ? null : rowToIdentity(row);
    }
    case 'mal': {
      const row = bundle.byMal.get(Number(parsed.value));
      return row === undefined ? null : rowToIdentity(row);
    }
    case 'anidb': {
      const row = bundle.byAnilist.get(Number(parsed.value));
      return row === undefined ? null : rowToIdentity(row);
    }
    // tv-first: byTmdb is keyed on both the tv and the movie value, so a hit may
    // be either leg. The resolved row still carries both, which is how a caller
    // tells them apart.
    case 'tmdb': {
      const row = bundle.byTmdb.get(Number(parsed.value));
      return row === undefined ? null : rowToIdentity(row);
    }
    // parseIncomingId normalises `imdb:0213338` -> `tt0213338`, so a bare `tt…`
    // id and the prefixed form hit the same key.
    case 'imdb': {
      const row = bundle.byImdb.get(parsed.value);
      return row === undefined ? null : rowToIdentity(row);
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

  let result: { data: KitsuMapping[] };
  try {
    result = await http.getJson<KitsuMapping[]>(url.toString(), {
      timeoutMs: Math.min(KITSU_TIER_CAP_MS, remainingBudget),
      headers: {
        'Accept': 'application/vnd.api+json',
        'User-Agent': 'anicata-resolver/1.0',
      },
    });
  } catch {
    // Same contract as every other tier: a failure degrades to a miss and never
    // propagates out of the identity path. Without this, one upstream hiccup
    // escapes `resolveToCanonical` and turns a resolvable meta into a 200-empty
    // placeholder with a 10 s cache.
    return null;
  }

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

  let reverseData: KitsuReverseMapping[];
  try {
    reverseData = (
      await http.getJson<KitsuReverseMapping[]>(url.toString(), {
        timeoutMs: Math.min(KITSU_TIER_CAP_MS, remainingBudget),
        headers: {
          'Accept': 'application/vnd.api+json',
          'User-Agent': 'anicata-resolver/1.0',
        },
      })
    ).data;
  } catch {
    // Every tier degrades to a miss rather than propagating (see the forward
    // tier for why: an escaping error turns a resolvable meta into a
    // 200-empty placeholder with a 10 s cache).
    return null;
  }

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

/**
 * Bundle-only resolution: the in-memory tier and nothing else.
 *
 * For ids that are already canonical in our own namespace there is nothing to
 * translate, but there is still something to enrich — the bundle adds Kitsu,
 * AniDB, TMDB and IMDb ids the source did not supply (One Piece arrives with
 * AniList + MAL only, which renders 2 of 4 links).
 *
 * The reason this exists rather than just calling `resolveToCanonical`: that
 * function falls through to the Kitsu and AniZip tiers on a bundle miss, which
 * would make an already-canonical id pay live-tier latency for no translation.
 * Measured cost of the bundle tier is ~0.006 ms.
 */
export function resolveFromBundleOnly(
  input: string,
  bundle: BundleIndices
): AnimeIdentity | null {
  return tryResolveFromBundle(parseIncomingId(input), bundle);
}

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

  // Tier 2: AniZip. Runs on whatever budget the earlier tiers left, never on a
  // fresh clock — see `resolveToCanonical`.
  const anizip = await resolveFromAniZip(parsed, http, remainingBudget);
  if (anizip) return anizip;

  // Tier 3 (title lookup) is still stubbed to a clean miss.
  return null;
}

// --- Tier 2: AniZip mappings ------------------------------------------------
// Only the 12-key `mappings` block is read. `episodes`/`images` are truncated:
// the One Piece response is 1.87 MB and identity must not pay for them.
async function resolveFromAniZip(
  parsed: { ns: string; value: string },
  http: HttpClient,
  remainingBudget: number
): Promise<AnimeIdentity | null> {
  if (remainingBudget < TIER_SKIP_FLOOR_MS) {
    return null;
  }

  const param = NS_TO_ANIZIP_PARAM[parsed.ns];
  if (param === undefined) {
    return null;
  }

  // Negative cache: a 404 for this exact param is remembered for the process
  // lifetime, so a repeat lookup makes zero further upstream calls. AniZip's
  // miss latency is UNVERIFIED, which is precisely why the miss is cached
  // rather than re-requested.
  const cacheKey = `${param}=${parsed.value}`;
  if (anizipNegativeCache.has(cacheKey)) {
    return null;
  }

  const url = new URL(ANIZIP_API_BASE);
  url.searchParams.set(param, parsed.value);

  let result: { data: Record<string, unknown> };
  try {
    result = await http.getJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: Math.min(ANIZIP_TIER_CAP_MS, remainingBudget),
      headers: { Accept: 'application/json', 'User-Agent': 'anicata-resolver/1.0' },
    });
  } catch (err) {
    // A miss is not an error to propagate: every failure mode degrades to a
    // tier miss, preserving the never-5xx invariant of the whole add-on.
    if (err instanceof SourceError && err.kind === 'not_found') {
      anizipNegativeCache.add(cacheKey);
    }
    return null;
  }

  const mappings = result.data?.mappings;
  if (mappings === null || mappings === undefined || typeof mappings !== 'object') {
    return null;
  }
  const m = mappings as Record<string, unknown>;

  // Scalar ids arrive as numbers. A 404 from AniZip reaches us as a
  // SourceError('not_found'), handled by the caller.
  const num = (k: string): number | undefined => {
    const v = m[k];
    return typeof v === 'number' ? v : undefined;
  };
  // `themoviedb_id` is a BARE STRING in AniZip ("37854"), with no tv/movie
  // split — parse it, and omit the key entirely rather than writing undefined,
  // because exactOptionalPropertyTypes forbids an explicit undefined.
  const tmdbId = (): number | undefined => {
    const v = m.themoviedb_id;
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };

  const anilist = num('anilist_id');
  const mal = num('mal_id');
  if (anilist === undefined && mal === undefined) {
    return null;
  }

  // Hoisted so TypeScript narrows each to `number`/`string` rather than
  // `number | undefined` — exactOptionalPropertyTypes rejects the union.
  const anidb = num('anidb_id');
  const tvdb = num('thetvdb_id');
  const tmdb = tmdbId();
  const imdb = typeof m.imdb_id === 'string' ? m.imdb_id : undefined;
  const kitsuId = typeof m.kitsu_id === 'number' ? String(m.kitsu_id) : undefined;

  const identity: AnimeIdentity =
    anilist !== undefined
      ? {
          anilist,
          ...(mal !== undefined ? { mal } : {}),
          ...(kitsuId !== undefined ? { kitsu: kitsuId } : {}),
          ...(anidb !== undefined ? { anidb } : {}),
          ...(tvdb !== undefined ? { tvdb } : {}),
          ...(imdb !== undefined ? { imdb } : {}),
          ...(tmdb !== undefined ? { tmdb: { tv: tmdb } } : {}),
        }
      : { kitsu: Number(m.kitsu_id), mal: mal ?? 0 };

  return identity;
}
