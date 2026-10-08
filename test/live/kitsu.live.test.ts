import { describe, expect, it } from 'vitest';
import { KitsuSource } from '../../src/sources/kitsu/adapter.js';
import { HttpClient } from '../../src/net/http.js';
import { TokenBucket } from '../../src/net/limiter.js';

// Opt-in only: `npm test` stays offline. Run once with
// `ANICATA_LIVE=1 npx vitest run --dir test/live` (the trending page below
// costs 5 Kitsu requests after the page[limit]=20 cap stitching, plus 1 for
// search; combined with the AniList file the suite makes roughly 12 requests
// total — do not add more tests here).
const live = process.env.ANICATA_LIVE === '1' ? describe : describe.skip;

live('Kitsu live smoke', () => {
  const mk = () =>
    new KitsuSource({
      http: new HttpClient({ timeoutMs: 8000, userAgent: 'anicata-anime-addon/0.1' }),
      limiter: new TokenBucket({ capacity: 20, refillPerMinute: 20 }),
    });

  it('serves a parsed trending page via the -userCount proxy', async () => {
    // Kitsu has no trending sort (verified 2026-10-07: `trending`,
    // `recently_popular`, `relevance`, `title` and `favorites` all 400), so
    // the trending catalogue is deliberately proxied onto most-favorited.
    // Items back with kitsu ids and non-blank titles proves reachability,
    // parsing, and the proxy in one request.
    //
    // The limit is deliberately the production 100, not a tidy 10: Kitsu caps
    // page[limit] at 20 (measured live 2026-10-08: limit=21 -> 400), so only
    // a limit above 20 exercises the internal stitching the catalogue path
    // depends on. A limit of 10 passed while catalogues were broken.
    const r = await mk().fetchPage({ catalogId: 'anime-trending', skip: 0, limit: 100 });
    expect(r.items).toHaveLength(100);
    expect(r.items[0]!.identity.kitsu).toBeTypeOf('number');
    expect(r.items[0]!.displayTitle.trim()).not.toBe('');
  }, 30_000);

  it('filter[text]= search returns results', async () => {
    const r = await mk().search('Cowboy Bebop', 0, 5);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.identity.kitsu).toBeTypeOf('number');
  }, 20_000);
});
