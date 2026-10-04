import {afterEach, expect, it, vi} from 'vitest';

const desktop = vi.hoisted(() => ({
  ready: undefined as (() => void) | undefined,
  loadURL: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: () =>
      new Promise<void>(resolve => {
        desktop.ready = resolve;
      }),
    isPackaged: true,
    exit: vi.fn(),
    getPath: () => '/unused-unit-test-profile',
    commandLine: {hasSwitch: () => false},
  },
  protocol: {registerSchemesAsPrivileged: vi.fn(), handle: vi.fn()},
  BrowserWindow: class {
    webContents = {setWindowOpenHandler: vi.fn(), on: vi.fn()};
    loadURL = desktop.loadURL;
  },
  ipcMain: {handle: vi.fn()},
  Menu: {buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn()},
  net: {},
}));
vi.mock('../src/saves', () => ({registerSaveHandlers: vi.fn()}));

afterEach(() => vi.unstubAllEnvs());

it('opens the packaged menu at the application root while the protocol serves its index', async () => {
  vi.stubEnv('SIMCITY_TEST_WINDOW', '0');
  vi.stubEnv('SIMCITY_DEV_SERVER_URL', undefined);
  await import('../src/main');
  desktop.ready!();
  await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalled());

  expect(desktop.loadURL).toHaveBeenCalledWith('app://bundle/');
});
