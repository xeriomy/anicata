import type {
  FullManifestResource,
  Manifest,
  ManifestCatalog,
  ShortManifestResource,
} from 'stremio-addon-sdk';
import { CATALOG_DEFS } from '../sources/catalog-def.js';

/**
 * The SDK's `ContentType` union is `"movie" | "series" | "channel" | "tv"` and has no
 * `"anime"`. Nuvio requires `"anime"` — it labels the type and, crucially, classifies
 * `anilist:`-prefixed titles as `TrackingMediaKind.ANIME`, which is what engages its
 * Simkl anime tracking. Widening here is deliberate; never substitute `"series"`.
 */
export type ContentTypeWithAnime = 'anime' | 'movie' | 'series' | 'channel' | 'tv';

/**
 * Gap in the SDK's types, not a mistake in our manifest: `FullManifestResource.types`
 * omits `"anime"`, which Nuvio requires (see `ContentTypeWithAnime`). The SDK passes
 * these strings through untouched at runtime.
 */
export type AniCataManifestResource = Omit<FullManifestResource, 'types'> & {
  types: ContentTypeWithAnime[];
};

/**
 * Gap in the SDK's types, not a mistake in our manifest: `ManifestCatalog.type` omits
 * `"anime"`. Widened here so no cast is needed at the construction site.
 */
export type AniCataManifestCatalog = Omit<ManifestCatalog, 'type'> & {
  type: ContentTypeWithAnime;
};

/**
 * The SDK's `Manifest` type omits `"anime"` from `types` (and from resource and
 * catalogue types) and marks `logo` optional. Both are gaps in the SDK's types, not
 * mistakes in our manifest: the SDK passes `logo` through untouched at runtime, and
 * Nuvio resolves a root-relative `/logo.png` against the manifest host (verified from
 * `AddonManifestParser.resolveAgainstManifest`).
 */
export type AniCataManifest = Omit<Manifest, 'types' | 'resources' | 'catalogs' | 'logo'> & {
  types: ContentTypeWithAnime[];
  resources: Array<ShortManifestResource | AniCataManifestResource>;
  catalogs: AniCataManifestCatalog[];
  logo: string;
};

export const ADDON_ID = 'org.anicata.anime';
export const ADDON_NAME = 'AniCata Anime';

const MANIFEST_MAX_BYTES = 8192;

export function assertManifestFits(manifest: Manifest | AniCataManifest): void {
  const bytes = JSON.stringify(manifest).length;
  if (bytes > MANIFEST_MAX_BYTES) {
    throw new Error(`manifest size ${bytes} exceeds ${MANIFEST_MAX_BYTES} bytes (8kb SDK limit)`);
  }
}

export function buildManifest(version: string): AniCataManifest {
  const manifest: AniCataManifest = {
    id: ADDON_ID,
    version,
    name: ADDON_NAME,
    description: 'Anime catalogues and metadata from AniList, with Kitsu fallback.',
    logo: '/logo.png',
    types: ['anime', 'movie'],
    idPrefixes: ['anilist:', 'kitsu:'],
    resources: [
      'catalog',
      { name: 'meta', types: ['anime', 'movie'], idPrefixes: ['anilist:', 'kitsu:'] },
    ],
    catalogs: Object.values(CATALOG_DEFS).map((def): AniCataManifestCatalog => ({
      type: def.type,
      id: def.id,
      name: def.name,
      extra: def.supportsSearch
        ? [{ name: 'skip' }, { name: 'search' }]
        : [{ name: 'skip' }],
    })),
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
      adult: false,
      p2p: false,
    },
  };
  assertManifestFits(manifest);
  return manifest;
}
