// The release .app ignores `--inspect` (fuse EnableNodeCliInspectArguments off), but Playwright's
// `_electron.launch` always passes `--inspect=0` and waits for the Node debugger. Specs that drive
// the app through Playwright therefore run a clone with that one fuse turned back on and the ad-hoc
// signature redone. They clone the test build (`bun run --cwd packages/desktop build:test`): the same
// shell and fuses as the release, its page built with `window.__sim`, which the release leaves out.
// The clone never ships: every call replaces it from the current build.
import {FuseV1Options, FuseVersion, flipFuses} from '@electron/fuses';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const RELEASE_APP = fileURLToPath(
  new URL('../release/mac-arm64/SimCity.app', import.meta.url),
);
/** `build:test`: the release with `SIMCITY_SIM_API=1` for the page, and nothing else changed. */
export const TEST_APP = fileURLToPath(
  new URL('../release/test/mac-arm64/SimCity.app', import.meta.url),
);
export const INSPECTABLE_APP = fileURLToPath(
  new URL('../release/e2e-inspectable/SimCity.app', import.meta.url),
);

export const binaryOf = (app: string): string =>
  `${app}/Contents/MacOS/SimCity`;

/** `out/build-info.json` as packed in `app` (scripts/build-info.ts); asar keeps files as they are, so it is read from the bytes. */
export function buildInfoOf(app: string): {
  commit: string;
  dirty: boolean;
  test: boolean;
} {
  const asar = readFileSync(`${app}/Contents/Resources/app.asar`, 'latin1');
  const found = /\{"simcityBuild":(\{[^}]*\})\}/.exec(asar);

  if (found === null) {
    throw new Error(`${app} carries no build info: rebuild it`);
  }

  return JSON.parse(found[1]!) as {
    commit: string;
    dirty: boolean;
    test: boolean;
  };
}

/** Fails, naming the command, when the build `app` is missing. */
export function requireBuild(app: string): void {
  const command =
    app === TEST_APP ? 'bun run desktop:build:test' : 'bun run desktop:build';

  if (!existsSync(binaryOf(app))) {
    throw new Error(`${app} is missing: build it first with \`${command}\``);
  }
}

/** APFS clone (`cp -c`) of `source` at INSPECTABLE_APP with only the inspect fuse flipped; returns its binary. */
export async function makeInspectableClone(
  source: string = RELEASE_APP,
): Promise<string> {
  rmSync(dirname(INSPECTABLE_APP), {recursive: true, force: true});
  mkdirSync(dirname(INSPECTABLE_APP), {recursive: true});
  execFileSync('cp', ['-cR', source, INSPECTABLE_APP]);
  await flipFuses(INSPECTABLE_APP, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });

  return binaryOf(INSPECTABLE_APP);
}
