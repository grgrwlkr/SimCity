import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const lint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
const path = fileURLToPath(new URL('../src/city/life/world.ts', import.meta.url));

describe('enforced code quality', () => {
  it.each([
    ['unhandled promises', 'export function run() { Promise.resolve(1); }', '@typescript-eslint/no-floating-promises'],
    ['unseeded randomness', 'export function next() { return Math.random(); }', 'no-restricted-properties'],
    ['host clocks in the simulation', 'export const now = Date.now();', 'no-restricted-globals'],
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
      const [result] = await lint.lintText(code, { filePath: path });
      expect(result!.messages.map((message) => message.ruleId)).toContain(rule);
    },
    20_000,
  );
});
