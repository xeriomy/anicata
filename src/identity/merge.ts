import type { AnimeIdentity } from '../domain/anime.js';

/**
 * Overlays a resolved identity onto the identity a source supplied.
 *
 * The asymmetry is the whole point: the **source owns the canonical id**
 * (`anilist:` or `kitsu:`), and the resolved tier only ever fills namespaces
 * the source was missing. The resolver runs over a static bundle plus two
 * community APIs, so a confidently wrong row there must not be able to
 * re-point a title — that is how one bad mapping silently serves the wrong
 * anime forever.
 *
 * Returns the source identity unchanged when there is nothing to merge.
 */
export function mergeIdentity(
  source: AnimeIdentity,
  resolved: AnimeIdentity | null,
): AnimeIdentity {
  if (resolved === null) return source;

  // `kitsu` is a string on the anilist branch and a number on the Kitsu-only
  // branch (ADR-016). Compare by value, never by shape.
  const canonicalOf = (id: AnimeIdentity): 'anilist' | 'kitsu' | undefined =>
    id.anilist !== undefined ? 'anilist' : id.kitsu !== undefined ? 'kitsu' : undefined;

  const sourceCanonical = canonicalOf(source);
  const resolvedCanonical = canonicalOf(resolved);

  // Different canonical namespaces means the tiers disagree about which title
  // this is. Trust the source outright and adopt nothing.
  if (sourceCanonical !== resolvedCanonical) return source;

  const kitsuSource = source.kitsu !== undefined ? String(source.kitsu) : undefined;
  const kitsuResolved = resolved.kitsu !== undefined ? String(resolved.kitsu) : undefined;

  const imdbSource = 'imdb' in source ? source.imdb : undefined;
  const imdbResolved = 'imdb' in resolved ? resolved.imdb : undefined;

  const anidbSource = 'anidb' in source ? source.anidb : undefined;
  const anidbResolved = 'anidb' in resolved ? resolved.anidb : undefined;

  const tvdbSource = 'tvdb' in source ? source.tvdb : undefined;
  const tvdbResolved = 'tvdb' in resolved ? resolved.tvdb : undefined;

  const simklSource = 'simkl' in source ? source.simkl : undefined;
  const simklResolved = 'simkl' in resolved ? resolved.simkl : undefined;

  const malSource = source.mal;
  const malResolved = resolved.mal;

  // `tmdb`/`imdb`/`anidb`/`tvdb`/`simkl` live on the anilist branch of the
  // union; the Kitsu-only branch cannot carry them, so narrow with `in`.
  const tmdbSource = 'tmdb' in source ? source.tmdb : undefined;
  const tmdbResolved = 'tmdb' in resolved ? resolved.tmdb : undefined;

  const merged: AnimeIdentity = {
    ...(malSource !== undefined ? { mal: malSource } : malResolved !== undefined ? { mal: malResolved } : {}),
    ...(anidbSource !== undefined ? { anidb: anidbSource } : anidbResolved !== undefined ? { anidb: anidbResolved } : {}),
    ...(tvdbSource !== undefined ? { tvdb: tvdbSource } : tvdbResolved !== undefined ? { tvdb: tvdbResolved } : {}),
    ...(simklSource !== undefined ? { simkl: simklSource } : simklResolved !== undefined ? { simkl: simklResolved } : {}),
    ...(tmdbSource !== undefined ? { tmdb: tmdbSource } : tmdbResolved !== undefined ? { tmdb: tmdbResolved } : {}),
    ...(imdbSource !== undefined ? { imdb: imdbSource } : imdbResolved !== undefined ? { imdb: imdbResolved } : {}),
  } as AnimeIdentity;

  // The canonical id, and the source's own kitsu, are applied last so neither
  // the string coercion above nor the resolved tier can displace them.
  if (sourceCanonical === 'kitsu') {
    return { ...merged, kitsu: source.kitsu } as AnimeIdentity;
  }
  return {
    ...merged,
    anilist: source.anilist as number,
    ...(kitsuSource !== undefined ? { kitsu: kitsuSource } : kitsuResolved !== undefined ? { kitsu: kitsuResolved } : {}),
  } as AnimeIdentity;
}
