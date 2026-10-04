import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Layer boundary rules (import/no-restricted-paths style) are added in Task 5,
// which owns the module boundary. The src/ layer directories do not exist yet.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
