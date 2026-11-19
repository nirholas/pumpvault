import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'vendor/', 'node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
    },
  },
  {
    files: ['src/ui/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['src/lib/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['server/**/*.mjs', 'cli/**/*.mjs', 'tests/**/*.js', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
