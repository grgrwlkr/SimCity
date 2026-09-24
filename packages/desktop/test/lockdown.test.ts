// The release shell has no DevTools and no menu that opens them (Q6 = a); the test build and the dev shell keep both.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: () => undefined, whenReady: () => new Promise(() => undefined), isPackaged: true, exit: () => undefined, commandLine: { hasSwitch: () => false } },
  protocol: { registerSchemesAsPrivileged: () => undefined },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined },
  Menu: {},
  net: {},
}));

const { RELEASE_MENU, devToolsAllowed, remoteDebuggingRefused } = await import('../src/main');

describe('release lockdown', () => {
  it('devToolsOnlyInTheTestBuildOrUnpackaged', () => {
    expect(devToolsAllowed({ commit: 'c', dirty: false, test: false }, true)).toBe(false);
    expect(devToolsAllowed(null, true)).toBe(false);
    expect(devToolsAllowed({ commit: 'c', dirty: false, test: true }, true)).toBe(true);
    expect(devToolsAllowed(null, false)).toBe(true);
  });

  it('theReleaseRefusesRemoteDebuggingAndTheTestBuildDoesNot', () => {
    const switches = (...on: string[]) => (name: string) => on.includes(name);
    expect(remoteDebuggingRefused(false, switches('remote-debugging-port'))).toBe(true);
    expect(remoteDebuggingRefused(false, switches('remote-debugging-pipe'))).toBe(true);
    expect(remoteDebuggingRefused(false, switches())).toBe(false);
    expect(remoteDebuggingRefused(true, switches('remote-debugging-port', 'remote-debugging-pipe'))).toBe(false);
  });

  it('theReleaseMenuHasNoViewMenu', () => {
    const roles = RELEASE_MENU.map((item) => item.role);
    expect(roles).toEqual(['appMenu', 'editMenu', 'windowMenu']);
    expect(JSON.stringify(RELEASE_MENU)).not.toMatch(/view|devtools|reload/i);
  });
});
