// Gate 6b: a save loaded into a new world gives back the fingerprint, through the host: the save slots the worker
// keeps (`saveSlot`/`loadSlot`) and the bytes a store outside it would keep (`save`/`load`).
import { SaveError } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { SIZED_IN_TICKS } from '../../sim/test/scenarios/sizedInTicks';
import { RENDER_CAPACITY, SimHost } from '../src/host';
import type { Request, SaveSlotInfo } from '../src/protocol';
import type { SaveFiles } from '../src/saveFiles';

/** Save slots in memory, shared by the hosts of a test as OPFS is by the page's workers. */
function memoryFiles(): SaveFiles {
  const slots = new Map<string, { bytes: Uint8Array; info: SaveSlotInfo }>();
  return {
    list: async () => [...slots.values()].map((s) => s.info),
    write: async (slot, bytes) => {
      const info = { slot, bytes: bytes.length, modifiedMs: slots.size };
      slots.set(slot, { bytes: bytes.slice(), info });
      return info;
    },
    read: async (slot) => {
      const saved = slots.get(slot);
      if (saved === undefined) throw new Error(`save slot "${slot}" is empty`);
      return saved.bytes.slice();
    },
    remove: async (slot) => void slots.delete(slot),
  };
}

/** A host running `scenario` for `ticks`, and the tick and fingerprint it stopped at. */
function running(scenario: Extract<Request, { t: 'scenario' }>, ticks: number, files: SaveFiles) {
  const host = new SimHost(RENDER_CAPACITY, files);
  host.handle({ t: 'setState', state: 'InGame' });
  host.handle(scenario);
  return { host, at: host.handle({ t: 'step', ticks }) };
}

