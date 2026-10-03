import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import {defineConfig, globalIgnores} from 'eslint/config';
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
        project: [
          './packages/app/tsconfig.worker.json',
          './tsconfig.eslint.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', {ignoreVoid: false}],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {fixStyle: 'inline-type-imports'},
      ],
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    },
  },
  {
    plugins: {'@stylistic': stylistic},
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
      'one-var': ['error', 'never'],
      // Project readability rules supplement Google's logical grouping guidance.
      '@stylistic/padding-line-between-statements': [
        'error',
        {blankLine: 'always', prev: 'import', next: '*'},
        {blankLine: 'any', prev: 'import', next: 'import'},
        {blankLine: 'always', prev: '*', next: 'block-like'},
        {blankLine: 'always', prev: 'block-like', next: '*'},
        {blankLine: 'always', prev: '*', next: 'return'},
        {blankLine: 'always', prev: ['const', 'let'], next: '*'},
        {blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let']},
        {blankLine: 'any', prev: 'if', next: 'if'},
      ],
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            {blankLine: 'always', prev: '*', next: 'method'},
            {blankLine: 'always', prev: 'method', next: '*'},
          ],
        },
        {exceptAfterOverload: true},
      ],
      '@stylistic/max-statements-per-line': ['error', {max: 1}],
    },
    linterOptions: {reportUnusedDisableDirectives: 'error'},
  },
  {
    files: ['packages/*/src/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports (Google TypeScript Style Guide).',
        },
        {
          selector: 'ExportNamedDeclaration > VariableDeclaration[kind="let"]',
          message:
            'Use an explicit getter instead of a mutable export (Google TypeScript Style Guide).',
        },
      ],
    },
  },
  {
    files: [
      'packages/app/src/region/model/*.ts',
      'packages/app/src/region/protocol.ts',
      'packages/app/src/city/life/{world,population,parking,network,streetParking,types,protocol}.ts',
      'packages/app/src/city/{generator,assetKits,cityGrid,trafficRoutes,trafficFlow,harbor,harborLayout,railway,railwayLayout}.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded city RNG.',
        },
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
        ].map(name => ({
          name,
          message:
            'Simulation time and randomness must come from the world state.',
        })),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'three',
            'three/*',
            'react',
            'react/*',
            'react-dom',
            'react-dom/*',
            'zustand',
            'node:*',
          ],
        },
      ],
    },
  },
]);
