// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // reference/ is the frozen, already-validated reference implementation (84 tests).
    // It is lifted into libs/ package by package (EP-02.1, EP-03.1, ...), and linted then.
    // `**/dist/**`, not `dist/**`: Studio is the first project that emits, and its build output
    // lands in apps/studio/dist rather than at the workspace root.
    ignores: ['node_modules/**', '**/dist/**', '.nx/**', 'reference/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // Unused vars are errors, but an underscore prefix is the documented escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Every service boundary is a published contract - explicit types on exports keep
      // the generated API surface honest (docs/roadmap/16-system-implementation-plan.md).
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // `any` erases the shared-types force-multiplier that the whole stack decision rests on.
      '@typescript-eslint/no-explicit-any': 'error',
      // Node's native TypeScript support is STRIP-ONLY: it erases types and refuses syntax that
      // emits code. A constructor parameter property emits an assignment, so one of them anywhere
      // in a service's import graph breaks `node src/main.ts` — which is how the containers run,
      // with no transform and no build step (infra/docker/Dockerfile). Assign in the body instead.
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
    },
  },
  {
    // Tests may be looser: fixtures and deliberate bad input are normal here.
    // `*.spec.ts` too: Angular's test runner uses that suffix, so Studio's tests are here as well.
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
