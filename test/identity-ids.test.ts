import { describe, it, expect } from 'vitest';
import {
  IDENTITY_NAMESPACE_REGISTRY,
  type AnimeIdentity,
} from '../src/domain/anime.js';
import { parseIncomingId, formatId } from '../src/identity/ids.js';

// Task 2: parse/format inbound ids per spec §1 + §4, bare-number rejection
// (gate 5 parse half), adversarial malformed set (gate 7 parse half — every
// case yields `null` or the correct title, never a wrong one).
describe('parseIncomingId — six inbound forms', () => {
  it('accepts anilist:, mal:, kitsu:, tmdb:, tt…, imdb:', () => {
    expect(parseIncomingId('anilist:21')).toEqual({ ns: 'anilist', value: '21' });
    expect(parseIncomingId('mal:21')).toEqual({ ns: 'mal', value: '21' });
    expect(parseIncomingId('kitsu:12')).toEqual({ ns: 'kitsu', value: '12' });
    expect(parseIncomingId('tmdb:37854')).toEqual({ ns: 'tmdb', value: '37854' });
    expect(parseIncomingId('tt0388629')).toEqual({ ns: 'imdb', value: 'tt0388629' });
    expect(parseIncomingId('imdb:tt0388629')).toEqual({
      ns: 'imdb',
      value: 'tt0388629',
    });
  });

  it('stays table-driven: every registry inbound prefix parses (one row = one namespace)', () => {
    for (const row of IDENTITY_NAMESPACE_REGISTRY) {
      if (!row.inbound) {
        continue;
      }
      const sample = row.parse === 'ttid' ? 'tt0388629' : '21';
      expect(parseIncomingId(`${row.prefix}${sample}`)).toEqual({
        ns: row.key,
        value: sample,
      });
    }
  });

  it('parses case-insensitively but normalizes values to lowercase', () => {
    expect(parseIncomingId('Anilist:21')).toEqual({ ns: 'anilist', value: '21' });
    expect(parseIncomingId('MAL:21')).toEqual({ ns: 'mal', value: '21' });
    expect(parseIncomingId('KITSU:12')).toEqual({ ns: 'kitsu', value: '12' });
    expect(parseIncomingId('TMDB:37854')).toEqual({ ns: 'tmdb', value: '37854' });
    expect(parseIncomingId('TT0388629')).toEqual({ ns: 'imdb', value: 'tt0388629' });
    expect(parseIncomingId('IMDB:TT0388629')).toEqual({
      ns: 'imdb',
      value: 'tt0388629',
    });
  });

  it('strips video-id suffixes, splitting from the right (prefix intact)', () => {
    expect(parseIncomingId('anilist:21:1:5')).toEqual({ ns: 'anilist', value: '21' });
    expect(parseIncomingId('kitsu:12:1:5')).toEqual({ ns: 'kitsu', value: '12' });
    expect(parseIncomingId('mal:21:2')).toEqual({ ns: 'mal', value: '21' });
  });

  it('prepends tt to bare-digit imdb: values', () => {
    expect(parseIncomingId('imdb:0213338')).toEqual({
      ns: 'imdb',
      value: 'tt0213338',
    });
  });
});

describe('parseIncomingId — bare-number rejection (gate 5 parse half)', () => {
  it('rejects bare numbers (Trakt ids — never resolved, zero upstream calls)', () => {
    // Pure synchronous function: `null` is returned with no await and no
    // imports beyond `domain`, so no upstream call is constructible here.
    for (const bare of ['21', '0', '007', '0388629', '99999999']) {
      expect(parseIncomingId(bare)).toBeNull();
    }
  });
});

describe('parseIncomingId — adversarial malformed set (gate 7 parse half)', () => {
  it('yields null for wrong-namespace values, never a wrong title', () => {
    // Non-digits inside a digits namespace; tt-forms in numeric namespaces;
    // affixed tmdb values (AniZip `=tv30991` → 404, spec §1).
    const malformed = [
      '',
      '   ',
      'anilist:',
      'anilist:abc',
      'anilist:tt0388629',
      'anilist:-1',
      'mal:tt0388629',
      'mal:12x',
      'kitsu:',
      'kitsu:abc',
      'tmdb:tv30991',
      'tmdb:TV30991',
      'tmdb:movie123',
      'tmdb:tt0388629',
      'imdb:',
      'imdb:abc',
      'tt',
      'ttabc',
      'trakt:21',
      ':21',
      'anilist:2:1',
    ];
    for (const raw of malformed) {
      if (raw === 'anilist:2:1') {
        // Video-id suffix of a digits id: the correct title (anilist 2),
        // never a wrong one.
        expect(parseIncomingId(raw)).toEqual({ ns: 'anilist', value: '2' });
      } else {
        expect(parseIncomingId(raw)).toBeNull();
      }
    }
  });

  it('tolerates S1-style specials suffixes to the correct title, never a wrong one', () => {
    expect(parseIncomingId('anilist:21:S1')).toEqual({ ns: 'anilist', value: '21' });
  });
});

describe('formatId', () => {
  it('emits canonical anilist:<n> when present, else kitsu:<id>', () => {
    const full: AnimeIdentity = {
      anilist: 21,
      mal: 21,
      kitsu: '12',
      tmdb: { tv: 37854 },
      imdb: 'tt0388629',
    };
    expect(formatId(full)).toBe('anilist:21');
    expect(formatId({ anilist: 1 })).toBe('anilist:1');
    expect(formatId({ kitsu: 1376 })).toBe('kitsu:1376');
  });

  it('always emits lowercase', () => {
    expect(formatId({ anilist: 21 })).toBe('anilist:21');
    expect(formatId({ kitsu: 1376 })).not.toMatch(/[A-Z]/);
  });
});
