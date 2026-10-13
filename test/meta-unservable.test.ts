import { describe, it, expect } from 'vitest';
import { minimalMeta } from '../src/addon/meta.js';

/**
 * The not-found meta must FAIL Nuvio's parser rather than parse as a valid
 * "Unavailable" title.
 *
 * Verified from Nuvio's source (MetaDetailsRepository.tryFetchMeta): each
 * candidate add-on's response is parsed inside a try, and a null result makes
 * Nuvio fall through to the next add-on. A placeholder with a real `name`
 * parses SUCCESSFULLY, so Nuvio accepts it, stops searching, and renders a
 * dead detail page — even when another installed add-on could have served the
 * title. Omitting `name` is the smallest body that the parser rejects while
 * staying a 200 (the never-5xx invariant holds).
 */
describe('minimalMeta — the not-found placeholder', () => {
  it('carries id and type but NO name, so Nuvio rejects and falls through', () => {
    const meta = minimalMeta({ type: 'anime', id: 'anilist:999999' });
    expect(meta.id).toBe('anilist:999999');
    expect(meta.type).toBe('anime');
    expect('name' in meta).toBe(false);
  });

  it('still never throws for garbage input', () => {
    const meta = minimalMeta({ type: 'anime', id: '' });
    expect(meta.type).toBe('anime');
    expect('name' in meta).toBe(false);
  });
});
