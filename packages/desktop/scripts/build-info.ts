// `bun scripts/build-info.ts release|test`, after the renderer is built: writes out/build-info.json, packed into
// app.asar. main.ts reads `test` (the test build keeps DevTools and the default menu). The desktop e2e requires the
// release and the test build to agree on everything else, so a stale or foreign test build fails instead of standing
// in for the release: the commit and whether the tree was dirty, a hash of the sources the page and the shell are built
// from (a dirty tree or a copy outside git that changed between the two builds differs here), and a hash of the shell
// bundle itself. The renderer bundles differ by design (the test one carries `window.__sim`), so their inputs are hashed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kind = process.argv[2];
if (kind !== 'release' && kind !== 'test') throw new Error(`build-info: release or test, got ${String(kind)}`);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const packages = path.dirname(desktop);
const git = (...args: string[]) => execFileSync('git', args, { cwd: desktop, encoding: 'utf8' }).trim();

/** sha256 over the files under `roots` (relative path and bytes, sorted), node_modules and build output left out. */
function hashOf(roots: string[]): string {
  const files: string[] = [];
  const walk = (at: string) => {
    if (statSync(at).isFile()) return void files.push(at);
    for (const name of readdirSync(at)) if (name !== 'node_modules') walk(path.join(at, name));
  };
  for (const root of roots) walk(root);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(`${path.relative(packages, file)}\0`).update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

const sourceRoots = readdirSync(packages)
  .map((name) => path.join(packages, name, 'src'))
  .filter((src) => statSync(src, { throwIfNoEntry: false })?.isDirectory() === true);
const info = {
  simcityBuild: {
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    sources: hashOf([...sourceRoots, path.join(packages, 'app', 'index.html'), path.join(packages, 'app', 'vite.config.ts')]),
    shell: hashOf([path.join(desktop, 'out', 'main.js'), path.join(desktop, 'out', 'preload.cjs')]),
    test: kind === 'test',
  },
};
const out = path.join(desktop, 'out');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info));
console.log(`build-info: ${JSON.stringify(info)}`);
