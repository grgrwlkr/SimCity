// Worker entry: owns the world, runs the fixed-step loop, answers `window.__sim`.
import { RENDER_CAPACITY, SimHost } from './host';
import type { FromWorker, ToWorker } from './protocol';

/** Loop period; the driver turns whatever real time passed into fixed ticks. */
const LOOP_MS = 16;

const host = new SimHost(RENDER_CAPACITY);

function send(message: FromWorker, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const { id, req } = event.data;
  // In arrival order, a slot request holding back those after it; the failure is a reply too, so no promise hangs.
  host.answer(req).then(
    // A save's bytes move to the main thread rather than being copied.
    (value) => send({ t: 'reply', id, value }, value instanceof ArrayBuffer ? [value] : []),
    (error: unknown) => send({ t: 'error', id, message: error instanceof Error ? error.message : String(error) }),
  );
});

function loop(): void {
  // The host logs a frame's error itself; whatever still escapes must not stop the loop.
  try {
    const snapshot = host.update(performance.now());
    if (snapshot !== null) send({ t: 'frame', snapshot });
  } finally {
    setTimeout(loop, LOOP_MS);
  }
}

send({ t: 'ready', render: host.render });
loop();
