import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickArtwork } from '../src/render/artwork.js';

// Real /tv/{id}/images captures. Every expected value was read out of these
// files, not remembered.
const onePiece = JSON.parse(
  readFileSync(new URL('./fixtures/identity/tmdb-images-37854.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const bebop = JSON.parse(
  readFileSync(new URL('./fixtures/identity/tmdb-images-30991.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const EN_LOGO_URL = 'https://image.tmdb.org/t/p/w500/9F7daAmibx8ZHTE17CdM5FAwiHE.png';
const TOP_BACKDROP = '/v38qp4bySLTXYu3MF8r5GD51FN3.jpg';

describe('pickArtwork — logo selection', () => {
  it('picks the highest-voted raster logo', () => {
    // One Piece's en logo outranks every other entry on vote_average (8.362)
    // and width (1277x443). The ja raster is only 618x228, so preferring ja by
    // language alone would deliver a visibly worse title card.
    expect(pickArtwork(onePiece)?.logo).toBe(EN_LOGO_URL);
  });

  it('never returns an SVG logo', () => {
    // Two of One Piece's 36 logos are SVGs, and an SVG cannot be resized by
    // the image CDN the way a raster can. It is filtered out even when it is
    // the only logo for a language.
    const withOnlySvg = {
      logos: [
        { iso_639_1: 'ja', file_path: '/only.svg', vote_average: 9, width: 900 },
        { iso_639_1: 'ja', file_path: '/raster.png', vote_average: 3, width: 400 },
      ],
      backdrops: [],
    };
    expect(pickArtwork(withOnlySvg)?.logo).toBe('https://image.tmdb.org/t/p/w500/raster.png');

    const onlySvg = {
      logos: [{ iso_639_1: 'ja', file_path: '/only.svg', vote_average: 9, width: 900 }],
      backdrops: [],
    };
    expect(pickArtwork(onlySvg)?.logo).toBeUndefined();
  });

  it('prefers en, then ja, then any language', () => {
    const art = pickArtwork({
      logos: [
        { iso_639_1: 'ja', file_path: '/ja.png', vote_average: 10, width: 900 },
        { iso_639_1: 'en', file_path: '/en.png', vote_average: 1, width: 500 },
      ],
      backdrops: [],
    });
    // en wins on language even though ja scores higher: the language preference
    // is applied before the vote ranking, not after.
    expect(art?.logo).toBe('https://image.tmdb.org/t/p/w500/en.png');
  });

  it('falls back to any language when neither en nor ja exists', () => {
    const art = pickArtwork({
      logos: [{ iso_639_1: 'de', file_path: '/de.png', vote_average: 2, width: 400 }],
      backdrops: [],
    });
    expect(art?.logo).toBe('https://image.tmdb.org/t/p/w500/de.png');
  });

  it('breaks vote ties on width', () => {
    const art = pickArtwork({
      logos: [
        { iso_639_1: 'en', file_path: '/small.png', vote_average: 5, width: 200 },
        { iso_639_1: 'en', file_path: '/big.png', vote_average: 5, width: 1500 },
      ],
      backdrops: [],
    });
    expect(art?.logo).toBe('https://image.tmdb.org/t/p/w500/big.png');
  });

  it('treats a missing or null vote_average as zero rather than winning', () => {
    const art = pickArtwork({
      logos: [
        { iso_639_1: 'en', file_path: '/novote.png', vote_average: null, width: 3000 },
        { iso_639_1: 'en', file_path: '/voted.png', vote_average: 1, width: 400 },
      ],
      backdrops: [],
    });
    expect(art?.logo).toBe('https://image.tmdb.org/t/p/w500/voted.png');
  });
});

describe('pickArtwork — backdrop selection', () => {
  it('picks the highest-voted backdrop', () => {
    // One Piece's top backdrop: vote_average 10.0, 3840x2160.
    expect(pickArtwork(onePiece)?.backdrop).toBe(
      `https://image.tmdb.org/t/p/w1280${TOP_BACKDROP}`,
    );
  });

  it('works for Bebop with a different image set', () => {
    const art = pickArtwork(bebop);
    expect(art?.logo).toBeDefined();
    expect(art?.logo!.startsWith('https://image.tmdb.org/t/p/')).toBe(true);
    expect(art?.backdrop).toBeDefined();
  });
});

describe('pickArtwork — degraded input', () => {
  it('returns no artwork for anything without a usable logo and backdrop', () => {
    for (const bad of [null, undefined, 42, 'x', [], true, {}, { logos: [], backdrops: [] }]) {
      expect(pickArtwork(bad)).toEqual({});
    }
  });

  it('skips entries that are not objects or lack a file_path', () => {
    const art = pickArtwork({
      logos: ['garbage', null, { iso_639_1: 'en' }, { iso_639_1: 'en', file_path: '' }],
      backdrops: [{}, { file_path: 42 }],
    });
    expect(art).toEqual({});
  });

  it('ignores a backdrop whose language is null', () => {
    // All One Piece backdrops carry iso_639_1: null; a null language must not
    // disqualify them, only logos are language-matched.
    const art = pickArtwork({
      logos: [],
      backdrops: [{ iso_639_1: null, file_path: '/a.jpg', vote_average: 3, width: 1920 }],
    });
    expect(art?.backdrop).toBe('https://image.tmdb.org/t/p/w1280/a.jpg');
  });
});
