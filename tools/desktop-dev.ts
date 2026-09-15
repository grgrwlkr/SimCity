// `bun run desktop:dev`: the Electron window over the Vite dev server of packages/app. The server
// port comes from `PORT` (5174 by default, as in packages/app); closing the window stops both.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
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

/**
 * Whether anything, HTTP or not, already accepts connections on the dev port. `localhost` is both
 * addresses: a server on either one can answer the window, so both are probed.
 */
async function portTaken(): Promise<boolean> {
  const taken = await Promise.all(['127.0.0.1', '::1'].map(accepts));
  return taken.includes(true);
}

function accepts(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

// Refuse before Vite starts: otherwise the window would open over whatever answers on that port.
if (await portTaken()) {
  console.error(`desktop:dev: port ${port} is already taken; free it or set PORT`);
  process.exit(1);
}

// bun does not run Electron's own postinstall, which downloads the binary: do it here, idempotently.
for (const script of ['electron:install', 'build:main']) {
  const code = await exited(run('bun', ['run', script], desktop));
  if (code !== 0) process.exit(code);
}

const vite = run('bun', ['run', 'dev'], root, { ...process.env, PORT: String(port) });
const viteExited = exited(vite);
const answering = (async () => {
  for (let i = 0; i < 300; i++) {
    if (await fetch(url).then(() => true, () => false)) return true;
    await sleep(100);
  }
  return false;
})();
// Vite leaving first (a port taken in the meantime, a config error) ends the script at once.
const first = await Promise.race([
  viteExited.then((code) => ({ viteExit: code })),
  answering.then((up) => ({ up })),
]);
if ('viteExit' in first) {
  console.error(`desktop:dev: the Vite dev server exited with code ${first.viteExit} before answering on ${url}`);
  process.exit(first.viteExit === 0 ? 1 : first.viteExit);
}
if (!first.up) {
  vite.kill();
  throw new Error(`the Vite dev server did not answer on ${url}`);
}

const electron = run('bunx', ['electron', '.'], desktop, { ...process.env, SIMCITY_DEV_SERVER_URL: url });
const code = await exited(electron);
vite.kill();
process.exit(code);
