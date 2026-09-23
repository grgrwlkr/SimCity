// The shell's save files (E1): `<dir>/slot<n>.json` by slot number, the number checked in the main process before
// anything touches the disk, and a preload that hands the page nothing but the four slot calls.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SLOT, SAVE_CHANNELS, createSaveFiles, registerSaveHandlers, slotNumber } from '../src/saves';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'simcity-saves-test-'));
  dirs.push(dir);
  return path.join(dir, 'saves');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe('desktop save files', () => {
  it('slotNumberAcceptsOnlyWholeSlotsOneToMax', () => {
    expect(slotNumber(1)).toBe(1);
    expect(slotNumber(MAX_SLOT)).toBe(MAX_SLOT);
    for (const bad of [0, -1, MAX_SLOT + 1, 1.5, Number.NaN, Infinity, '1', '../slot1', null, undefined, {}]) {
      expect(() => slotNumber(bad), String(bad)).toThrow(RangeError);
    }
  });

  it('aSaveComesBackFromItsSlotFile', async () => {
    const dir = tempDir();
    const files = createSaveFiles(dir);
    expect(await files.list()).toEqual([]);
    const info = await files.save(2, bytesOf('{"v":1}'));
    expect(info).toMatchObject({ slot: 2, bytes: 7 });
    expect(readdirSync(dir)).toEqual(['slot2.json']);
    expect(new TextDecoder().decode(await files.load(2))).toBe('{"v":1}');
    await files.save(10, bytesOf('{}'));
    expect((await files.list()).map((s) => s.slot)).toEqual([2, 10]);
    await files.save(2, bytesOf('{"v":2}'));
    expect(new TextDecoder().decode(await files.load(2))).toBe('{"v":2}');
    await files.remove(2);
    await files.remove(2);
    await expect(files.load(2)).rejects.toThrow(/slot 2 is empty/);
    expect(readdirSync(dir)).toEqual(['slot10.json']);
  });

  it('theHandlersRefuseABadSlotBeforeTouchingTheDisk', async () => {
    const dir = tempDir();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerSaveHandlers({ handle: (channel, handler) => void handlers.set(channel, handler) }, dir);
    expect([...handlers.keys()].sort()).toEqual(Object.values(SAVE_CHANNELS).sort());
    const call = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({}, ...args));
    for (const slot of ['../../escape', 0, 256, 1.5, '1']) {
      await expect(call(SAVE_CHANNELS.save, slot, new ArrayBuffer(2)), String(slot)).rejects.toThrow(RangeError);
      await expect(call(SAVE_CHANNELS.load, slot)).rejects.toThrow(RangeError);
      await expect(call(SAVE_CHANNELS.remove, slot)).rejects.toThrow(RangeError);
    }
    await expect(call(SAVE_CHANNELS.save, 1, 'not bytes')).rejects.toThrow(TypeError);
    expect(existsSync(dir)).toBe(false);
    // A good slot takes an ArrayBuffer (what the page sends) and gives the bytes back.
    expect(await call(SAVE_CHANNELS.save, 1, bytesOf('abc').buffer)).toMatchObject({ slot: 1, bytes: 3 });
    expect(new TextDecoder().decode((await call(SAVE_CHANNELS.load, 1)) as Uint8Array)).toBe('abc');
    expect(await call(SAVE_CHANNELS.list)).toMatchObject([{ slot: 1, bytes: 3 }]);
  });
});

describe('desktop preload', () => {
  it('exposesOnlyTheVersionsAndTheFourSlotCalls', async () => {
    const exposed = new Map<string, Record<string, unknown>>();
    const invoke = vi.fn(async () => null);
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => void exposed.set(key, api) },
      ipcRenderer: { invoke },
    }));
    await import('../src/preload');
    expect([...exposed.keys()]).toEqual(['simcityDesktop']);
    const api = exposed.get('simcityDesktop')!;
    expect(Object.keys(api).sort()).toEqual(['chrome', 'electron', 'list', 'load', 'platform', 'remove', 'save']);
    const buffer = new ArrayBuffer(4);
    type Call = (...args: unknown[]) => Promise<unknown>;
    const calls = api as { save: Call; load: Call; list: Call; remove: Call };
    await calls.save(3, buffer, 'extra');
    await calls.load(3, 'extra');
    await calls.list('extra');
    await calls.remove(3, 'extra');
    // Only the slot (and the save's bytes) cross: nothing else the page passes reaches the main process.
    expect(invoke.mock.calls).toEqual([
      [SAVE_CHANNELS.save, 3, buffer],
      [SAVE_CHANNELS.load, 3],
      [SAVE_CHANNELS.list],
      [SAVE_CHANNELS.remove, 3],
    ]);
  });
});
