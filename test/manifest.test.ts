import { describe, it, expect } from 'vitest';
import { seasonalCatalogId } from '../src/sources/catalog-def.js';
import { addonBuilder, type Manifest } from 'stremio-addon-sdk';
import { buildManifest, assertManifestFits, ADDON_ID, ADDON_NAME } from '../src/addon/manifest.js';

const m = buildManifest('0.1.0');

describe('buildManifest', () => {
  it('carries the three fields Nuvio requires or install fails', () => {
    expect(m.id).toBe(ADDON_ID);
    expect(m.name).toBe(ADDON_NAME);
    expect(m.version).toBe('0.1.0');
  });

  it("fits the SDK's 8kb limit", () => {
    expect(JSON.stringify(m).length).toBeLessThanOrEqual(8192);
  });

  it('passes the SDK linter and handler-coverage check', () => {
    // Narrow cast at the SDK boundary: our manifest carries the Nuvio-required
    // 'anime' type which the SDK's Manifest omits; the SDK passes it through
    // untouched at runtime (see AniCataManifest in src/addon/manifest.ts).
    expect(() => new addonBuilder(m as Manifest)).not.toThrow();
  });

  it('declares meta as an object resource with anilist: and kitsu: idPrefixes', () => {
    const meta = m.resources.find((r) => typeof r === 'object' && r.name === 'meta') as {
      name: string;
      types: string[];
      idPrefixes: string[];
    };
    expect(meta).toBeDefined();
    expect(meta.idPrefixes).toContain('anilist:');
    expect(meta.idPrefixes).toContain('kitsu:');
    expect(meta.types).toEqual(expect.arrayContaining(['anime', 'movie']));
  });

  it('does not leak idPrefixes onto the catalog resource', () => {
    const cat = m.resources.find((r) => r === 'catalog');
    expect(
      typeof cat === 'object' ? (cat as { idPrefixes?: string[] }).idPrefixes : undefined,
    ).toBeUndefined();
  });

  it('declares the Phase 5 catalogue set, including the current season', () => {
    // 14 fixed catalogues plus the generated seasonal one, which carries the
    // season+year so the cache key rotates at the boundary.
    expect(m.catalogs!.map((c) => c.id)).toContain(seasonalCatalogId(new Date()));
    expect(m.catalogs!.length).toBe(15);
  });

  it('gives every browse catalogue a skip extra and no required extra, so all reach Home', () => {
    const searchOnly = (c: (typeof m.catalogs)[number]): boolean =>
      (c.extra ?? []).some((e) => e.name === 'search' && e.isRequired === true);

    for (const c of m.catalogs!) {
      expect(c.extra!.some((e) => e.name === 'skip')).toBe(true);
      // Everything EXCEPT the search-only catalogue must be unrequired, or it
      // would not appear on Home. The search catalogue is the one exception,
      // asserted below.
      if (!searchOnly(c)) {
        expect(c.extra!.every((e) => e.isRequired !== true)).toBe(true);
      }
    }
  });

  it('declares search on exactly one catalogue per type, because Nuvio fans out per catalogue', () => {
    const searchable = m.catalogs!.filter((c) => c.extra!.some((e) => e.name === 'search'));
    // One per resource type: Nuvio routes search on /catalog/{type}/{id}, so a
    // movie type needs its own searchable catalogue to be searchable at all.
    expect(searchable.map((c) => c.id).sort()).toEqual(['anime-search', 'movie-search']);
  });

  it('marks search required on the search catalogue, so it only appears on Search', () => {
    // A searchable-but-feedable catalogue is ALSO published to Home, which puts
    // a "Search Anime" row on the Board that returns an unfiltered feed until a
    // query is typed. `isRequired: true` on the search extra tells the client
    // this catalogue exists only for searching (SDK manifest docs), so it is
    // requested for search and never for a feed.
    // One per resource type: Nuvio routes search on /catalog/{type}/{id}, so a
    // movie type needs its own searchable catalogue to be searchable at all.
    const searchCatalogues = m.catalogs!.filter((c) => c.extra!.some((e) => e.name === 'search'));
    expect(searchCatalogues.map((c) => c.id).sort()).toEqual(['anime-search', 'movie-search']);
    for (const c of searchCatalogues) {
      const searchExtra = c.extra!.find((e) => e.name === 'search');
      expect(searchExtra?.isRequired, c.id).toBe(true);
      // And `skip` stays, so search results still paginate.
      expect(c.extra!.some((e) => e.name === 'skip'), c.id).toBe(true);
    }

    // Every other catalogue must NOT mark search required, or it would
    // disappear from Home.
    for (const c of m.catalogs!) {
      if (searchCatalogues.includes(c)) continue;
      const e = (c.extra ?? []).find((x) => x.name === 'search');
      expect(e?.isRequired, c.id).not.toBe(true);
    }
  });

  it('points logo at a path our own server serves', () => {
    expect(m.logo).toBe('/logo.png');
  });

  it('does not advertise resources we do not implement', () => {
    const names = m.resources.map((r) => (typeof r === 'object' ? r.name : r));
    expect(names.sort()).toEqual(['catalog', 'meta']);
  });

  it('sets behaviourHints with adult false because isAdult is hard-filtered', () => {
    expect(m.behaviorHints).toEqual({
      configurable: false,
      configurationRequired: false,
      adult: false,
      p2p: false,
    });
  });
});

it('throws for a manifest that would exceed the 8kb addonCollection limit', () => {
  // NOTE: the brief drafted this with 60 catalogues, but 60 minimal catalogues
  // serialise to ~5.6kb — under the limit, so the guard would not throw. 120
  // catalogues (~10.9kb) exercises the guard as intended.
  const tooBig = {
    ...buildManifest('0.1.0'),
    catalogs: Array.from({ length: 120 }, (_, i) => ({
      type: 'anime',
      id: `anime-catalog-${i}`,
      name: `Catalog ${i}`,
      extra: [{ name: 'skip' }],
    })),
  };
  expect(() => assertManifestFits(tooBig as never)).toThrow(/8192|8kb/i);
});

it('accepts the real Phase 1 manifest', () => {
  expect(() => assertManifestFits(buildManifest('0.1.0'))).not.toThrow();
});
