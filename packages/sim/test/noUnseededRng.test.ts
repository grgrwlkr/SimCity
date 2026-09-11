// Ported from crates/simcity_sim/src/game/no_thread_rng_guard.rs: production sim code pulls
// randomness only from the seeded StdRng and has no clock of its own. ESLint enforces the same
// rules at edit time; this pin keeps holding if the lint config drifts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SIM_SRC = fileURLToPath(new URL('../src', import.meta.url));

const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bMath\.random\s*\(/, 'Math.random'],
  [/\bcrypto\.(getRandomValues|randomUUID)\s*\(/, 'crypto randomness'],
  [/\bDate\.now\s*\(/, 'Date.now'],
  [/\bnew\s+Date\s*\(/, 'new Date'],
  [/\bperformance\.now\s*\(/, 'performance.now'],
];

function scan(source: string, file: string): string[] {
  const hits: string[] = [];
  source.split('\n').forEach((line, i) => {
    for (const [pattern, label] of BANNED) {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${label}: ${line.trim()}`);
    }
  });
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('no_thread_rng_guard', () => {
  it('noUnseededRngInSimSources', () => {
    const files = sourceFiles(SIM_SRC);
    expect(files.length, 'the guard must actually see the sim sources').toBeGreaterThan(5);
    const hits = files.flatMap((file) => scan(readFileSync(file, 'utf8'), file));
    expect(hits, 'unseeded randomness or a wall clock in sim code (use the world Rng / dtNs)').toEqual([]);
  });

  it('guardFlagsEveryBannedPattern', () => {
    const offender = [
      'const a = Math.random();',
      'const b = crypto.getRandomValues(new Uint32Array(1));',
      'const c = Date.now();',
      'const d = new Date();',
      'const e = performance.now();',
    ].join('\n');
    expect(scan(offender, 'offender.ts')).toHaveLength(BANNED.length);
  });
});
