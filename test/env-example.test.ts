import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

/**
 * The README states `.env.example` "matches `loadAppConfig` exactly", and
 * nothing enforced it — which is exactly how the new `TMDB_API_KEY` came to be
 * missing from it. These tests make that claim true by checking it.
 */
describe('.env.example', () => {
  it('documents every variable loadAppConfig reads', () => {
    // The list below is what loadAppConfig actually reads; this test is what
    // makes the README's claim that .env.example "matches loadAppConfig
    // exactly" enforceable rather than aspirational. A variable can be
    // documented as a `KEY=value` line or as a commented `# KEY=` line, which
    // is how the optional ones are shipped.
    const vars = [
      'PORT',
      'LOG_LEVEL',
      'ANILIST_URL',
      'ANILIST_RATE_LIMIT',
      'HTTP_TIMEOUT_MS',
      'CACHE_MAX_ENTRIES',
      'TMDB_API_KEY',
    ];
    const commented = example
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('#'));
    const commentedVars = commented
      .map((l) => l.replace(/^#\s*/, '').split('=')[0])
      .filter((v): v is string => v !== undefined && v !== '');

    const missing = vars.filter(
      (v) => !example.includes(`${v}=`) && !commentedVars.includes(v),
    );
    expect(missing).toEqual([]);
  });

  it('never carries a real value for the TMDB key', () => {
    // The key is operator-supplied. A committed `.env.example` with a filled-in
    // key would leak it to every clone of the repo, which is the entire reason
    // the default is absent from the code too.
    const keyLine = example
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.replace(/^#\s*/, '').startsWith('TMDB_API_KEY='));

    expect(keyLine).toBeDefined();
    const value = (keyLine ?? '').replace(/^#?\s*TMDB_API_KEY=/, '').trim();
    expect(value).toBe('');
  });

  it('is ignored by git, so a filled-in copy cannot be committed by accident', () => {
    const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(gitignore.split('\n').map((l) => l.trim())).toContain('.env');
  });
});
