export interface TrimmedIdentityRow {
  anilist_id?: number;
  mal_id?: number;
  kitsu_id?: number;
  anidb_id?: number;
  tvdb_id?: number;
  imdb_id?: string;
  themoviedb_id?: { tv?: number; movie?: number };
  simkl_id?: number;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function trimIdentityRow(raw: unknown): TrimmedIdentityRow | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const row = raw as Record<string, unknown>;

  const out: Record<string, unknown> = {};

  // Scalar ids: keep only if positive integer
  // anilist_id, mal_id, kitsu_id, anidb_id, tvdb_id, simkl_id
  const scalarKeys = ['anilist_id', 'mal_id', 'kitsu_id', 'anidb_id', 'tvdb_id', 'simkl_id'] as const;
  for (const key of scalarKeys) {
    if (key in row) {
      const val: unknown = (row as Record<string, unknown>)[key];
      if (isPositiveInt(val)) {
        out[key] = val;
      }
    }
  }

  // imdb_id: raw is an array; take [0], keep only if /^tt\d+$/
  if ('imdb_id' in row) {
    const imdbArray = (row as Record<string, unknown>).imdb_id;
    if (Array.isArray(imdbArray) && imdbArray.length > 0) {
      const first = imdbArray[0];
      if (typeof first === 'string' && /^tt\d+$/.test(first)) {
        out.imdb_id = first;
      }
    }
  }

  // themoviedb_id: raw is an object; keep tv if positive integer;
  // keep movie as first element of array, only if positive integer
  if ('themoviedb_id' in row) {
    const tmdb = (row as Record<string, unknown>).themoviedb_id;
    if (tmdb !== null && typeof tmdb === 'object') {
      const tmdbOut: Record<string, unknown> = {};

      // tv: if positive integer
      if ('tv' in tmdb) {
        const tvVal = (tmdb as Record<string, unknown>).tv;
        if (isPositiveInt(tvVal)) {
          tmdbOut.tv = tvVal;
        }
      }

      // movie: first element of array, only if positive integer
      if ('movie' in tmdb) {
        const movieVal = (tmdb as Record<string, unknown>).movie;
        if (Array.isArray(movieVal) && movieVal.length > 0) {
          const first = movieVal[0];
          if (isPositiveInt(first)) {
            tmdbOut.movie = first;
          }
        }
      }

      // only add themoviedb_id if we have at least one sub-key
      if (Object.keys(tmdbOut).length > 0) {
        out.themoviedb_id = tmdbOut as { tv?: number; movie?: number };
      }
    }
  }

  // Rule 5: return null unless anilist_id or mal_id survived
  if (!(('anilist_id' in out) || ('mal_id' in out))) {
    return null;
  }

  return out as TrimmedIdentityRow;
}