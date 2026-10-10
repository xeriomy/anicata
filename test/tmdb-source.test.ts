import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TmdbArtworkSource } from '../src/sources/tmdb/source.js';
import type { HttpClient } from '../src/net/http.js';
import type { AnimeIdentity } from '../src/domain/anime.js';
import { SourceError } from '../src/domain/errors.js';

const capture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/identity/${name}`, import.meta.url), 'utf8'));

const ONE_PIECE_IMAGES = capture('tmdb-images-37854.json');
const ONE_PIECE_FIND = capture('tmdb-find-onepiece-tvdb.json');
const BEBOP_FIND = capture('tmdb-find-bebop-tvdb.json');
const FIND_MISS = capture('tmdb-find-miss.json');

const KEY = 'test-key-not-real';

interface Call {
  url: string;
  timeoutMs: number | undefined;
  headers: Record<string, string> | undefined;
}

function httpFor(routes: Record<string, unknown>): HttpClient & { calls: Call[] } {
  const calls: Call[] = [];
  const getJson = vi.fn(async (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => {
    calls.push({ url, timeoutMs: init?.timeoutMs, headers: init?.headers });
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) return { data: body, headers: {}, status: 200 };
    }
    throw new Error(`no route for ${url}`);
  });
  return { getJson, calls } as unknown as HttpClient & { calls: Call[] };
}

const onePiece: AnimeIdentity = { anilist: 21, mal: 21, kitsu: '12', tvdb: 81797, imdb: 'tt0388629' };

describe('TmdbArtworkSource — resolving the TMDB id', () => {
  it('asks by tvdb_id, the parameter that actually works', async () => {
    // `external_source=thetvdb` returns `{"tv_results":[]}` with a 200 — a
    // silent miss that looks like success. The working value is `tvdb_id`, and
    // this assertion is what stops that regression.
    const http = httpFor({ 'find/81797': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    await src.artworkFor(onePiece);

    const find = http.calls.find((c) => c.url.includes('/find/'));
    expect(find?.url).toContain('external_source=tvdb_id');
    expect(find?.url).not.toContain('thetvdb');
  });

  it('falls back to imdb_id when the title has no tvdb id', async () => {
    const http = httpFor({ 'find/tt0388629': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    await src.artworkFor({ anilist: 21, imdb: 'tt0388629' });

    const find = http.calls.find((c) => c.url.includes('/find/'));
    expect(find?.url).toContain('external_source=imdb_id');
    expect(find?.url).toContain('tt0388629');
  });

  it('sends the key as a query parameter, never as a header it also logs', async () => {
    const http = httpFor({ 'find/81797': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    await src.artworkFor(onePiece);

    for (const call of http.calls) {
      expect(call.url).toContain(`api_key=${KEY}`);
    }
  });

  it('asks for the images of the id the find returned, not the id we hold', async () => {
    const http = httpFor({ 'find/81797': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    const art = await src.artworkFor(onePiece);

    expect(http.calls.some((c) => c.url.includes('/tv/37854/images'))).toBe(true);
    expect(art.logo).toBe('https://image.tmdb.org/t/p/w500/9F7daAmibx8ZHTE17CdM5FAwiHE.png');
  });
});

describe('TmdbArtworkSource — failure always degrades', () => {
  it('returns no artwork when no key is configured', async () => {
    // The Phase 4 headline gate: the whole tier is off, and it makes no request
    // at all rather than sending an empty credential upstream.
    const http = httpFor({ 'find/81797': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: undefined });

    await expect(src.artworkFor(onePiece)).resolves.toEqual({});
    expect(http.calls).toHaveLength(0);
  });

  it('returns no artwork when the key is rejected (401)', async () => {
    const getJson = vi.fn(async () => {
      throw new SourceError('invalid_request', '401', 401);
    });
    const src = new TmdbArtworkSource({ http: { getJson } as unknown as HttpClient, apiKey: KEY });

    await expect(src.artworkFor(onePiece)).resolves.toEqual({});
  });

  it('returns no artwork when the find returns nothing at all', async () => {
    // A TMDB miss is a 200 with empty arrays, not an error — so the miss has to
    // be detected from the body, and it must not be retried as an error.
    const http = httpFor({ 'find/81797': FIND_MISS });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    await expect(src.artworkFor(onePiece)).resolves.toEqual({});
  });

  it('returns no artwork when the images call fails after a successful find', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('/find/')) return { data: ONE_PIECE_FIND, headers: {}, status: 200 };
      throw new Error('images unavailable');
    });
    const src = new TmdbArtworkSource({ http: { getJson } as unknown as HttpClient, apiKey: KEY });

    await expect(src.artworkFor(onePiece)).resolves.toEqual({});
  });

  it('never throws, whatever the response body is', async () => {
    for (const bad of [null, undefined, 42, 'x', [], { tv_results: 'nope' }, { tv_results: [{}] }]) {
      const http = httpFor({ 'find/81797': bad });
      const src = new TmdbArtworkSource({ http, apiKey: KEY });
      await expect(src.artworkFor(onePiece)).resolves.toEqual({});
    }
  });

  it('makes no request for an identity with neither a tvdb nor an imdb id', async () => {
    const http = httpFor({ 'find/81797': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    await expect(src.artworkFor({ anilist: 21, mal: 21 })).resolves.toEqual({});
    expect(http.calls).toHaveLength(0);
  });
});

describe('TmdbArtworkSource — budget', () => {
  it('runs under the enrichment budget, separate from identity and episodes', async () => {
    const http = httpFor({ 'find/81797': ONE_PIECE_FIND, 'tv/37854/images': ONE_PIECE_IMAGES });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    await src.artworkFor(onePiece);

    for (const call of http.calls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(2000);
    }
  });

  it('resolves Bebop through the same path with a different id', async () => {
    const bebopImages = capture('tmdb-images-30991.json');
    const http = httpFor({ 'find/76885': BEBOP_FIND, 'tv/30991/images': bebopImages });
    const src = new TmdbArtworkSource({ http, apiKey: KEY });

    const art = await src.artworkFor({ anilist: 1, mal: 1, tvdb: 76885 });

    expect(http.calls.some((c) => c.url.includes('/tv/30991/images'))).toBe(true);
    expect(art.logo).toBeDefined();
    expect(art.backdrop).toBeDefined();
  });
});
