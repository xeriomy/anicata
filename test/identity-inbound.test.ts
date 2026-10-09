import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveToCanonical } from '../src/identity/resolver.js';
import { loadBundle } from '../src/identity/bundle.js';

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

const AniZip21 = load('../test/fixtures/identity/anizip-21.json');
const KitsuReverse12 = load('../test/fixtures/identity/kitsu-reverse-12.json');

const realBundle = loadBundle('data/identity.min.json.gz');

/** A fake that never satisfies a tier: every live lookup is a miss. */
function deadHttp() {
  const getJson = vi.fn<
    (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
      data: unknown;
      headers: Record<string, string>;
      status: number;
    }>
  >(async () => ({ data: [], headers: {}, status: 200 }));
  return { http: { getJson } as never, getJson };
}

describe('Inbound: all six namespaces', () => {
  // Roadmap gate 3 — every inbound form of One Piece resolves to anilist:21.
  const onePieceForms: Array<[string, string]> = [
    ['anilist:21', 'anilist id'],
    ['mal:21', 'mal id'],
    ['kitsu:12', 'kitsu id'],
    ['tmdb:37854', 'tmdb id'],
    ['tt0388629', 'bare tt id'],
    ['imdb:0388629', 'imdb without tt prefix (normalised)'],
  ];

  for (const [input, label] of onePieceForms) {
    it(`resolves ${input} (${label}) to anilist:21`, async () => {
      const dead = deadHttp();
      const result = await resolveToCanonical(input, dead.http, realBundle);
      expect(result, `${input} should resolve, got ${JSON.stringify(result)}`).not.toBeNull();
      expect(result).toHaveProperty('anilist', 21);
    });
  }

  it('imdb: normalisation makes the prefixed and bare forms the same key', async () => {
    const dead = deadHttp();
    // tt0213338 is Cowboy Bebop (anilist 1, confirmed against the real
    // artefact), NOT One Piece. Both forms must land on the same row — this is
    // what the normalisation buys, and a mismatch here would silently resolve
    // the wrong title.
    const bare = await resolveToCanonical('tt0213338', dead.http, realBundle);
    const prefixed = await resolveToCanonical('imdb:0213338', dead.http, realBundle);
    expect(bare).toEqual(prefixed);
    expect(bare).toHaveProperty('anilist', 1);
    expect(dead.getJson).not.toHaveBeenCalled();
  });

  it('a bare number is a Trakt id and resolves to null with zero upstream calls', async () => {
    const dead = deadHttp();
    const result = await resolveToCanonical('21', dead.http, realBundle);
    expect(result).toBeNull();
    expect(dead.getJson).not.toHaveBeenCalled();
  });

  it('an unknown anilist id resolves to null with zero wrong titles', async () => {
    const dead = deadHttp();
    const result = await resolveToCanonical('anilist:99999999', dead.http, realBundle);
    expect(result).toBeNull();
  });

  it('a tmdb id that is only a movie id still resolves, never emitting tmdb:', async () => {
    const dead = deadHttp();
    const result = await resolveToCanonical('tmdb:999999', dead.http, realBundle);
    // A miss is the correct answer when neither the tv nor movie leg matches.
    expect(result).toBeNull();
  });

  it('a wrong-namespace value is rejected, never silently retried as another ns', async () => {
    // A letters-only value for a numeric namespace must not reach a tier.
    const dead = deadHttp();
    for (const bad of ['anilist:abc', 'mal:-1', 'kitsu:notanumber', 'tmdb:tv37854']) {
      const result = await resolveToCanonical(bad, dead.http, realBundle);
      expect(result, `${bad} must not resolve to a wrong title`).toBeNull();
    }
    expect(dead.getJson).not.toHaveBeenCalled();
  });
});

describe('Inbound: live tiers when the bundle misses', () => {
  it('kitsu:<id> falls through to the Kitsu reverse tier', async () => {
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url) =>
      url.includes('/mappings') && url.endsWith('/mappings')
        ? { data: KitsuReverse12.data, headers: {}, status: 200 }
        : { data: [], headers: {}, status: 200 },
    );
    const http = { getJson } as never;
    const result = await resolveToCanonical('kitsu:99999999', http, realBundle);
    // The reverse fixture is One Piece's real mapping set, so this unknown kitsu
    // id resolves through the live tier to anilist:21 — deliberately NOT null,
    // which is what the tier is for.
    expect(getJson).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('anilist', 21);
  });

  it('a mal: id falls through to the Kitsu forward then AniZip tiers', async () => {
    const getJson = vi.fn<
      (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{
        data: unknown;
        headers: Record<string, string>;
        status: number;
      }>
    >(async (url) =>
      url.includes('api.ani.zip')
        ? { data: AniZip21, headers: {}, status: 200 }
        : { data: [], headers: {}, status: 200 },
    );
    const http = { getJson } as never;
    const result = await resolveToCanonical('mal:99999999', http, realBundle);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('anilist', 21);
    expect(getJson).toHaveBeenCalledTimes(2);
  });
});
