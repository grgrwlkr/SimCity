// `bun run desktop:dev`: the Electron window over the Vite dev server of packages/app. The server
// port comes from `PORT` (5174 by default, as in packages/app); closing the window stops both.
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5174);
const url = `http://localhost:${port}`;
const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = fileURLToPath(new URL('../packages/desktop', import.meta.url));

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(command, args, { cwd, env, stdio: 'inherit' });
}

const exited = (child: ChildProcess) => new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)));

// bun does not run Electron's own postinstall, which downloads the binary: do it here, idempotently.
for (const script of ['electron:install', 'build:main']) {
  const code = await exited(run('bun', ['run', script], desktop));
  if (code !== 0) process.exit(code);
}

const vite = run('bun', ['run', 'dev'], root, { ...process.env, PORT: String(port) });
let up = false;
for (let i = 0; i < 300 && !up; i++) {
  up = await fetch(url).then(() => true, () => false);
  if (!up) await sleep(100);
}
if (!up) {
  vite.kill();
  throw new Error(`the Vite dev server did not answer on ${url}`);
}

const electron = run('bunx', ['electron', '.'], desktop, { ...process.env, SIMCITY_DEV_SERVER_URL: url });
const code = await exited(electron);
vite.kill();
process.exit(code);
