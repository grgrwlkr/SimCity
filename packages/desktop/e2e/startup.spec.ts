import {expect, test} from '@playwright/test';
import {launchPackaged} from './launchPackaged';
import {makeInspectableClone, requireBuild, TEST_APP} from './inspectableClone';

let executablePath = '';

test.beforeAll(async () => {
  requireBuild(TEST_APP);
  executablePath = await makeInspectableClone(TEST_APP);
});

test('packaged startup gates readiness until Playwright connects and stays hidden', async () => {
  const app = await launchPackaged(executablePath);

  try {
    const page = await app.firstWindow();

    await expect(
      page.getByRole('navigation', {name: 'Главное меню'}),
    ).toBeVisible();
    await expect(page).toHaveURL('app://bundle/');
    const state = await app.evaluate(({app, BrowserWindow}) => ({
      gate: typeof (globalThis as {__playwright_run?: unknown})
        .__playwright_run,
      ready: app.isReady(),
      dock: app.dock?.isVisible() ?? false,
      windows: BrowserWindow.getAllWindows().map(window => {
        const contents = window.webContents;

        if (
          !('getLastWebPreferences' in contents) ||
          typeof contents.getLastWebPreferences !== 'function'
        ) {
          throw new Error(
            'Electron does not expose the observed window preferences',
          );
        }

        const getPreferences = contents.getLastWebPreferences as () => unknown;
        const preferences = getPreferences.call(contents);

        if (
          typeof preferences !== 'object' ||
          preferences === null ||
          !('sandbox' in preferences) ||
          !('contextIsolation' in preferences) ||
          !('nodeIntegration' in preferences)
        ) {
          throw new Error('Electron returned no window security preferences');
        }

        return {
          visible: window.isVisible(),
          focused: window.isFocused(),
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
        };
      }),
    }));

    expect(state).toEqual({
      gate: 'function',
      ready: true,
      dock: false,
      windows: [
        {
          visible: false,
          focused: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      ],
    });
  } finally {
    await app.close();
  }
});
