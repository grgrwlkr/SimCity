// Worker entry: owns the world, runs the fixed-step loop, answers `window.__sim`.
import { VEHICLE_CAPACITY } from '@simcity/sim';
import { SimHost } from './host';
import type { FromWorker, ToWorker } from './protocol';

/** Loop period; the driver turns whatever real time passed into fixed ticks. */
const LOOP_MS = 16;

const host = new SimHost(VEHICLE_CAPACITY);

function send(message: FromWorker): void {
  postMessage(message);
}

addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const { id, req } = event.data;
  // Reply with the failure so the awaiting promise rejects instead of hanging.
  try {
    send({ t: 'reply', id, value: host.handle(req) });
  } catch (error) {
    send({ t: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
});

function loop(): void {
  const snapshot = host.update(performance.now());
  if (snapshot !== null) send({ t: 'frame', snapshot });
  setTimeout(loop, LOOP_MS);
}

send({ t: 'ready', render: host.render });
loop();
