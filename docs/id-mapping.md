# ID Mapping Strategy

> This document defines our canonical identity model, the mapping resolution
> algorithm, and the exact rules for emitting Stremio IDs.
> All API claims here are verified — see [`data-sources.md`](./data-sources.md)
> for the evidence log.

---

## 1. The core problem

AniList — our primary source — exposes **only two identifiers**
(✅ introspected, 55 `Media` fields):

```
Media.id     → AniList id
Media.idMal  → MyAnimeList id
```

There is **no `idKitsu`**, **no `externalIds`**, and **`externalLinks` contains
zero database identifiers** (only streaming/social/info URLs).

Every other ID space must therefore come from somewhere else:

| ID space | Where we get it |
|---|---|
| AniList | `Media.id` ✅ |
| MAL | `Media.idMal` ✅ (also Kitsu `/mappings`, AniZip, Fribb) |
| Kitsu | Kitsu `/mappings` ✅, AniZip ✅, Fribb ✅ |
| AniDB | AniZip ✅, Fribb ✅ |
| TMDB | AniZip ✅, Fribb ✅, TMDB `/find` |
| IMDb | AniZip ✅, Fribb ✅ |
| TVDB | AniZip ✅, Fribb ✅ |
| Simkl | Fribb ✅ |

---

## 2. Canonical identity: **AniList ID**

### 2.1 The Stremio ID we emit

```
anilist:<anilistId>
```

Examples: `anilist:21` (One Piece), `anilist:1` (Cowboy Bebop).

**Why AniList and not Kitsu/TMDB/IMDb:**

| Criterion | AniList | Kitsu | TMDB | IMDb (`tt…`) |
|---|---|---|---|---|
| Available for **every** anime we show | ✅ always | ❌ needs mapping | ❌ ~26% | ❌ ~25% |
| Emitted by our primary source | ✅ yes | ❌ | ❌ | ❌ |
| Nuvio `idPrefixes` routing | ✅ supported | ✅ supported | ✅ but **rewritten to IMDb by Nuvio** | ✅ supported |
| Nuvio anime classification | ✅ `TrackingMediaKind.ANIME` | ✅ | ❌ `SHOW` | ❌ `SHOW` |
| Nuvio Simkl anime-list sync | ✅ via `anilist` | ✅ via `kitsu` | ❌ | ❌ |
| Works without TMDB/API keys | ✅ | ✅ | ❌ needs key | ✅ |
| Stable, never reassigned | ✅ | ✅ | ✅ | ✅ |

> **The decisive facts:**
> 1. Nuvio only reaches 30 AniList requests/min, so the primary source's native
>    ID means **catalog and meta cost one source, not two**.
> 2. Nuvio's `parseTrackingExternalIds()` recognises `anilist:` natively and
>    classifies the title as **ANIME**, routing it to its Simkl anime tracking.
> 3. `tmdb:` ids are actively **rewritten to IMDb** by Nuvio before the request
>    reaches us (`MetaDetailsRepository.resolveMetaLookupId`), so TMDB ids buy us
>    nothing and create a fragile dependency.
> 4. IMDb/TMDB ids exist for only ~25% of titles — a hard ceiling on any
>    design that requires them.

**This is a deliberate divergence from `demdex/nuvio-anime`,** which prefers
`tt…` / `tmdb:` ids for *scraper* compatibility (`mapper.js:268-281`). That is a
streaming-oriented choice. We are catalog-only, so we optimise for metadata
quality and native anime classification instead. If a streaming layer is added
later, it can resolve `anilist:` → `tt…` through the mapping layer.

### 2.2 Why bare numeric IDs are forbidden

Nuvio's ID parser has a catch-all branch:

```kotlin
// TrackingMedia.kt parseTrackingExternalIds()
else -> TrackingExternalIds(trakt = full.toLongOrNull())
```

An unprefixed number is interpreted as a **Trakt ID**. Emitting `"21"` would make
Nuvio look up Trakt #21 — silently wrong. **Every ID we emit must be prefixed.**

### 2.3 Why titles are never identity

