// `bun scripts/build-info.ts release|test`: writes out/build-info.json, packed into app.asar. main.ts reads `test` (the
// test build keeps DevTools and the default menu); the desktop e2e compares `commit` and `dirty` of the release and the
// test build, so a stale test build fails instead of standing in for the release.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const kind = process.argv[2];
if (kind !== 'release' && kind !== 'test') throw new Error(`build-info: release or test, got ${String(kind)}`);
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const info = { simcityBuild: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '', test: kind === 'test' } };
const out = fileURLToPath(new URL('../out/', import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}build-info.json`, JSON.stringify(info));
console.log(`build-info: ${JSON.stringify(info)}`);
