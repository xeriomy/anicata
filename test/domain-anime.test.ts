import { describe, it, expect } from 'vitest';
import { stremioIdFor } from '../src/domain/anime.js';

describe('stremioIdFor', () => {
  it('always produces a prefixed anilist id', () => {
    expect(stremioIdFor({ anilist: 21 })).toBe('anilist:21');
    expect(stremioIdFor({ anilist: 1, mal: 21 })).toBe('anilist:1');
  });
  it('publishes kitsu-sourced titles under the kitsu: namespace, never anilist:', () => {
    expect(stremioIdFor({ kitsu: 1376 })).toBe('kitsu:1376');
  });
  it('never produces a bare number, which Nuvio would read as a Trakt id', () => {
    expect(stremioIdFor({ anilist: 21 }).startsWith('anilist:')).toBe(true);
  });
});
