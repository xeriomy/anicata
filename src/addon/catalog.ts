import type { CatalogService } from '../services/catalog.service.js';
import { renderPreview } from '../render/preview.js';
import type { StremioMetaPreview } from '../render/types.js';

export interface CatalogArgs {
  type: string;
  id: string;
  extra?: Record<string, string | string[]>;
}

export interface ParsedExtra {
  search?: string;
  genre?: string;
  skip: number;
}

function first(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function parseSkip(value: string | string[] | undefined): number {
  const raw = first(value);
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

function parseText(value: string | string[] | undefined): string | undefined {
  const raw = first(value);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function parseExtra(extra: Record<string, string | string[]> | undefined): ParsedExtra {
  const out: ParsedExtra = { skip: parseSkip(extra?.['skip']) };
  const search = parseText(extra?.['search']);
  if (search !== undefined) out.search = search;
  const genre = parseText(extra?.['genre']);
  if (genre !== undefined) out.genre = genre;
  return out;
}

export function createCatalogHandler(deps: {
  catalogService: CatalogService;
}): (args: CatalogArgs) => Promise<{ metas: StremioMetaPreview[]; cacheMaxAge: number }> {
  return async (args: CatalogArgs): Promise<{ metas: StremioMetaPreview[]; cacheMaxAge: number }> => {
    try {
      const { search, genre, skip } = parseExtra(args.extra);
      if (search !== undefined && args.id === 'anime-search') {
        const result = await deps.catalogService.search({ term: search, skip });
        return { metas: result.items.map(renderPreview), cacheMaxAge: result.cacheMaxAge };
      }
      const pageArgs: { catalogId: string; type: string; genre?: string; skip: number } = {
        catalogId: args.id,
        type: args.type,
        skip,
      };
      if (genre !== undefined) pageArgs.genre = genre;
      const result = await deps.catalogService.getCatalogPage(pageArgs);
      return { metas: result.items.map(renderPreview), cacheMaxAge: result.cacheMaxAge };
    } catch {
      return { metas: [], cacheMaxAge: 10 };
    }
  };
}
