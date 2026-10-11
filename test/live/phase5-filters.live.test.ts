import { describe, expect, it } from 'vitest';
import { AniListSource } from '../../src/sources/anilist/adapter.js';
import { HttpClient } from '../../src/net/http.js';
import { TokenBucket } from '../../src/net/limiter.js';
import { parseSeasonalCatalogId, seasonalCatalogId } from '../../src/sources/catalog-def.js';

// Opt-in only: `npm test` stays offline. Run with `ANICATA_LIVE=1 npm run
// test:live` (4 requests here + 5 in anilist.live.test.ts = 9 AniList
// requests total — under the 30 req/min live limit — do not add more tests
// here). Each test below is deliberately ONE upstream request.
const live = process.env.ANICATA_LIVE === '1' ? describe : describe.skip;

live('AniList phase 5 filter smoke', () => {
  const mk = () =>
    new AniListSource({
      http: new HttpClient({ timeoutMs: 8000, userAgent: 'anicata-anime-addon/0.1' }),
      limiter: new TokenBucket({ capacity: 20, refillPerMinute: 20 }),
    });

  it('anime-airing returns only RELEASING titles', async () => {
    // The status filter must apply UPSTREAM (AniList's `status:$status`),
    // not in our adapter — that is the whole point of the descriptor.
    const r = await mk().fetchPage({ catalogId: 'anime-airing', skip: 0, limit: 50 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.status === 'RELEASING')).toBe(true);
  }, 20_000);

  it('anime-movies returns only MOVIE titles', async () => {
    const r = await mk().fetchPage({ catalogId: 'anime-movies', skip: 0, limit: 50 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.format === 'MOVIE')).toBe(true);
  }, 20_000);

  it('anime-genres with genre=Action returns only Action titles', async () => {
    // Genre is a real filter for the first time: `$genre` is declared AND
    // wired into media(...), so AniList applies it (docs/data-sources.md
    // §1.3.1 trap 2 records the silent unfiltered page of the old query).
    const r = await mk().fetchPage({ catalogId: 'anime-genres', skip: 0, limit: 50, genre: 'Action' });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.genres.includes('Action'))).toBe(true);
  }, 20_000);

  it('the current seasonal catalogue returns only its season pair', async () => {
    const id = seasonalCatalogId();
    const pair = parseSeasonalCatalogId(id);
    if (pair === undefined) {
      throw new Error(`seasonalCatalogId() produced an unparsable id: ${id}`);
    }
    const r = await mk().fetchPage({ catalogId: id, skip: 0, limit: 50 });
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      expect(item.season).toBe(pair.season.toUpperCase());
      expect(item.seasonYear).toBe(pair.year);
    }
  }, 20_000);
});
