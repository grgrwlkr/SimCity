// Worker entry: owns the world, runs the fixed-step loop, answers `window.__sim`.
import { RENDER_CAPACITY, SimHost } from './host';
import { isSlotRequest, type FromWorker, type ToWorker } from './protocol';

/** Loop period; the driver turns whatever real time passed into fixed ticks. */
const LOOP_MS = 16;

const host = new SimHost(RENDER_CAPACITY);

function send(message: FromWorker, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

async function answer({ id, req }: ToWorker): Promise<void> {
  // Reply with the failure so the awaiting promise rejects instead of hanging.
  try {
    // Save slots wait on OPFS; every other request is answered before the next message is read.
    const value = isSlotRequest(req) ? await host.handleSlot(req) : host.handle(req);
    // A save's bytes move to the main thread rather than being copied.
    send({ t: 'reply', id, value }, value instanceof ArrayBuffer ? [value] : []);
  } catch (error) {
    send({ t: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
}

addEventListener('message', (event: MessageEvent<ToWorker>) => void answer(event.data));

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
