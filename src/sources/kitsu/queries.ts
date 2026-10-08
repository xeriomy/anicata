// Verified Kitsu JSON:API URL shapes. Bracket params (page[limit],
// filter[text]) must be percent-encoded; URLSearchParams does that, and the
// captures in test/fixtures/kitsu-*.json were recorded with encoded brackets.
// Known traps that 400 if you get them wrong:
// - `sort` accepts only average_rating, userCount and popularityRank.
//   `trending`, `recently_popular`, `relevance`, `title` and `favorites` are
//   all rejected with "<value> is not a valid sort criteria for anime"
//   (verified 2026-10-07). Text search ranks by relevance with NO sort param.
// - Genre names arrive in `included`, never on the record, so every URL below
//   carries `include=genres`; without it the genre join has nothing to read.

export const KITSU_BASE = 'https://kitsu.io/api/edge';

export interface KitsuPageParams {
  sort: string;
  limit: number;
  offset: number;
  genre?: string;
}

export function buildPageUrl(params: KitsuPageParams): string {
  const q = new URLSearchParams();
  if (params.sort !== '') {
    q.set('sort', params.sort);
  }
  q.set('page[limit]', String(params.limit));
  q.set('page[offset]', String(params.offset));
  if (params.genre !== undefined) {
    q.set('filter[genres]', params.genre);
  }
  q.set('include', 'genres');
  return `${KITSU_BASE}/anime?${q.toString()}`;
}

export function buildSearchUrl(term: string, limit: number, offset: number): string {
  const q = new URLSearchParams();
  q.set('filter[text]', term);
  q.set('page[limit]', String(limit));
  q.set('page[offset]', String(offset));
  q.set('include', 'genres');
  return `${KITSU_BASE}/anime?${q.toString()}`;
}

export function buildByIdUrl(id: number): string {
  const q = new URLSearchParams({ include: 'genres' });
  return `${KITSU_BASE}/anime/${id}?${q.toString()}`;
}
