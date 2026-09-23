// The release shell has no DevTools and no menu that opens them (Q6 = a); the test build and the dev shell keep both.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: () => undefined, whenReady: () => new Promise(() => undefined), isPackaged: true },
  protocol: { registerSchemesAsPrivileged: () => undefined },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined },
  Menu: {},
  net: {},
}));

const { RELEASE_MENU, devToolsAllowed } = await import('../src/main');

describe('release lockdown', () => {
  it('devToolsOnlyInTheTestBuildOrUnpackaged', () => {
    expect(devToolsAllowed({ commit: 'c', dirty: false, test: false }, true)).toBe(false);
    expect(devToolsAllowed(null, true)).toBe(false);
    expect(devToolsAllowed({ commit: 'c', dirty: false, test: true }, true)).toBe(true);
    expect(devToolsAllowed(null, false)).toBe(true);
  });

  it('theReleaseMenuHasNoViewMenu', () => {
    const roles = RELEASE_MENU.map((item) => item.role);
    expect(roles).toEqual(['appMenu', 'editMenu', 'windowMenu']);
    expect(JSON.stringify(RELEASE_MENU)).not.toMatch(/view|devtools|reload/i);
  });
});
