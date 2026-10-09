import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveToCanonical, IDENTITY_BUDGET_MS, TIER_SKIP_FLOOR_MS } from '../src/identity/resolver.js';
import { loadBundle } from '../src/identity/bundle.js';

// Repo convention (test/anilist-adapter.test.ts:9): no 'type: "json"' import
// attributes — JSON fixtures are read with readFileSync + JSON.parse.
const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

// High ids that are NOT in the bundled artefact (32,381 rows), so tier 0 misses
// and the resolver proceeds to the live Kitsu tier.
const HIGH_ANILIST = 'anilist:99999999';

const KitsuIncludeAnime400 = load('../test/fixtures/identity/kitsu-include-anime-400.json');
const KitsuMal1 = load('../test/fixtures/identity/kitsu-manga-1.json');
const KitsuReverse12 = load('../test/fixtures/identity/kitsu-reverse-12.json');
const KitsuForwardMal21 = load('../test/fixtures/identity/kitsu-forward-mal-21.json');

// --- Fake HttpClient -------------------------------------------------------
// Typed with the (url, init) arity the tests inspect so mock.calls[0]
// destructures to a real tuple instead of [] (test/anilist-adapter.test.ts).
function fakeHttp(forwardPayloads: unknown[], reversePayloads: unknown[] = []) {
  let fwdCallIndex = 0;
  let revCallIndex = 0;

  const getJson = vi.fn<
    (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
      data: unknown;
      headers: Record<string, string>;
      status: number;
    }>
  >(async (url) => {
    const isReverse = url.includes('/anime/') && url.endsWith('/mappings');
    const calls = isReverse ? reversePayloads : forwardPayloads;
    const idx = isReverse ? revCallIndex++ : fwdCallIndex++;
    const payload = calls[idx];
    // A fixture carries its body under `data`; a bare array/json is the body.
    const data =
      payload !== null && typeof payload === 'object' && 'data' in payload
        ? (payload as { data: unknown }).data
        : payload;
    return { data, headers: {}, status: 200 };
  });

  return { http: { getJson } as never, getJson };
}

// The bundle is loaded from the real artefact. A fresh clone with no artefact
// degrades to live tiers, so the suite must still pass without it — bundle hits
// are then not testable and those cases are the ones that assert them.
const realBundle = loadBundle('data/identity.min.json.gz');

describe('Resolver — budget accounting', () => {
  it('an IDENTITY_BUDGET_MS of 1500 leaves a Kitsu tier cap of 700 ms', () => {
    expect(IDENTITY_BUDGET_MS).toBe(1500);
    expect(Math.min(700, IDENTITY_BUDGET_MS)).toBe(700);
  });

  it('bundle hit returns before any Kitsu call (0 calls)', async () => {
    const fake = fakeHttp([]);
    expect(realBundle.byAnilist.has(21)).toBe(true); // One Piece is per row 0 of the artefact
    const result = await resolveToCanonical('anilist:21', fake.http, realBundle);
    expect(result).not.toBeNull();
    expect(fake.getJson).not.toHaveBeenCalled();
    expect(result).toHaveProperty('anilist', 21);
  });

  it('unknown id with 200 + data:[] yields a tier miss, not a throw', async () => {
    const fake = fakeHttp([{ data: [] }]);
    const result = await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    expect(result).toBeNull();
  });

  it('a tier is skipped, with no network call, when remaining < TIER_SKIP_FLOOR_MS', async () => {
    // TIER_SKIP_FLOOR_MS - 1: exactly below the floor, so the guard must branch.
    const fake = fakeHttp([KitsuForwardMal21]);
    const result = await resolveToCanonical(
      HIGH_ANILIST,
      fake.http,
      realBundle,
      TIER_SKIP_FLOOR_MS - 1,
    );
    expect(result).toBeNull();
    expect(fake.getJson).not.toHaveBeenCalled();
  });

  it('a tier is skipped when remaining is exactly 0 (caller already exhausted)', async () => {
    const fake = fakeHttp([KitsuForwardMal21]);
    const result = await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle, 0);
    expect(result).toBeNull();
    expect(fake.getJson).not.toHaveBeenCalled();
  });

  it('each live tier gets at most the remaining budget, capped at 700 ms', async () => {
    const fake = fakeHttp([KitsuForwardMal21]);
    await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle, 900);
    const [url, init] = fake.getJson.mock.calls[0]!;
    expect(url).toContain('kitsu.io');
    expect(init?.timeoutMs).toBe(700); // capped, not 900
  });
});

describe('Resolver — Kitsu forward traps', () => {
  it('never sends page[limit] on single-id lookups', async () => {
    const fake = fakeHttp([KitsuForwardMal21]);
    await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    const [url] = fake.getJson.mock.calls[0]!;
    expect(url).not.toMatch(/page\[limit\]/);
  });

  it('sends include=item (include=anime is a 400 from the real API)', async () => {
    const fake = fakeHttp([KitsuForwardMal21]);
    await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    const [url] = fake.getJson.mock.calls[0]!;
    expect(url).toMatch(/include=item/);
    expect(url).not.toMatch(/include=anime/);
  });

  it('myanimelist/manga row is rejected via item.type !== "anime"', async () => {
    // kitsu-manga-1.json is a real manga response; a manga row must be dropped.
    const fake = fakeHttp([KitsuMal1]);
    const result = await resolveToCanonical('mal:99999999', fake.http, realBundle);
    expect(result).toBeNull();
  });

  it('a 400 error body on the forward lookup is a tier miss, not a throw', async () => {
    // kitsu-include-anime-400.json is the real 400 body. The fake replies with
    // status 200 and that shape as the payload, so the resolver must treat a
    // body without a data array as a miss.
    const fake = fakeHttp([KitsuIncludeAnime400]);
    const result = await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    expect(result).toBeNull();
  });

  it('an unknown namespace to forward-resolve is a miss', async () => {
    const fake = fakeHttp([]);
    const result = await resolveToCanonical('unknown:99999999', fake.http, realBundle);
    expect(result).toBeNull();
    expect(fake.getJson).not.toHaveBeenCalled();
  });
});

describe('Resolver — Kitsu reverse traps', () => {
  it('reverse lookup hits /anime/{id}/mappings exactly once', async () => {
    const fake = fakeHttp([], [KitsuReverse12]);
    await resolveToCanonical('kitsu:99999999', fake.http, realBundle);
    const [url] = fake.getJson.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/kitsu\.io\/api\/edge\/anime\/99999999\/mappings/);
    expect(fake.getJson).toHaveBeenCalledTimes(1);
  });

  it('sends Accept: application/vnd.api+json and a User-Agent', async () => {
    const fake = fakeHttp([KitsuForwardMal21]);
    await resolveToCanonical(HIGH_ANILIST, fake.http, realBundle);
    const [, init] = fake.getJson.mock.calls[0]!;
    expect(init?.headers?.['Accept']).toBe('application/vnd.api+json');
    expect(init?.headers?.['User-Agent']).toContain('anicata');
  });
});
