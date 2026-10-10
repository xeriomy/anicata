import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EpisodeService, EPISODE_BUDGET_MS } from '../src/services/episode.service.js';
import type { HttpClient } from '../src/net/http.js';
import { SourceError } from '../src/domain/errors.js';

// The same real One Piece capture the render tests are anchored on. Nothing
// here is a fabricated response body.
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/identity/anizip-21.json', import.meta.url), 'utf8'),
) as { episodes: Record<string, unknown> };

type Json = Promise<{ data: unknown; headers: Record<string, string>; status: number }>;

function fakeHttp(impl: (url: string, init?: { timeoutMs?: number }) => Json): HttpClient {
  return { getJson: vi.fn<(url: string, init?: RequestInit & { timeoutMs?: number }) => Json>(impl) } as unknown as HttpClient;
}

describe('EpisodeService', () => {
  it('returns the episodes block from the real capture', async () => {
    const http = fakeHttp(async () => ({ data: capture, headers: {}, status: 200 }));
    const svc = new EpisodeService({ http });

    const episodes = await svc.episodesFor('anilist', '21');

    expect(episodes).not.toBeNull();
    expect(Object.keys(episodes ?? {}).length).toBe(1265);
  });

  it('asks AniZip by the namespace the identity already settles', async () => {
    const http = fakeHttp(async () => ({ data: capture, headers: {}, status: 200 }));
    const svc = new EpisodeService({ http });

    await svc.episodesFor('anilist', '21');

    const url = (http.getJson as unknown as { mock: { calls: string[][] } }).mock.calls[0]?.[0];
    expect(url).toContain('anilist_id=21');
    expect(url).not.toContain('mal_id');
  });

  it('runs under its own 1.5 s budget, separate from the identity budget', async () => {
    const http = fakeHttp(async () => ({ data: capture, headers: {}, status: 200 }));
    const svc = new EpisodeService({ http });

    await svc.episodesFor('anilist', '21');

    const init = (http.getJson as unknown as { mock: { calls: Array<[string, { timeoutMs?: number }]> } })
      .mock.calls[0]?.[1];
    expect(init?.timeoutMs).toBe(EPISODE_BUDGET_MS);
    expect(EPISODE_BUDGET_MS).toBe(1500);
  });

  it('falls back to kitsu for a Kitsu-only title (ADR-016)', async () => {
    const http = fakeHttp(async () => ({ data: capture, headers: {}, status: 200 }));
    const svc = new EpisodeService({ http });

    await svc.episodesFor('kitsu', '11392');

    const url = (http.getJson as unknown as { mock: { calls: string[][] } }).mock.calls[0]?.[0];
    expect(url).toContain('kitsu_id=11392');
  });

  it('returns null when AniZip has no such title (404)', async () => {
    const http = fakeHttp(async () => {
      throw new SourceError('not_found', '404', 404);
    });
    const svc = new EpisodeService({ http });

    await expect(svc.episodesFor('anilist', '21')).resolves.toBeNull();
  });

  it('returns null on a network failure rather than propagating', async () => {
    const http = fakeHttp(async () => {
      throw new SourceError('timeout', 'boom', 0);
    });
    const svc = new EpisodeService({ http });

    await expect(svc.episodesFor('anilist', '21')).resolves.toBeNull();
  });

  it('returns null when the response carries no episodes block', async () => {
    for (const data of [{}, { episodes: null }, { episodes: [] }, { episodes: 'x' }, null]) {
      const http = fakeHttp(async () => ({ data, headers: {}, status: 200 }));
      const svc = new EpisodeService({ http });
      await expect(svc.episodesFor('anilist', '21')).resolves.toBeNull();
    }
  });

  it('returns null when the identity has no namespace AniZip indexes', async () => {
    const http = fakeHttp(async () => ({ data: capture, headers: {}, status: 200 }));
    const svc = new EpisodeService({ http });

    // `simkl` is carried by the identity registry but has no place in AniZip's
    // mappings endpoint, so asking would be a fabricated query.
    await expect(svc.episodesFor('simkl', '12345')).resolves.toBeNull();
    expect((http.getJson as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});
