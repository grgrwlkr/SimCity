// The release .app ignores `--inspect` (fuse EnableNodeCliInspectArguments off), but Playwright's
// `_electron.launch` always passes `--inspect=0` and waits for the Node debugger. Specs that drive
// the app through Playwright therefore run a clone of the same release build with that one fuse
// turned back on and the ad-hoc signature redone. The clone never ships: electron-builder reports
// release/mac-arm64 only, and every call replaces the clone from the current release build.
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_APP = fileURLToPath(new URL('../release/mac-arm64/SimCity.app', import.meta.url));
export const INSPECTABLE_APP = fileURLToPath(new URL('../release/e2e-inspectable/SimCity.app', import.meta.url));

export const binaryOf = (app: string): string => `${app}/Contents/MacOS/SimCity`;

/** APFS clone (`cp -c`) of RELEASE_APP at INSPECTABLE_APP with only the inspect fuse flipped; returns its binary. */
export async function makeInspectableClone(): Promise<string> {
  rmSync(dirname(INSPECTABLE_APP), { recursive: true, force: true });
  mkdirSync(dirname(INSPECTABLE_APP), { recursive: true });
  execFileSync('cp', ['-cR', RELEASE_APP, INSPECTABLE_APP]);
  await flipFuses(INSPECTABLE_APP, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });
  await warmUp(binaryOf(INSPECTABLE_APP));
  return binaryOf(INSPECTABLE_APP);
}

/**
 * Starts the fresh clone once (no window) until Chromium's DevTools server answers, then closes it.
 * The first start of freshly signed code was 12.0 s against 5.3 s for the next ones (measured under
 * load): it is paid here rather than inside a spec's 30 s launch step, and a clone that does not
 * start at all fails here with its output.
 */
async function warmUp(bin: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, SIMCITY_TEST_WINDOW: '1' };
  delete env.NODE_OPTIONS;
  const child = spawn(bin, ['--remote-debugging-port=0'], { env });
  const exited = once(child, 'exit');
  let output = '';
  const cameUp = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/DevTools listening on ws:/.test(output)) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await exited;
  }
  if (!cameUp) throw new Error(`the inspectable clone did not start:\n${output}`);
}
