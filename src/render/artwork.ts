/**
 * Picks a logo and a backdrop out of a TMDB `/tv/{id}/images` response.
 *
 * Pure: no clock, no network, no logging, so a malformed capture can only ever
 * produce an empty result rather than an exception.
 *
 * Two policies are driven by what the real captures show rather than by what
 * TMDB documents:
 *
 *  1. **SVGs are filtered out.** Two of One Piece's 36 logos are `.svg`. TMDB's
 *     image CDN serves them at any requested size, but the bytes are unchanged
 *     vector data — an SVG in Nuvio's `logo` slot cannot be scaled the way a
 *     raster is and is a rendering risk. Filtered even when it is the only
 *     entry for a language.
 *
 *  2. **Language preference is `en` → `ja` → any, applied BEFORE the vote
 *     ranking.** For One Piece the best `en` logo is 1277x443 at vote_average
 *     8.362 while the best `ja` raster is 618x228 at 3.334, so preferring `ja`
 *     would hand the client a visibly worse title card. `ja` is second because
 *     a Japanese title card is the better fallback for a Japanese title, and
 *     anything at all beats nothing. Phase 8's `/configure` page can turn this
 *     into a real user preference.
 */

export interface TmdbArtwork {
  logo?: string;
  backdrop?: string;
}

const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Logo size: wide enough to stay sharp on a high-density display. */
const LOGO_SIZE = 'w500';
/** Backdrop size: Nuvio renders these as wide banners. */
const BACKDROP_SIZE = 'w1280';

/** Raster formats only, per policy 1. */
const RASTER = ['.png', '.jpg', '.jpeg'];

const LANGUAGE_PREFERENCE = ['en', 'ja'];

export function pickArtwork(images: unknown): TmdbArtwork {
  if (typeof images !== 'object' || images === null || Array.isArray(images)) return {};
  const body = images as Record<string, unknown>;
  const logos = pickLogo(body.logos);
  const backdrops = pickBackdrop(body.backdrops);
  return {
    ...(logos !== undefined ? { logo: logos } : {}),
    ...(backdrops !== undefined ? { backdrop: backdrops } : {}),
  };
}

function pickLogo(raw: unknown): string | undefined {
  const entries = rasterEntries(raw);
  if (entries.length === 0) return undefined;

  // Language preference first, then vote, then size.
  for (const lang of LANGUAGE_PREFERENCE) {
    const found = bestIn(entries.filter((e) => e.iso === lang));
    if (found !== undefined) return url(LOGO_SIZE, found.path);
  }
  const any = bestIn(entries);
  return any === undefined ? undefined : url(LOGO_SIZE, any.path);
}

function pickBackdrop(raw: unknown): string | undefined {
  const entries = rasterEntries(raw);
  const best = bestIn(entries);
  return best === undefined ? undefined : url(BACKDROP_SIZE, best.path);
}

/** Vote average, then width — both are `null` in real captures, so coerce. */
function bestIn(entries: ImageEntry[]): ImageEntry | undefined {
  let best: ImageEntry | undefined;
  for (const e of entries) {
    if (best === undefined) {
      best = e;
      continue;
    }
    if (e.vote > best.vote || (e.vote === best.vote && e.width > best.width)) best = e;
  }
  return best;
}

interface ImageEntry {
  iso: string | undefined;
  path: string;
  vote: number;
  width: number;
}

/** Keeps only well-formed raster entries; everything else is invisible. */
function rasterEntries(raw: unknown): ImageEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const path = e.file_path;
    if (typeof path !== 'string' || path === '') continue;
    const lower = path.toLowerCase();
    if (!RASTER.some((ext) => lower.endsWith(ext))) continue;
    out.push({
      iso: typeof e.iso_639_1 === 'string' ? e.iso_639_1 : undefined,
      path,
      vote: typeof e.vote_average === 'number' && Number.isFinite(e.vote_average) ? e.vote_average : 0,
      width: typeof e.width === 'number' && Number.isFinite(e.width) ? e.width : 0,
    });
  }
  return out;
}

function url(size: string, path: string): string {
  return path.startsWith('/') ? `${IMAGE_BASE}/${size}${path}` : `${IMAGE_BASE}/${size}/${path}`;
}
