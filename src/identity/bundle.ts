import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createLogger } from '../util/logger.js';
import type { TrimmedIdentityRow } from './trim.js';

const log = createLogger('warn');

export interface BundleIndices {
  byAnilist: Map<number, TrimmedIdentityRow>;
  byMal: Map<number, TrimmedIdentityRow>;
  byKitsu: Map<number, TrimmedIdentityRow>;
  byTmdb: Map<number, TrimmedIdentityRow>;
  byImdb: Map<string, TrimmedIdentityRow>;
  rowCount: number; // total rows in the artefact
}

export function loadBundle(path: string): BundleIndices {
  const indices: BundleIndices = {
    byAnilist: new Map(),
    byMal: new Map(),
    byKitsu: new Map(),
    byTmdb: new Map(),
    byImdb: new Map(),
    rowCount: 0,
  };

  try {
    const raw = readFileSync(path);
    if (!raw.length) {
      log.warn('Bundle file is empty', { path });
      return indices;
    }
    const gunzipped = gunzipSync(raw);
    const parsed = JSON.parse(gunzipped.toString());

    if (!parsed.rows || !Array.isArray(parsed.rows)) {
      log.error('Bundle has no valid rows', { path });
      return indices;
    }

    indices.rowCount = parsed.rows.length;

    for (const row of parsed.rows) {
      // byAnilist
      if (row.anilist_id !== undefined && typeof row.anilist_id === 'number') {
        indices.byAnilist.set(row.anilist_id, row);
      }

      // byMal
      if (row.mal_id !== undefined && typeof row.mal_id === 'number') {
        indices.byMal.set(row.mal_id, row);
      }

      // byKitsu
      if (row.kitsu_id !== undefined && typeof row.kitsu_id === 'number') {
        indices.byKitsu.set(row.kitsu_id, row);
      }

      // byTmdb: key on both tv and movie values
      if (row.themoviedb_id !== null && typeof row.themoviedb_id === 'object') {
        const tmdb = row.themoviedb_id as { tv?: number; movie?: number };
        if (tmdb.tv !== undefined && typeof tmdb.tv === 'number') {
          indices.byTmdb.set(tmdb.tv, row);
        }
        if (tmdb.movie !== undefined && typeof tmdb.movie === 'number') {
          indices.byTmdb.set(tmdb.movie, row);
        }
      }

      // byImdb: key every element; imdb_id may be string or [string, ...]
      const imdbIds = row.imdb_id;
      if (typeof imdbIds === 'string') {
        indices.byImdb.set(imdbIds, row);
      } else if (Array.isArray(imdbIds)) {
        for (const id of imdbIds) {
          if (typeof id === 'string') {
            indices.byImdb.set(id, row);
          }
        }
      }
    }
  } catch (e: unknown) {
    log.error('Failed to load bundle, degrading to live tiers', {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    // indices remain empty — degradation, never throw
  }

  return indices;
}

export function hasBundleRows(indices: BundleIndices): boolean {
  return (
    indices.byAnilist.size > 0 ||
    indices.byMal.size > 0 ||
    indices.byKitsu.size > 0 ||
    indices.byTmdb.size > 0 ||
    indices.byImdb.size > 0
  );
}