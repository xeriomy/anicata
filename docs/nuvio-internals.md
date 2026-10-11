# Nuvio internals — verified against source

Verified **2026-10-11** against `NuvioMedia/NuvioMobile` (Kotlin, `master`).
Every claim below cites a file and line. Claims that could **not** be verified
are marked UNVERIFIED rather than inferred.

This document exists because several architecture numbers in this repo were
previously recorded as facts without a source. The most-cited one — "Nuvio's
meta budget is 5 s" — turned out to be **true**, but it had survived on a
citation nobody could re-check.

## 1. The meta budget: 5 s — VERIFIED

`composeApp/src/commonMain/kotlin/com/nuvio/app/features/details/MetaDetailsRepository.kt`

```kotlin
private const val FETCH_TIMEOUT_MS = 5_000L          // :272
private const val METADATA_PROVIDER_READY_TIMEOUT_MS = 10_000L  // :273
private const val TMDB_ENRICH_TIMEOUT_MS = 5_000L    // :274
private const val MDBLIST_ENRICH_TIMEOUT_MS = 5_000L // :275
```

Used as `withTimeoutOrNull(FETCH_TIMEOUT_MS)` at `:223` and `:364` — **not**
`runCatching`, so a timeout resolves to `null` and Nuvio falls through to the
next add-on. Exceeding it is therefore silent: no error, just no result.

Consequence for us: this is a **per-candidate** timeout around the whole fetch
including our handler. Our own deadlines (3.5 s meta, 3 s catalog, 1.5 s per
enrichment tier, 4.5 s global) are all sized to fit inside it.

> **Note on identity + source composition.** The identity tier (≤ 1500 ms) runs
> *before* the source fetch (≤ 4000 ms chain budget), so the arithmetic ceiling
> is ~5.5 s. In practice this is not reached, because the Fribb bundle resolves
> almost every id in-memory (~0.007 ms) and an id that misses the bundle usually
> cannot be served by any source either. Measured: a hung AniList still answers
> in ~4.1 s. Do not repeat the ~5.5 s figure as if it were a measured worst
> case; it is a ceiling that requires three upstreams to be slow at once.

## 2. Nuvio enriches OUR meta itself — VERIFIED, and important

`MetaDetailsRepository.kt:290-316`, after parsing our payload:

```kotlin
val result = MetaDetailsParser.parse(payload)          // <- our add-on's meta
val tmdbEnriched = withTimeoutOrNull(TMDB_ENRICH_TIMEOUT_MS) {
    TmdbMetadataService.enrichMeta(
        meta = result,
        fallbackItemId = id,
        settings = TmdbSettingsRepository.snapshot(),
    )
} ?: result
```

`TmdbMetadataService.applyEnrichment` (`TmdbMetadataService.kt:790+`) then does:

```kotlin
if (enrichment != null && settings.useArtwork) {
    updated = updated.copy(
        background = enrichment.backdrop ?: updated.background,
        poster    = enrichment.poster    ?: updated.poster,
        logo      = enrichment.logo      ?: updated.logo,   // <- THEIRS WINS
    )
}
```

### What this means for the add-on

1. **Nuvio's TMDB artwork overrides ours.** When a user enables TMDB in Nuvio's
   own settings, its logo/backdrop/poster replace ours. Our `logo` survives only
   as the fallback when TMDB returns nothing. Our Phase 4 TMDB tier is therefore
   a fallback for users who have *not* configured TMDB in Nuvio — not the
   primary path.
2. **The user never needs to give us a key.** Nuvio has its own TMDB settings
   screen (`features/tmdb/TmdbSettings.kt`, `TmdbSettingsRepository.kt`) with a
   per-user key, a language, and per-section toggles (`useArtwork`,
   `useBasicInfo`, `useDetails`, `useCredits`, `useProductions`, `useNetworks`,
   `useEpisodes`, `useSeasonPosters`). Pointing users at Nuvio's own settings is
   better for them: no credential in our env, a per-user key, and Nuvio's
   localisation.
3. **Nuvio also enriches episodes.** With `useEpisodes`/`useSeasonPosters`, it
   fetches TMDB stills per season and rewrites `videos[].thumbnail` — the same
   job our AniZip episode images do. It reads the season/episode numbers from
   the `videos[]` **we** emit, so our numbering feeds it.
4. **`useBasicInfo` can override `name` and `description`** with TMDB's
   localised title. Our `titleLang` handling is a fallback, not final.
5. **Our `links[]` and `imdb` id do real work here.**
   `TmdbService.ensureTmdbId(meta.id, tmdbType, fallbackImdbId = meta.imdbId)`
   resolves the TMDB id from our meta id, using our `imdbId` as fallback. The
   Phase 3 identity work is what lets Nuvio find the right TMDB entry — that is
   its clearest payoff.

## 3. The add-on SDK's own configuration mechanism — VERIFIED

`Stremio/stremio-addon-sdk`, `docs/api/responses/manifest.md`:

- `behaviorHints.configurable: true` + a `manifest.config` array makes the SDK
  generate a `/configure` page with an auto-built form.
- Config entries are `{ key, type, default?, title?, options?, required? }`
  where `type` is `"text" | "number" | "password" | "checkbox" | "select"` —
  `"password"` is the right shape for an API key.
- `behaviorHints.configurationRequired: true` swaps the Install button for
  Configure, for add-ons that cannot work without user data.

**Nuvio support: PARTIALLY VERIFIED.** Nuvio ships an `addons_badge_configurable`
string across its locale files, so it recognises `behaviorHints.configurable`
and displays a badge. Whether it renders the generated page and passes the
values back is **UNVERIFIED** — not confirmed from source. Stremio proper does.

This is a real Phase 8 option for the TMDB key, and it is strictly better than
an environment variable *if* Nuvio renders it: the key becomes per-user instead
of operator-wide, and never touches our deployment.

## 4. What we do NOT know

- Whether Nuvio honours `manifest.config` values on requests (see §3).
- Nuvio's add-on catalogue budget / cache behaviour beyond the timeouts above.
- Whether `TMDB_ENRICH_TIMEOUT_MS` and `MDBLIST_ENRICH_TIMEOUT_MS` are inside or
  outside `FETCH_TIMEOUT_MS`. The code nests them after the parse and wraps each
  separately, which suggests they are additive in wall-clock terms; the app is a
  client, so this does not affect our budget, but it does mean a user with TMDB
  enabled sees our meta later than one without.