/** A host that has already built another scenario: the load must replace its world, not add to it. */
function otherHost(files: SaveFiles): SimHost {
  const host = new SimHost(RENDER_CAPACITY, files);
  host.handle({ t: 'setState', state: 'InGame' });
  host.handle({ t: 'scenario', name: 'signalizedCross' });
  host.handle({ t: 'step', ticks: 10 });
  return host;
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

describe('save through the host', () => {
  it('livingCityAfter3000TicksLoadsIntoANewWorldWithItsFingerprint', async () => {
    const files = memoryFiles();
    const { host, at } = running({ t: 'scenario', name: 'livingCity' }, 3000, files);
    const saved = await host.handleSlot({ t: 'saveSlot', slot: 'living' });
    expect(saved.slot).toBe('living');
    const other = otherHost(files);
    expect(other.handle({ t: 'fingerprint' }).fingerprint).not.toBe(at.fingerprint);
    expect(await other.handleSlot({ t: 'loadSlot', slot: 'living' })).toEqual(at);
    expect(other.handle({ t: 'snapshot' }).tick).toBe(3000);
    // The loaded world goes on as the saved one does.
    expect(other.handle({ t: 'step', ticks: 300 })).toEqual(host.handle({ t: 'step', ticks: 300 }));
  }, SIZED_IN_TICKS);

  it('metropolis256After1200TicksLoadsIntoANewWorldWithItsFingerprint', async () => {
    const files = memoryFiles();
    const { host, at } = running({ t: 'scenario', name: 'metropolis', size: 256 }, 1200, files);
    await host.handleSlot({ t: 'saveSlot', slot: 'metropolis' });
    const other = otherHost(files);
    expect(await other.handleSlot({ t: 'loadSlot', slot: 'metropolis' })).toEqual(at);
    expect(other.handle({ t: 'step', ticks: 100 })).toEqual(host.handle({ t: 'step', ticks: 100 }));
  }, SIZED_IN_TICKS);

  it('theBytesOfASaveLoadElsewhereAsTheSlotsDo', async () => {
    // The seam for a store outside the worker (E1): the save as bytes out, the same bytes back in.
    const { host, at } = running({ t: 'scenario', name: 'signalizedCross4' }, 20, memoryFiles());
    const bytes = host.handle({ t: 'save' });
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(bytes.slice(0, 40))).toMatch(/^\{"format":"simcity-save","version":1,/);
    const other = otherHost(memoryFiles());
    expect(other.handle({ t: 'load', bytes })).toEqual(at);
    await other.handleSlot({ t: 'saveSlot', slot: 'copy' });
    expect(await other.handleSlot({ t: 'listSlots' })).toEqual([{ slot: 'copy', bytes: bytes.byteLength, modifiedMs: 0 }]);
    await other.handleSlot({ t: 'removeSlot', slot: 'copy' });
    await expect(other.handleSlot({ t: 'loadSlot', slot: 'copy' })).rejects.toThrow('save slot "copy" is empty');
  }, SIZED_IN_TICKS);

  it('requestsAreAnsweredInTheOrderTheyCame', async () => {
    // A load waiting on its file holds back the scenario and the step sent after it: they apply to the loaded world.
    const files = memoryFiles();
    const { host, at } = running({ t: 'scenario', name: 'signalizedCross4' }, 20, files);
    await host.handleSlot({ t: 'saveSlot', slot: 'order' });
    let release = (): void => {};
    const opened = new Promise<void>((resolve) => (release = resolve));
    const slow: SaveFiles = { ...files, read: async (slot) => (await opened, files.read(slot)) };
    const other = otherHost(slow);
    const loaded = other.answer({ t: 'loadSlot', slot: 'order' });
    const built = other.answer({ t: 'scenario', name: 'signalizedCross' });
    const stepped = other.answer({ t: 'step', ticks: 5 });
    release();
    expect(await loaded).toEqual(at);
    await built;
    const after = (await stepped) as { tick: number; fingerprint: string };

    const reference = otherHost(memoryFiles());
    reference.handle({ t: 'load', bytes: host.handle({ t: 'save' }) });
    reference.handle({ t: 'scenario', name: 'signalizedCross' });
    expect(after).toEqual(reference.handle({ t: 'step', ticks: 5 }));
    expect(after.tick).toBe(at.tick + 5);
    // Nothing waiting: an immediate request is answered at once, a failing one rejects.
    expect(await other.answer({ t: 'fingerprint' })).toEqual(after);
    await expect(other.answer({ t: 'load', bytes: new ArrayBuffer(1) })).rejects.toThrow(SaveError);
  }, SIZED_IN_TICKS);

  it('aBrokenFileIsRejectedAndTheWorldIsUntouched', async () => {
    const { host } = running({ t: 'scenario', name: 'signalizedCross4' }, 20, memoryFiles());
    const text = new TextDecoder().decode(host.handle({ t: 'save' }));
    const files = memoryFiles();
    const other = otherHost(files);
    const before = other.handle({ t: 'fingerprint' });
    const snapshot = other.handle({ t: 'snapshot' });
    const file = JSON.parse(text) as { version: number; world: Record<string, unknown> };
    for (const [broken, message] of [
      [text.slice(0, text.length - 1), /^save rejected: not JSON/],
      [JSON.stringify({ ...file, version: 3 }), /^save rejected: version: /],
      [JSON.stringify({ ...file, world: { ...file.world, citizens: { $: 'cls', c: 'Citizens', v: { count: { $: 'big', v: '1.5' } } } } }), /^save rejected: world\.citizens\.count/],
      [JSON.stringify({ ...file, world: { ...file.world, buildings: undefined } }), /^save rejected: world\.buildings: missing$/],
    ] as const) {
      expect(() => other.handle({ t: 'load', bytes: bytesOf(broken) })).toThrow(SaveError);
      expect(() => other.handle({ t: 'load', bytes: bytesOf(broken) })).toThrow(message);
      await files.write('broken', new TextEncoder().encode(broken));
      await expect(other.handleSlot({ t: 'loadSlot', slot: 'broken' })).rejects.toThrow(message);
      expect(other.handle({ t: 'fingerprint' })).toEqual(before);
    }
    expect(other.handle({ t: 'snapshot' }).mapEditVersion).toBe(snapshot.mapEditVersion);
  }, SIZED_IN_TICKS);
});
