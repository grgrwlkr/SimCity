// The worker's replies with large buffers move them to the main thread instead of copying them: the save's bytes and
// the layers of a data map. A buffer moved is gone from the worker, so only buffers made for the reply may go.
import { fingerprint, type World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { SIZED_IN_TICKS } from '../../sim/test/scenarios/sizedInTicks';
import { RENDER_CAPACITY, SimHost } from '../src/host';
import { transferablesOf } from '../src/protocol';
import { DATA_MAP_OVERLAYS } from '../src/requests/dataMap';

const worldOf = (host: SimHost): World => (host as unknown as { world: World }).world;

/** Every typed array in `value`, however deep. */
function typedArrays(value: unknown, out: ArrayBufferView[] = []): ArrayBufferView[] {
  if (ArrayBuffer.isView(value)) out.push(value);
  else if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) typedArrays(v, out);
  return out;
}

describe('transfer list', () => {
  it('aSaveMovesItsBytes', () => {
    const host = new SimHost(RENDER_CAPACITY);
    const bytes = host.handle({ t: 'save' });
    expect(transferablesOf('save', bytes)).toEqual([bytes]);
  });

  it('aDataMapMovesItsLayersAndLeavesTheWorldWhole', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    host.handle({ t: 'step', ticks: 700 });
    let moved = 0;
    for (const overlay of DATA_MAP_OVERLAYS) {
      const before = fingerprint(worldOf(host));
      const reply = host.handle({ t: 'dataMap', overlay });
      const kept = structuredClone(reply);
      const list = transferablesOf('dataMap', reply);
      expect(list.length, `${overlay}: one buffer per layer`).toBe(typedArrays(reply).length);
      for (const array of typedArrays(reply)) expect(list.includes(array.buffer as ArrayBuffer), `${overlay}: every layer moves`).toBe(true);
      structuredClone(reply, { transfer: list });
      moved += list.length;
      expect(fingerprint(worldOf(host)), `${overlay}: the world keeps its own arrays`).toBe(before);
      expect(host.handle({ t: 'dataMap', overlay }), `${overlay}: the next reply is whole`).toEqual(kept);
    }
    expect(moved, 'some layer carried numbers').toBeGreaterThan(5);
  }, SIZED_IN_TICKS);

  it('repliesOfTheWorldsOwnArraysMoveNothing', () => {
    const host = new SimHost(RENDER_CAPACITY);
    expect(transferablesOf('mapLayers', host.handle({ t: 'mapLayers' }))).toEqual([]);
    expect(transferablesOf('snapshot', host.handle({ t: 'snapshot' }))).toEqual([]);
    expect(transferablesOf('fingerprint', host.handle({ t: 'fingerprint' }))).toEqual([]);
  });
});
