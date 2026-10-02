import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/out/**',
    '**/release/**',
    '**/test-results/**',
    '**/playwright-report/**',
    '.claude/**',
    '.scratch/**',
    '.orchestrator/**',
    // The archived game retains its original rules and frozen fixtures.
    'deprecated/**',
    'docs/**',
  ]),
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./packages/app/tsconfig.worker.json', './tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    },
  },
  {
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: [
      'packages/app/src/city/life/{world,population,parking,network,streetParking,types,protocol}.ts',
      'packages/app/src/city/{generator,assetKits,cityGrid,trafficRoutes,trafficFlow,harbor,harborLayout,railway,railwayLayout}.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded city RNG.' },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'window',
          'document',
          'self',
          'performance',
          'crypto',
          'Date',
          'setTimeout',
          'setInterval',
          'requestAnimationFrame',
        ].map((name) => ({ name, message: 'Simulation time and randomness must come from the world state.' })),
      ],
      'no-restricted-imports': [
        'error',
        { patterns: ['three', 'three/*', 'react', 'react/*', 'react-dom', 'react-dom/*', 'zustand', 'node:*'] },
      ],
    },
  },
]);
