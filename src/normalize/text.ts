import type { AnimeTitle } from '../domain/anime.js';

export const DESCRIPTION_MAX_LENGTH = 900;

function decodeEntities(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'nbsp':
        return ' ';
      default:
        break;
    }
    const body = entity.slice(1);
    const codePoint =
      entity.startsWith('#x') || entity.startsWith('#X')
        ? Number.parseInt(body.slice(1), 16)
        : Number.parseInt(body, 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return match;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

export function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, '')).trim();
}

export function stripAttribution(input: string): string {
  let out = input;
  for (;;) {
    const next = out.replace(/\s*\(Source:[^)]*\)\s*$/i, '');
    if (next === out) {
      return out;
    }
    out = next;
  }
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function normalizeDescription(
  input: string | null | undefined,
  opts?: { maxLength?: number },
): string | undefined {
  if (input === null || input === undefined) {
    return undefined;
  }
  const maxLength = opts?.maxLength ?? DESCRIPTION_MAX_LENGTH;
  const cleaned = collapseWhitespace(stripAttribution(stripHtml(input)));
  if (cleaned.length === 0) {
    return undefined;
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const slice = cleaned.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) {
    return slice.slice(0, lastSpace);
  }
  return slice;
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveDisplayTitle(
  title: AnimeTitle,
  lang: 'english' | 'romaji' | 'native',
): string {
  const preferred = nonBlank(title[lang]);
  if (preferred !== undefined) {
    return preferred;
  }
  const fallbacks: Array<string | undefined> = [title.english, title.romaji, title.native];
  for (const candidate of fallbacks) {
    const cleaned = nonBlank(candidate);
    if (cleaned !== undefined) {
      return cleaned;
    }
  }
  for (const synonym of title.synonyms) {
    const cleaned = nonBlank(synonym);
    if (cleaned !== undefined) {
      return cleaned;
    }
  }
  return 'Untitled';
}
