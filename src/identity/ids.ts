import {
  IDENTITY_NAMESPACE_REGISTRY,
  stremioIdFor,
  type AnimeIdentity,
  type IdentityNamespaceDef,
} from '../domain/anime.js';

// Inbound id parsing/formatting (spec §1 + §4). Pure: imports `domain` only —
// no `sources/*`, no `net`, no network. Everything namespace-shaped is driven
// off `IDENTITY_NAMESPACE_REGISTRY` (ADR-018): prefix matching, inbound
// eligibility, and value validation all read registry columns; the only
// branches below are on the `parse` *kind* (`digits` vs `ttid`), never on a
// namespace key, so enabling/disabling a namespace stays one registry row.

export interface ParsedIncomingId {
  readonly ns: IdentityNamespaceDef['key'];
  readonly value: string;
}

const DIGITS = /^\d+$/;
const BARE_TTID = /^tt(\d+)$/i;

function normalizeValue(
  parse: IdentityNamespaceDef['parse'],
  segment: string,
): string | null {
  if (parse === 'digits') {
    return DIGITS.test(segment) ? segment : null;
  }
  const bare = segment.startsWith('tt') ? segment.slice(2) : segment;
  return DIGITS.test(bare) ? `tt${bare}` : null;
}

function parsePrefixed(lower: string): ParsedIncomingId | null {
  for (const row of IDENTITY_NAMESPACE_REGISTRY) {
    if (!row.inbound) {
      continue;
    }
    if (!lower.startsWith(row.prefix)) {
      continue;
    }
    const rest = lower.slice(row.prefix.length);
    if (rest.length === 0) {
      return null;
    }
    // Video-id suffixes (`anilist:21:1:5`, `S1`-style specials keys): the
    // series id is the leading segment; trailing `:<…>` parts are dropped, so
    // the result is the correct title, never a wrong one.
    const segment = rest.split(':')[0];
    if (segment === undefined || segment.length === 0) {
      return null;
    }
    const value = normalizeValue(row.parse, segment);
    if (value === null) {
      return null;
    }
    return { ns: row.key, value };
  }
  return null;
}

function parseBare(lower: string): ParsedIncomingId | null {
  // Bare numbers are Trakt ids → rejected (spec §1, gate 5): fall through to
  // null. The only colon-less form accepted is the bare `tt…` IMDb id, matched
  // generically off every inbound `ttid` registry row.
  const match = BARE_TTID.exec(lower);
  if (match === null) {
    return null;
  }
  for (const row of IDENTITY_NAMESPACE_REGISTRY) {
    if (row.inbound && row.parse === 'ttid') {
      const digits = match[1];
      if (digits !== undefined) {
        return { ns: row.key, value: `tt${digits}` };
      }
    }
  }
  return null;
}

export function parseIncomingId(raw: string): ParsedIncomingId | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes(':')) {
    return parsePrefixed(lower);
  }
  return parseBare(lower);
}

export function formatId(id: AnimeIdentity): string {
  // Canonical `anilist:<n>` when present, else `kitsu:<id>` — the existing
  // emit path, delegated so behaviour cannot drift.
  return stremioIdFor(id);
}
