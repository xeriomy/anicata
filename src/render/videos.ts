import type { StremioMetaVideo } from './types.js';

/**
 * Turns AniZip's `episodes` block into Nuvio's `videos[]` (spec §8, roadmap
 * Phase 4).
 *
 * Pure: no clock, no network, no logging. Everything it needs arrives in the
 * two arguments, so a malformed capture can only ever produce a shorter list.
 *
 * Three rules that come from the real One Piece capture rather than from the
 * AniZip schema:
 *
 *  1. **A row is only emitted if it has both a season and an episode number.**
 *     The capture carries 48 rows with neither — a title and a length, no
 *     placement. Emitting them would put a null-season entry in the list whose
 *     `id` collides with every other null-season row, so they are skipped.
 *
 *  2. **The id carries the row's own key, not `season:episode`.** 30
 *     (season, episode) pairs in this capture occur twice, because TVDB holds
 *     two English dub titles for one episode. An id built from the placement
 *     would merge two different episodes into one UI entry; the row key is
 *     unique by construction.
 *
 *  3. **Numbering is per season, never absolute.** Absolute 34 is season 3
 *     episode 4 here. Nuvio groups `videos[]` by the `season` field, so
 *     collapsing to absolute numbers would move whole blocks of episodes into
 *     the wrong season.
 */
export function videosFromEpisodes(
  stremioId: string,
  episodes: unknown,
): StremioMetaVideo[] {
  if (typeof episodes !== 'object' || episodes === null || Array.isArray(episodes)) {
    return [];
  }

  const out: StremioMetaVideo[] = [];

  for (const [key, raw] of Object.entries(episodes as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;

    // Reality check before trusting either: AniZip writes `null`, not
    // `undefined`, for the unplaced rows, and `typeof null === 'object'`.
    const season = row.seasonNumber;
    const episode = row.episodeNumber;
    if (typeof season !== 'number' || !Number.isInteger(season)) continue;
    if (typeof episode !== 'number' || !Number.isInteger(episode)) continue;

    const title = pickTitle(row.title) ?? `Episode ${episode}`;
    const released = nonEmptyString(row.airDate);
    const thumbnail = nonEmptyString(row.image);
    const overview = nonEmptyString(row.overview);
    const runtime = minutes(row.runtime) ?? minutes(row.length) ?? 0;

    out.push({
      id: `${stremioId}:${key}`,
      title,
      season,
      episode,
      runtime,
      ...(released !== undefined ? { released } : {}),
      ...(thumbnail !== undefined ? { thumbnail } : {}),
      ...(overview !== undefined ? { overview } : {}),
    });
  }

  // Sorted in the render layer, not relied upon from the capture: AniZip's keys
  // are a mix of absolute numbers and `S`-prefixed specials, which sorts as
  // text and would interleave seasons.
  out.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  return out;
}

/**
 * English, then Japanese, then nothing. The caller supplies a labelled
 * fallback: a real, numbered episode with no title in either language is
 * still an episode, and inventing a title for it would be worse than
 * labelling it.
 */
function pickTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const titles = raw as Record<string, unknown>;
  // `{ en: null }` is what AniZip writes for an untitled row, so truthiness is
  // the test here rather than presence.
  const en = nonEmptyString(titles.en);
  if (en !== undefined) return en;
  return nonEmptyString(titles.ja);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function minutes(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
