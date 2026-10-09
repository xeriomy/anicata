import { describe, it, expect } from 'vitest';
import { mergeIdentity } from '../src/identity/merge.js';
import type { AnimeIdentity } from '../src/domain/anime.js';

// A source identity as AniList supplies it: canonical id plus MAL, but no
// Kitsu or AniDB. This is exactly the live case that left links[] at 2.
const fromSource: AnimeIdentity = { anilist: 21, mal: 21 };

// What the bundle resolves for the same title.
const resolved: AnimeIdentity = {
  anilist: 21,
  mal: 21,
  kitsu: '12',
  anidb: 69,
  tmdb: { tv: 37854 },
  imdb: 'tt0388629',
  tvdb: 81797,
};

describe('mergeIdentity', () => {
  it('fills namespaces the source is missing', () => {
    expect(mergeIdentity(fromSource, resolved)).toEqual(resolved);
  });

  it('never lets the resolved tier override the canonical id', () => {
    // A wrong-but-confident live tier must not be able to re-point a title.
    const bad: AnimeIdentity = { anilist: 999999, mal: 999999, kitsu: '1' };
    const merged = mergeIdentity(fromSource, bad);
    expect(merged).toMatchObject({ anilist: 21, mal: 21 });
    // Cross-ids may still be adopted when the source has none.
    expect(merged).toMatchObject({ kitsu: '1' });
    expect(merged).not.toHaveProperty('mal', 999999);
  });

  it('keeps Kitsu-only titles on the kitsu canonical id', () => {
    const kitsuSource: AnimeIdentity = { kitsu: 11392 };
    const kitsuResolved: AnimeIdentity = { kitsu: 11392, mal: 31608 };
    const merged = mergeIdentity(kitsuSource, kitsuResolved);
    expect(merged).toMatchObject({ kitsu: 11392, mal: 31608 });
  });

  it('a null resolution leaves the source untouched', () => {
    expect(mergeIdentity(fromSource, null)).toEqual(fromSource);
  });

  it('an identity the source already fully populates is unchanged', () => {
    expect(mergeIdentity(resolved, resolved)).toEqual(resolved);
  });

  it('never produces an identity with neither anilist nor kitsu', () => {
    // The Kitsu-only branch forbids anilist; the anilist branch requires it.
    const merged = mergeIdentity({ kitsu: 5 }, { kitsu: 5, mal: 31608 });
    expect(merged).toMatchObject({ kitsu: 5 });
  });
});
