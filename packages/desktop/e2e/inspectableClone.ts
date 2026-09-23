// The release .app ignores `--inspect` (fuse EnableNodeCliInspectArguments off), but Playwright's
// `_electron.launch` always passes `--inspect=0` and waits for the Node debugger. Specs that drive
// the app through Playwright therefore run a clone of the same release build with that one fuse
// turned back on and the ad-hoc signature redone. The clone never ships: electron-builder reports
// release/mac-arm64 only, and every call replaces the clone from the current release build.
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
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
  return binaryOf(INSPECTABLE_APP);
}
