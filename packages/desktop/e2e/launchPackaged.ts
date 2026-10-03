import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/test'));
const coreRequire = createRequire(playwrightRequire.resolve('playwright'));
const LOADER = join(
  dirname(coreRequire.resolve('playwright-core/package.json')),
  'lib/server/electron/loader.js',
);

async function inspectorPort(): Promise<number> {
  const server = createServer();

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The test inspector did not receive a TCP port');
  }

  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );

  return address.port;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function inspectorEndpoint(
  port: number,
  signal: AbortSignal,
): Promise<string> {
  // Poll only for the paused process's inspector to start, never retry a launch.
  while (!signal.aborted) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal,
    }).catch(() => null);
    const targets: unknown = response?.ok ? await response.json() : null;

    if (Array.isArray(targets)) {
      const target: unknown = targets[0];

      if (record(target) && typeof target.webSocketDebuggerUrl === 'string') {
        return target.webSocketDebuggerUrl;
      }
    }

    await delay(25, undefined, {signal});
  }

  signal.throwIfAborted();
  throw new Error('The test inspector did not start');
}

async function installReadinessGate(
  port: number,
  executablePath: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const socket = new WebSocket(await inspectorEndpoint(port, signal));
  let nextId = 0;
  const waitFor = (accept: (message: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      signal.throwIfAborted();

      const cleanup = () => {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== 'string') {
          return;
        }

        const message: unknown = JSON.parse(event.data);

        if (record(message) && accept(message)) {
          cleanup();
          resolve(message);
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error('The startup inspector connection failed'));
      };
      const onAbort = () => {
        cleanup();
        reject(
          new Error('The startup inspector was cancelled', {
            cause: signal.reason,
          }),
        );
      };

      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onError);
      signal.addEventListener('abort', onAbort, {once: true});
    });
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = waitFor(message => message.id === id);

    socket.send(JSON.stringify({id, method, params}));
    const message = await reply;

    if ('error' in message) {
      throw new Error(
        `Startup inspector ${method} failed: ${JSON.stringify(message.error)}`,
      );
    }

    return message;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), {once: true});
      socket.addEventListener(
        'error',
        () => reject(new Error('Cannot open the startup inspector')),
        {once: true},
      );
      signal.addEventListener(
        'abort',
        () => reject(new Error('Startup inspector connection cancelled')),
        {once: true},
      );
    });
    await send('Runtime.enable');

    // Return only the ownership boolean; never log the token or environment.
    const authenticate = async () => {
      const ownership = await send('Runtime.evaluate', {
        expression: `typeof process === 'object' &&
        process.env.SIMCITY_E2E_GATE_TOKEN === ${JSON.stringify(token)} &&
        process.execPath === ${JSON.stringify(executablePath)}`,
        returnByValue: true,
      });
      const ownershipResult = ownership.result;

      if (
        !record(ownershipResult) ||
        !record(ownershipResult.result) ||
        ownershipResult.result.value !== true
      ) {
        throw new Error(
          'The startup inspector does not belong to this test process',
        );
      }
    };

    await send('Debugger.enable');
    const paused = waitFor(message => message.method === 'Debugger.paused');

    await Promise.all([send('Runtime.runIfWaitingForDebugger'), paused]);
    // inspect-brk queues JS evaluation until the first-script pause, even if
    // Runtime.enable reports a context. Authenticate at this earliest usable
    // context, before loading any code or resuming application execution.
    await authenticate();
    const installed = await send('Runtime.evaluate', {
      expression: `(() => {
        require(${JSON.stringify(LOADER)});
        const {app, BrowserWindow} = require('electron');
        return typeof __playwright_run === 'function' &&
          !app.isReady() && BrowserWindow.getAllWindows().length === 0;
      })()`,
      includeCommandLineAPI: true,
      returnByValue: true,
    });
    const result = installed.result;

    if (
      !record(result) ||
      !record(result.result) ||
      result.result.value !== true
    ) {
      throw new Error(
        `Playwright readiness gate was not installed: ${JSON.stringify(installed)}`,
      );
    }

    await send('Debugger.resume');
  } finally {
    socket.close();
  }
}

/**
 * Packaged executablePath launches omit Playwright's loader, and Electron ignores -r.
 * Install that same loader while main is paused, before app.whenReady creates a window.
 * Playwright then releases its own gate after both debugging connections are ready.
 * Only the disposable inspectable clone is used; the packaged app and fuses stay intact.
 */
export async function launchPackaged(
  executablePath: string,
): Promise<ElectronApplication> {
  const port = await inspectorPort();
  const token = randomUUID();
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    cancelled.signal,
    AbortSignal.timeout(30_000),
  ]);
  const launch = electron.launch({
    executablePath,
    args: [`--inspect-brk=127.0.0.1:${port}`],
    env: {
      ...process.env,
      SIMCITY_TEST_WINDOW: '1',
      SIMCITY_E2E_GATE_TOKEN: token,
    },
    timeout: 30_000,
  });
  const gate = installReadinessGate(port, executablePath, token, signal);

  try {
    const [app] = await Promise.all([launch, gate]);

    return app;
  } catch (error) {
    cancelled.abort();
    const app = await launch.catch(() => null);

    await app?.close();
    throw error;
  } finally {
    cancelled.abort();
  }
}
