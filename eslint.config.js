import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Layer boundary rules (import/no-restricted-paths style) are added in Task 5,
// which owns the module boundary. The src/ layer directories do not exist yet.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/domain/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['**/*'] }] },
  },
  {
    // Adapters never import each other. Phase 1 has one adapter; this rule is
    // what stops Phase 2's Kitsu adapter from reaching into AniList (or vice
    // versa) and quietly re-coupling the sources.
    files: ['src/sources/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../anilist/**'], message: 'Adapters must not import each other.' },
            { group: ['../jikan/**'], message: 'Adapters must not import each other.' },
            { group: ['../kitsu/**'], message: 'Adapters must not import each other.' },
            { group: ['../tmdb/**'], message: 'Adapters must not import each other.' },
            { group: ['../anizip/**'], message: 'Adapters must not import each other.' },
          ],
        },
      ],
    },
  },
  {
    // Services depend on a structural port (`AnimeSource` / `{ fetchById }`),
    // never on a concrete adapter. Without this rule the boundary holds only by
    // reviewer vigilance, and the first Phase 2 adapter import would go unnoticed.
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/sources/*/adapter*'], message: 'Services must not import a concrete adapter; depend on a structural port instead.' },
          ],
        },
      ],
    },
  },
  {
    // The protocol layer composes services and renderers; it must not reach
    // into sources or net directly.
    files: ['src/addon/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/sources/*/adapter*'], message: 'The protocol layer must not import an adapter.' },
            { group: ['**/net/**'], message: 'The protocol layer must not import the net layer directly.' },
          ],
        },
      ],
    },
  },
);
