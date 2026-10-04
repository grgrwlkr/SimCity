import {ESLint, type Linter} from 'eslint';
import {fileURLToPath} from 'node:url';
import {parser} from 'typescript-eslint';
import type {Program} from 'typescript';
import {describe, expect, it} from 'vitest';

// The aggregator's compatibility type omits the supported parser options and typed services.
const parseProbe = parser.parseForESLint.bind(parser) as (
  code: string,
  options?: Linter.ParserOptions,
) => ReturnType<typeof parser.parseForESLint> & {
  services: {program: Program | null};
};
const lint = new ESLint({
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  overrideConfig: {
    languageOptions: {
      // CI's one-shot programs read the first probe from disk; these are mutable lintText sessions.
      parserOptions: {disallowAutomaticSingleRunInference: true},
      parser: {
        ...parser,
        parseForESLint(code: string, options?: Linter.ParserOptions) {
          const result = parseProbe(code, options);
          const filePath: unknown = options?.['filePath'];

          if (typeof filePath !== 'string') {
            throw new Error('The typed probe has no file path');
          }

          const parsed = result.services.program?.getSourceFile(filePath)?.text;

          expect(
            parsed === code,
            'Typed parser must analyze the supplied probe text',
          ).toBe(true);

          return result;
        },
      },
    },
  },
});
const path = fileURLToPath(
  new URL('../src/city/life/world.ts', import.meta.url),
);
const regionPath = fileURLToPath(
  new URL('../src/region/model/world.ts', import.meta.url),
);

async function rejectProbe(
  code: string,
  filePath: string,
  rule: string,
): Promise<void> {
  const config: unknown = await lint.calculateConfigForFile(filePath);

  expect(config).toHaveProperty(['rules', rule, 0], 2);
  const [result] = await lint.lintText(code, {filePath});

  expect(result!.fatalErrorCount).toBe(0);
  expect(result!.messages.map(message => message.ruleId)).toContain(rule);
}

describe('enforced code quality', () => {
  it.each([
    [
      'unseeded regional randomness',
      'export const value = Math.random();',
      'no-restricted-properties',
    ],
    [
      'host clocks in regional model',
      'export const value = Date.now();',
      'no-restricted-globals',
    ],
    [
      'regional rendering dependency',
      "import * as THREE from 'three'; export const value = new THREE.Scene();",
      'no-restricted-imports',
    ],
  ])(
    'rejects %s',
    async (_name, code, rule) => {
      await rejectProbe(code, regionPath, rule);
    },
    20_000,
  );
  it.each([
    [
      'unhandled promises',
      'export function run() { Promise.resolve(1); }',
      '@typescript-eslint/no-floating-promises',
    ],
    [
      'unseeded randomness',
      'export function next() { return Math.random(); }',
      'no-restricted-properties',
    ],
    [
      'host clocks in the simulation',
      'export const now = Date.now();',
      'no-restricted-globals',
    ],
    [
      'rendering imports in the simulation',
      "import * as THREE from 'three'; export const scene = new THREE.Scene();",
      'no-restricted-imports',
    ],
    [
      'missing union cases',
      "export function route(mode: 'walk' | 'car') { switch(mode) { case 'walk': return 1; } }",
      '@typescript-eslint/switch-exhaustiveness-check',
    ],
  ])(
    'rejects %s',
    async (_name, code, rule) => {
      await rejectProbe(code, path, rule);
    },
    20_000,
  );
  it.each([regionPath, path])(
    'accepts a clean typed probe at %s after earlier violations',
    async filePath => {
      const [result] = await lint.lintText('export const qualityProbe = 1;', {
        filePath,
      });

      expect(result!.messages).toEqual([]);
    },
    20_000,
  );
});
