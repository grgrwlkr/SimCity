// `bun run desktop:dev`: the Tauri window over the Vite dev server of packages/app. The dev server
// port comes from `PORT` (5174 by default, as in packages/app), and Tauri is pointed at the same one.
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT ?? 5174);
const config = JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });
const child = spawn('bunx', ['tauri', 'dev', '--config', config], {
  cwd: new URL('../packages/desktop', import.meta.url),
  env: { ...process.env, PORT: String(port) },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
