import { describe, it, expect } from 'vitest';
import {
  stripHtml,
  stripAttribution,
  collapseWhitespace,
  normalizeDescription,
  resolveDisplayTitle,
} from '../src/normalize/text.js';

describe('stripHtml', () => {
  it('removes tags and decodes the entities AniList emits', () => {
    expect(stripHtml('<p>Hello<br/>World &amp; more</p>')).toBe('HelloWorld & more');
  });
  it('returns a trimmed string for empty-ish input', () => {
    expect(stripHtml('   ')).toBe('');
  });
});

describe('collapseWhitespace', () => {
  it('collapses runs of whitespace to a single space and trims', () => {
    expect(collapseWhitespace('  a   b\nc  ')).toBe('a b c');
  });
});

describe('stripAttribution', () => {
  it('drops a trailing (Source: MAL Rewrite) attribution', () => {
    expect(stripAttribution('A story.\n\n(Source: MAL Rewrite)')).toBe('A story.');
  });
  it('keeps parentheses that are not an attribution', () => {
    expect(stripAttribution('He said (hi) loudly.')).toBe('He said (hi) loudly.');
  });
});

describe('normalizeDescription', () => {
  it('strips html, attribution and whitespace, then truncates on a word boundary', () => {
    const long = 'word '.repeat(400);
    const out = normalizeDescription(long, { maxLength: 100 })!;
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('word')).toBe(true);
  });
  it('returns undefined for null, undefined or whitespace-only input', () => {
    expect(normalizeDescription(null)).toBeUndefined();
    expect(normalizeDescription(undefined)).toBeUndefined();
    expect(normalizeDescription('   ')).toBeUndefined();
  });
});

describe('resolveDisplayTitle', () => {
  it('prefers english, then romaji, then native', () => {
    expect(
      resolveDisplayTitle({ romaji: 'R', english: 'E', native: 'N', synonyms: [] }, 'english'),
    ).toBe('E');
    expect(resolveDisplayTitle({ romaji: 'R', native: 'N', synonyms: [] }, 'english')).toBe('R');
    expect(resolveDisplayTitle({ native: 'N', synonyms: [] }, 'english')).toBe('N');
  });
  it('falls back to a non-blank title whatever the language preference', () => {
    expect(resolveDisplayTitle({ romaji: 'R', synonyms: [] }, 'native')).toBe('R');
  });
  it('returns "Untitled" only when every title is missing or blank', () => {
    expect(resolveDisplayTitle({ romaji: '  ', synonyms: [] }, 'english')).toBe('Untitled');
    expect(resolveDisplayTitle({ synonyms: [] }, 'english')).toBe('Untitled');
  });
});
