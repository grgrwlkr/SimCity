import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Float Math.* results are implementation-approximated and may differ between JS engines, which
// would break the cross-engine fingerprint. Exact operations (abs, floor, fround, imul, ...) stay
// allowed. `sqrt` is decided in stage 1 against the spec text.
const ENGINE_DEPENDENT_MATH = [
  'random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'hypot',
  'cbrt', 'sqrt',
];

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    'test-results/**',
    'playwright-report/**',
    'tools/rand-vectors/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...ENGINE_DEPENDENT_MATH.map((property) => ({
          object: 'Math',
          property,
          message: 'Engine-dependent float math in the simulation; use integer arithmetic or tabulated values.',
        })),
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'self', 'performance', 'crypto', 'Date', 'setTimeout', 'setInterval',
          'requestAnimationFrame'].map((name) => ({
          name,
          message: 'The simulation has no clock, no host and no DOM: time comes in as dtNs, randomness from the seeded Rng.',
        })),
      ],
      'no-restricted-imports': [
        'error',
        { patterns: ['three', 'three/*', 'react', 'react/*', 'react-dom', 'react-dom/*', 'zustand'] },
      ],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
      'no-restricted-syntax': [
        'error',
        { selector: "Identifier[name='unimplemented']", message: 'No stubs in simulation code.' },
      ],
    },
  },
]);