Title strings are ambiguous (`"One Piece"`, `"Kimetsu no Yaiba"` vs
`"Demon Slayer: Kimetsu no Yaiba"`), change on re-branding, and differ across
sources. Title matching is permitted **only** as the last resort in the mapping
chain (§5), never as an identity key, and never as a client-visible ID.

---

## 3. Internal model

```ts
interface AnimeIdentity {
  /** Canonical. Our Stremio ID is `anilist:${anilist}`. */
  anilist: number;
  mal?: number;
  kitsu?: string;     // Kitsu ids are strings ("12", "11392")
  anidb?: number;
  tmdb?: { tv?: number; movie?: number };
  imdb?: string;      // "tt1234567"
  tvdb?: number;
  simkl?: number;
}

/** What we hand to clients. */
interface PublicIds {
  /** Always present. The identity of this item. */
  id: string;                    // "anilist:21"
  /** Cross-reference, for display / deep links / future streaming. */
  mal?: number;
  kitsu?: string;
  imdb?: string;
  tmdb?: number;
}
```

`AnimeIdentity` is internal and optional-tolerant. `PublicIds.id` is the **only**
field clients use to address this item; everything else is decorative.

---

## 4. Inbound ID parsing

Nuvio (and other clients) may hand us ids we emitted previously, or ids from
other tools. `parseIncomingId()` accepts:

