import { describe, it, expect, beforeAll } from 'vitest'
import { loadBundle } from '../src/identity/bundle.js'
import { existsSync } from 'node:fs'
import fs from 'node:fs'

// Top-level guard: skip entire suite if artefact absent (fresh clone)
if (!existsSync('data/identity.min.json.gz')) {
  describe.skip('identity bundle loader (no artefact — data/identity.min.json.gz absent)', () => {
    it('would load artefact if present', () => {})
  })
} else {
  describe('identity bundle loader', () => {
    let indices: ReturnType<typeof loadBundle>
    let lookupMs = 0

    beforeAll(() => {
      indices = loadBundle('data/identity.min.json.gz')
    })

    it('loads the real artefact with 32381 rows', () => {
      expect(indices!.rowCount).toBe(32381)
    })

    it('byAnilist resolves for known anilist ids', () => {
      const found = indices!.byAnilist.get(290)
      expect(found).not.toBeUndefined()
      expect(found?.anilist_id).toBe(290)
    })

    it('byMal resolves for known mal ids', () => {
      const found = indices!.byMal.get(290)
      expect(found).not.toBeUndefined()
      expect(found?.mal_id).toBe(290)
    })

    it('byKitsu resolves for known kitsu ids', () => {
      const found = indices!.byKitsu.get(265)
      expect(found).not.toBeUndefined()
      expect(found?.kitsu_id).toBe(265)
    })

    it('byTmdb resolves for tmdb-tv entries', () => {
      const found = indices!.byTmdb.get(37854)
      expect(found).not.toBeUndefined()
      expect(found?.themoviedb_id?.tv).toBe(37854)
    })

    it('byImdb resolves for single-element imdb id', () => {
      const found = indices!.byImdb.get('tt0286390')
      expect(found).not.toBeUndefined()
      expect(found?.imdb_id).toBe('tt0286390')
    })

    it('tier-0 resolution < 1ms', () => {
      const start = performance.now()
      indices!.byAnilist.get(290)
      const end = performance.now()
      lookupMs = end - start
      expect(lookupMs).toBeLessThan(1)
    })

    it('degrades gracefully when bundle is missing', () => {
      const fallback = loadBundle('/tmp/nonexistent-identity-bundle.json.gz')
      expect(fallback.byAnilist.size).toBe(0)
      expect(fallback.byMal.size).toBe(0)
      expect(fallback.byKitsu.size).toBe(0)
      expect(fallback.byTmdb.size).toBe(0)
      expect(fallback.byImdb.size).toBe(0)
    })

    it('degrades gracefully when bundle is corrupt', () => {
      const corruptPath = '/tmp/corrupt-identity-test.json.gz'
      fs.writeFileSync(corruptPath, 'not a gzip file')
      try {
        const fallback = loadBundle(corruptPath)
        expect(fallback.byAnilist.size).toBe(0)
        expect(fallback.byMal.size).toBe(0)
      } finally {
        fs.rmSync(corruptPath, { force: true })
      }
    })

    it('benchmark number: tier-0 resolution time', () => {
      // Pasted in the report as evidence
      console.log(`Tier-0 lookup: ${lookupMs.toFixed(3)} ms`)
    })
  })
}