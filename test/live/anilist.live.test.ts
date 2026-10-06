import { describe, expect, it } from 'vitest';
import { AniListSource } from '../../src/sources/anilist/adapter.js';
import { HttpClient } from '../../src/net/http.js';
import { TokenBucket } from '../../src/net/limiter.js';

// Opt-in only: `npm test` stays offline. Run once with
// `ANICATA_LIVE=1 npx vitest run --dir test/live` (~4 AniList requests,
// well under the 30 req/min live limit — do not add more tests here).
const live = process.env.ANICATA_LIVE === '1' ? describe : describe.skip;

live('AniList live smoke', () => {
  const mk = () =>
    new AniListSource({
      http: new HttpClient({ timeoutMs: 8000, userAgent: 'anicata-anime-addon/0.1' }),
      limiter: new TokenBucket({ capacity: 20, refillPerMinute: 20 }),
    });

  it('serves a catalogue page and clamps perPage to 50', async () => {
    // AniList silently clamps perPage to 50, so asking for 100 still yields
    // at most 50 items in one request.
    const r = await mk().fetchCatalogPage({ sort: ['TRENDING_DESC'], page: 1, perPage: 100 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(50);
    expect(r.items[0]!.identity.anilist).toBeTypeOf('number');
    expect(r.items[0]!.displayTitle.trim()).not.toBe('');
  }, 20_000);

  it('fetches One Piece and returns id 21', async () => {
    const a = await mk().fetchById(21);
    expect(a!.identity.anilist).toBe(21);
    expect(a!.identity.mal).toBe(21);
  }, 20_000);

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await mk().fetchById(99999999)).toBeNull();
  }, 20_000);

  it('still reports the current rate limit of 30/min', async () => {
    const http = new HttpClient({ userAgent: 'anicata-anime-addon/0.1' });
    const r = await http.getJson<Record<string, never>>('https://graphql.anilist.co', {
      method: 'POST',
      body: JSON.stringify({ query: '{__typename}' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(Number(r.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    // 2026-10-04: 30. Raise to 90+ when AniList's degraded state ends.
    console.log('anilist x-ratelimit-limit =', r.headers['x-ratelimit-limit']);
  }, 20_000);
});
