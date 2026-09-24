// What the release .app itself carries: its own icon and the Electron fuses flipped in afterPack
// (scripts/after-pack.mjs). The fuses are read from the packaged binary and then checked by
// behaviour: the release binary is started (SIMCITY_TEST_WINDOW=1, nothing on screen) with the
// switch a fuse should neutralise, and must come up as the app anyway.
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { INSPECTABLE_APP, RELEASE_APP, TEST_APP, binaryOf, makeInspectableClone, requireBuild } from './inspectableClone';

const BUILD_ICNS = fileURLToPath(new URL('../build/icon.icns', import.meta.url));

test.skip(!existsSync(binaryOf(RELEASE_APP)), 'build the app first: bun run desktop:build');

/** Fuse name -> 'on' | 'off' as read from the Electron Framework binary of `app`. */
async function fusesOf(app: string): Promise<Record<string, string>> {
  const wire = (await getCurrentFuseWire(app)) as unknown as Record<string, number>;
  const named: Record<string, string> = {};
  for (const [index, value] of Object.entries(wire)) {
    if (index === 'version') continue;
    const name = FuseV1Options[Number(index)] ?? `fuse${index}`;
    named[name] = value === FuseState.ENABLE ? 'on' : value === FuseState.DISABLE ? 'off' : `state ${value}`;
  }
  return named;
}

/**
 * Starts the release binary without a window and waits for main.ts's `simcity: test window loaded` line, which only the
 * app (not a Node process) prints once its page loaded. The release refuses a debugging port, so that is the signal.
 * Returns whether it came and everything printed.
 */
async function startRelease(args: string[], env: Record<string, string> = {}): Promise<{ app: boolean; output: string }> {
  const base = { ...process.env };
  delete base.NODE_OPTIONS;
  const child = spawn(binaryOf(RELEASE_APP), args, {
    env: { ...base, SIMCITY_TEST_WINDOW: '1', ...env },
  });
  let output = '';
  const exited = once(child, 'exit');
  const cameUp = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/simcity: test window loaded/.test(output)) {
        clearTimeout(timer);
        // A Node inspector would have announced itself before the page loaded.
        setTimeout(() => resolve(true), 1000);
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
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(killer);
  }
  return { app: cameUp, output };
}

test('theAppCarriesItsOwnIcon', () => {
  const plist = `${RELEASE_APP}/Contents/Info.plist`;
  const iconFile = execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist]).toString().trim();
  expect(iconFile).toBe('icon.icns');
  const shipped = readFileSync(`${RELEASE_APP}/Contents/Resources/icon.icns`);
  expect(shipped.equals(readFileSync(BUILD_ICNS))).toBe(true);
});

test('theReleaseBinaryCarriesTheChosenFuses', async () => {
  expect(await fusesOf(RELEASE_APP)).toEqual({
    RunAsNode: 'off',
    EnableCookieEncryption: 'off',
    EnableNodeOptionsEnvironmentVariable: 'off',
    EnableNodeCliInspectArguments: 'off',
    EnableEmbeddedAsarIntegrityValidation: 'on',
    OnlyLoadAppFromAsar: 'on',
    LoadBrowserProcessSpecificV8Snapshot: 'off',
    GrantFileProtocolExtraPrivileges: 'off',
    WasmTrapHandlers: 'on',
  });
});

test('theTestBuildCarriesTheReleaseFuses', async () => {
  requireBuild(TEST_APP);
  expect(await fusesOf(TEST_APP)).toEqual(await fusesOf(RELEASE_APP));
});

test('theTestCloneDiffersFromTheReleaseByTheInspectFuseOnly', async () => {
  await makeInspectableClone();
  const release = await fusesOf(RELEASE_APP);
  const clone = await fusesOf(INSPECTABLE_APP);
  const differing = Object.keys(release).filter((name) => release[name] !== clone[name]);
  expect(differing).toEqual(['EnableNodeCliInspectArguments']);
  expect(clone.EnableNodeCliInspectArguments).toBe('on');
});

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('theReleaseRefusesRemoteDebugging', async () => {
  for (const flag of ['--remote-debugging-port', '--remote-debugging-pipe']) {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, SIMCITY_TEST_WINDOW: '1' };
    delete env.NODE_OPTIONS;
    const child = spawn(binaryOf(RELEASE_APP), [flag === '--remote-debugging-port' ? `${flag}=${port}` : flag], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const [code] = (await once(child, 'exit')) as [number | null];
    clearTimeout(killer);
    const listed = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.status, () => 'refused');
    expect({ flag, code, listed, loaded: /simcity: test window loaded/.test(output) }, output).toEqual({
      flag,
      code: 1,
      listed: 'refused',
      loaded: false,
    });
  }
});

test('theReleaseBinaryIgnoresNodeInspectFlags', async () => {
  const { app, output } = await startRelease(['--inspect=0']);
  expect({ app, nodeInspector: /Debugger listening/.test(output) }, output).toEqual({ app: true, nodeInspector: false });
});

test('theReleaseBinaryDoesNotRunAsNode', async () => {
  const { app, output } = await startRelease(['-e', 'console.log("ran as node")'], { ELECTRON_RUN_AS_NODE: '1' });
  expect({ app, ranAsNode: /ran as node/.test(output) }, output).toEqual({ app: true, ranAsNode: false });
});

test('theReleaseBinaryIgnoresNodeOptions', async () => {
  // A packaged app that reads NODE_OPTIONS drops `--require` with a warning that names NODE_OPTIONs;
  // with the fuse off the variable is not read at all.
  const { app, output } = await startRelease([], { NODE_OPTIONS: '--require=/nonexistent/simcity-fuse-probe.cjs' });
  expect({ app, nodeOptionsRead: /NODE_OPTION|simcity-fuse-probe/.test(output) }, output).toEqual({
    app: true,
    nodeOptionsRead: false,
  });
});