| Prefix | Accept | Resolve by |
|---|---|---|
| `anilist:` | ✅ | direct — `Media(id:)` |
| `anilist:` (bare digits, no colon) | ❌ reject | see §4.1 |
| `mal:` | ✅ | `Media(idMal:)` |
| `kitsu:` | ✅ | `kitsu:<id>` → mapping → AniList |
| `tmdb:` | ✅ (won't arrive via Nuvio) | mapping → AniList |
| `tt…` (IMDb) | ✅ | mapping → AniList |
| `imdb:` | ✅ | strip, treat as `tt…` |
| `kitsu:12:3:45` (Stremio video id) | ✅ | parse season/episode from trailing segments |

### 4.1 Rejecting bare numbers

A bare number is **ambiguous** — it could be a Trakt id, a MAL id, or an
AniList id. We reject it rather than guess. Rationale: we only ever emit
`anilist:`-prefixed ids, so a bare number reaching us is either a bug or a
foreign id whose meaning we cannot know.

> **Exception:** a bare number inside a `tmdb:`/`mal:`/`kitsu:` prefix is of course
> parsed normally — the rule is only about *unprefixed* input.

### 4.2 Stremio video-id suffixes

Stremio appends `:<season>:<episode>` to the *parent* id for videos:

```
anilist:21:1:5      → parent "anilist:21", season 1, episode 5
```

`parseIncomingId()` must split from the **right** on `:` while keeping the
prefix intact, and must tolerate `S1`-style specials keys from AniZip (§6.3).

---

## 5. Mapping resolution algorithm

### 5.1 Reverse map construction (build time / cold start)

```
Fribb/anime-lists → anime-list-full.json (7.49 MB, 39,577 records)
        │
        ▼  trim to 10 fields, drop empties
32,363 records → 2.85 MB JSON / 459 KB gzip
        │
        ▼  build 5 reverse indices
   ┌────────────┬──────────────┬──────────────┬────────────┬──────────────┐
   │ byAnilist  │ byMal        │ byKitsu      │ byTmdb     │ byImdb       │
   └────────────┴──────────────┴──────────────┴────────────┴──────────────┘
```

Each index maps a single id → a compact tuple, so **one title is one entry
regardless of which id we start from**.

### 5.2 Resolution chain

`resolveToCanonical(inputId): Promise<AnimeIdentity | null>`

```
0. Normalise input → { namespace, value }
      invalid namespace / blank value  → null   (do NOT retry — §7)

1. Cache lookup (memory, TTL 30d)                      ── hit ─→ return

2. byX reverse index (Fribb bundle)                    ── hit ─→ cache, return

3. Kitsu /mappings  (live, keyless, ~70 ms)
      MAL→Kitsu   : ?filter[externalSite]=myanimelist/anime&filter[externalId]={mal}
      AniList→Kitsu: ?filter[externalSite]=anilist/anime&filter[externalId]={al}
      include=item                                    ── hit ─→ anilist_id?

4. AniList single-source probes                        (only if we lack the AniList id)
      kitsu:<id>  → /anime?filter[ids]=<id>  → attributes (no anilist_id!) 
      tmdb:<id>   → /find/{id}?external_source=…
      → if only a Kitsu id results, we can render from Kitsu but cannot emit
        a canonical anilist: id. See §5.3.

5. AniZip /mappings?{anilist|mal|kitsu|imdb|themoviedb}_id=
      returns ALL ids at once                         ── hit ─→ cache, return

6. Title-based match (LAST RESORT, Kitsu only)
      /anime?filter[text]={title}&page[limit]=5
      accept only on: same format, year within ±1, score within 15%
      ⚠ result is marked low-confidence and NOT cached as authoritative

7. miss → cache a negative result (TTL 10 min) → return null
```

> **Order rationale.** Steps 2–3 are free and cover ~95% of cases
> (✅ verified: `myanimelist/anime` has 21,129 mappings, `anilist/anime` 19,061).
> AniZip (step 5) is the only source that returns every id space at once, so it
> is the best *complement*, but it is community-run and large — never step 1.
> Title matching is last because it is the only lossy step.

### 5.3 The "Kitsu-only" problem

Some titles exist in Kitsu but have **no AniList id**. For those:

- We can still render a complete catalogue item and meta from Kitsu.
- But we cannot emit `anilist:<id>`.
- **Options:** (a) emit `kitsu:<id>` and add `"kitsu:"` to `meta` `idPrefixes`;
  (b) drop the title.

> **Decision: option (a), deferred to Phase 2.** Our `meta` resource declares
> `idPrefixes: ["anilist:", "kitsu:"]` from day one. Today we only ever *emit*
> `anilist:`; if Kitsu-only coverage proves material in Phase 2 we start emitting
> `kitsu:` too, and Nuvio needs no manifest change. This costs nothing now and
> removes a hard failure mode later.

---

## 6. Per-source normalisation rules

Each source's data must be projected into our internal model before merging.

### 6.1 Status

| Source | Values | → ours |
|---|---|---|
| AniList ✅ | `FINISHED`, `RELEASING`, `NOT_YET_RELEASED`, `CANCELLED`, `HIATUS` | pass through |
| Kitsu ✅ | `finished`, `current`, `planned`, `on_hold`, `cancelled` | map to AniList set |
| Jikan 📄 | `1` airing, `2` completed, `3` upcoming, `4` paused, `5` discontinued | map to AniList set |
| TMDB 📄 | `Returning Series`, `Ended`, `Canceled`, `In Production` | map to AniList set |

### 6.2 Format

| Source | Values | → ours |
|---|---|---|
| AniList ✅ | `TV`, `TV_SHORT`, `MOVIE`, `SPECIAL`, `OVA`, `ONA`, `MUSIC` | pass through |
| Kitsu ✅ | `subtype` (`TV`, `Movie`, `OVA`, `ONA`, `Special`) + `showType` | map to AniList |
| Jikan 📄 | `TV`, `Movie`, `OVA`, `ONA`, `Special`, `Music` | map to AniList |
| Fribb ✅ | `type` (`TV`, `MOVIE`, `OVA`, `ONA`, `SPECIAL`, …) | map to AniList |

→ Stremio `type`: `MOVIE` → `movie`; everything else → `anime` (see
[`nuvio-compatibility.md` §9](./nuvio-compatibility.md)).

### 6.3 Episode numbering — **do not assume alignment** ✅

Verified with Cowboy Bebop: AniZip's episode key `"1"` carries

```
seasonNumber: 1, episodeNumber: 14, absoluteEpisodeNumber: 4
```

AniList, MAL and TVDB number episodes differently for some titles.

**Rule:** our episode index is always the **AniList-relative key** from AniZip
(`episodes["1"]`, `episodes["S1"]`). We expose `episodeNumber` as a display
convenience but **derive `season`/`episode` for Stremio `videos[]` from the key**,
specials going to season `0`.

### 6.4 Ratings

Scores are **not comparable** across sites. We store each source's score
separately and display only the primary source's:

```
anilist.averageScore  (0–100)  → displayed rating
jikan.score          (0–10)   → fallback only
kitsu.averageRating  ("82.27") → fallback only, MAL-derived
```

We **never** blend them.

### 6.5 Descriptions

All three sources return HTML-ish or plain text with varying quality:

- AniList: `description(asHtml: false)` ✅ — request plain.
- Kitsu: `synopsis` / `description` (identical text, contains `(Source: MAL …)`).
- Jikan: `synopsis` + `background` (richer, longer).

**Rules:** strip HTML tags, collapse whitespace, trim trailing
`(Source: …)` attributions, cap length (see §7.4). Prefer AniList; fall back to
Kitsu; then Jikan.

### 6.6 Images

| Field | AniList ✅ | Kitsu ✅ | AniZip/TMDB ✅ |
|---|---|---|---|
| poster | `coverImage.large` | `posterImage.large` (550×780) | — |
| backdrop | `bannerImage` | `coverImage.large` (3360×800) | AniZip `images[coverType=Banner]` |
| fanart | — | — | AniZip `images[coverType=Fanart]` |
| logo | — | — | TMDB `logos[]`, or AniZip banner |
| episode thumb | — | Kitsu `episodes` thumbnail | AniZip `episodes[x].image` (TVDB) ✅ hotlinks |

**Always emit `banner` for Nuvio** — it is Nuvio's preferred wide-art field and
falls back to `background` only if `banner` is absent.

---

## 7. Emission rules — what we put on the wire

### 7.1 `metas[].id` / `meta.id`

```
"anilist:<anilistId>"     ← canonical, ~99% of items
"kitsu:<kitsuId>"         ← Phase 2+ fallback for AniList-less titles
```

**Never:** bare numbers, `tt…` as primary, `tmdb:` (Nuvio rewrites it to IMDb).

### 7.2 `meta` resource `idPrefixes`

```json
{ "name": "meta", "types": ["anime", "movie"], "idPrefixes": ["anilist:", "kitsu:"] }
```

Nuvio matches with `id.startsWith(prefix)` ✅. This makes us the handler **only**
for our own ids and keeps us out of the path for other add-ons' content.

### 7.3 `links[]` — cross-references (all three fields required by Nuvio ✅)

```json
"links": [
  { "name": "AniList",     "category": "AniList", "url": "https://anilist.co/anime/21" },
  { "name": "MyAnimeList", "category": "MyAnimeList", "url": "https://myanimelist.net/anime/21" },
  { "name": "Kitsu",       "category": "Kitsu", "url": "https://kitsu.app/anime/12" },
  { "name": "AniDB",       "category": "AniDB", "url": "https://anidb.net/anime/69" }
```

> Corrected 2026-10-08 (Phase 3, R4 + spec §5): the Kitsu entry carried a stray
> `"type"` key, which contradicts the "exactly three keys" rule this section
> states and which T9 now asserts in `test/meta-links.test.ts`. The AniDB id was
> also wrong — One Piece is AniDB 69, not 21 (AniDB 21 is a different title).

> Nuvio parses `links[]` requiring `name`, `category`, `url`, and additionally
> mines `category ∈ {director, cast, actor, …}` for people ✅. Our categories are
> database names, so there is no collision.

### 7.4 `description`

- Plain text, no HTML, no BBCode.
- Stale attributions stripped.
- Length target ≈ 400–900 chars. Nuvio renders whatever we send; very long text
  is truncated in the UI at an unknown point, so we cap rather than rely on it.
  *(Whether Nuvio itself truncates is **UNVERIFIED** — the parser passes the raw
  string through.)*

---

## 8. Caching the mapping layer

| Layer | Key | TTL | Notes |
|---|---|---|---|
| Reverse indices | in-memory | process lifetime | built once from the trimmed bundle |
| Resolved identity | `resolve:<normalisedId>` | **30 d** | positive results; ids are stable |
| Negative | `resolve:<normalisedId>` | **10 min** | avoid hammering a source that lacks a title |
| Low-confidence (title match) | `resolve:<title>` | **1 h** | never promoted to authoritative |

> Anime ids are stable, so a 30-day positive TTL is safe and is what makes this
> layer free at request time. Negative results expire quickly so newly-added
> titles appear promptly.

---

## 9. Mapping correctness rules (enforced in code + tests)

1. **Never invent an id.** If a mapping source has no entry, the field stays
   `undefined`. A wrong id is worse than a missing one — it sends a user to the
   wrong title.
2. **Never use a title as an id.**
3. **Never emit an unprefixed id.**
4. **One title, one identity.** If two sources disagree, prefer, in order:
   Fribb bundle → Kitsu `/mappings` → AniZip → title match.
5. **Verify before trusting.** A mapping whose AniList id resolves to a media
   whose `idMal` contradicts our `mal` is rejected and logged.
6. **Specials are season 0** in emitted `videos[]`, per Stremio convention.
7. **`imdb_id` is a bonus field, never an identity.**

---

## 10. Worked example — One Piece

```
AniList query        → Media(id:21)          id=21, idMal=21, title.romaji="ONE PIECE"
Fribb index          → byAnilist["21"]      { anilist:21, mal:21, kitsu:12,
                                              imdb:"tt0388629", anidb:21,
                                              tmdb:{tv:37854}, tvdb:… }
Kitsu /mappings      → mapping 1175          anime 12 "One Piece"   (independent confirmation)
AniZip /mappings     → kitsu_id:12, mal_id:21, anilist_id:21,
                        imdb_id:"tt0388629", themoviedb_id:37854, anidb_id:21

Emitted id           → "anilist:21"
meta links           → AniList 21 · MAL 21 · Kitsu 12 · AniDB 21
Nuvio routing        → idPrefixes ["anilist:"] matches "anilist:21" ✓
Nuvio tracking kind  → TrackingMediaKind.ANIME (anilist prefix) ✓
```

All four sources agree. High confidence.

---

## 11. Worked example — a title AniList lacks

```
Input                 → kitsu:11392
Kitsu /mappings       → (reverse: this is Kitsu-native, no mapping row needed)
Kitsu /anime/11392    → full attributes + relationships
Fribb byKitsu[11392]  → { anilist: null, mal: 31608 }   ← no anilist_id
Resolution            → canonical anilist id: NONE
Action                → emit id "kitsu:11392"  (§5.3)
Nuvio routing         → idPrefixes includes "kitsu:" ✓
Nuvio tracking kind   → TrackingMediaKind.ANIME (kitsu prefix) ✓
Metadata quality      → Kitsu-only (no AniList tags/trending)
```

This is exactly why `idPrefixes` lists **both** prefixes from day one.

---

## 12. Failure-mode matrix

| Situation | Behaviour |
|---|---|
| Malformed inbound id | 400-style empty `metas` + `Cache-Control` short. No upstream calls. |
| Unknown but well-formed `anilist:` id | AniList returns `data.media = null` → `metas: []`. **No fallback chain** (an invalid id is not a transient failure). |
| AniList 429 | Serve stale cache if available; else try Kitsu for the *same* title only if we know a cross-id; else short `Cache-Control`. |
| AniList timeout | Serve stale; else Jikan (if reachable) → Kitsu; else error. |
| AniList + Kitsu both down | Serve stale (up to 24 h grace) — see [`architecture.md`](./architecture.md). |
| Fribb bundle missing/failed | Degrade to Kitsu `/mappings` live resolution; log loudly. |
| Source returns a different `idMal` than our mapping | Prefer the source (it is authoritative for itself); log the conflict; do not cache the mapping as authoritative. |
| Title-match result looks wrong | Refuse the match; return `null`. A wrong identity is the worst outcome. |