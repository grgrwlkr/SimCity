// The game's saves as files (E1): `<userData>/saves/slot<n>.json`, written by the main process only. The page names a
// slot number and nothing else; the number is checked here, so no path from the renderer ever reaches the disk.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The highest slot, as the Rust build's `u8` slot. */
export const MAX_SLOT = 255;

/** The IPC channels; preload.ts repeats them (a sandboxed preload cannot import this file's `node:fs`). */
export const SAVE_CHANNELS = {
  save: 'simcity:saves:save',
  load: 'simcity:saves:load',
  list: 'simcity:saves:list',
  remove: 'simcity:saves:remove',
} as const;

export interface SaveFileInfo {
  readonly slot: number;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/** `value` as a slot: a whole number from 1 to MAX_SLOT, nothing else. */
export function slotNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_SLOT) {
    throw new RangeError(`save slot ${String(value)}: a whole number from 1 to ${MAX_SLOT}`);
  }
  return value;
}

const FILE = /^slot([1-9]\d{0,2})\.json$/;
const fileOf = (dir: string, slot: number) => path.join(dir, `slot${slotNumber(slot)}.json`);
const isNotFound = (error: unknown) => (error as { code?: unknown }).code === 'ENOENT';

export function createSaveFiles(dir: string) {
  const info = async (slot: number): Promise<SaveFileInfo> => {
    const s = await stat(fileOf(dir, slot));
    return { slot, bytes: s.size, modifiedMs: s.mtimeMs };
  };
  return {
    async list(): Promise<SaveFileInfo[]> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const slots = names.map((n) => Number(FILE.exec(n)?.[1])).filter((n) => Number.isInteger(n) && n <= MAX_SLOT);
      return Promise.all(slots.sort((a, b) => a - b).map(info));
    },
    /** `bytes` into `slot`, replacing what it held only once they are all written. */
    async save(slot: number, bytes: Uint8Array): Promise<SaveFileInfo> {
      const file = fileOf(dir, slot);
      await mkdir(dir, { recursive: true });
      const partial = `${file}.partial`;
      await writeFile(partial, bytes);
      await rename(partial, file);
      return info(slot);
    },
    async load(slot: number): Promise<Uint8Array> {
      try {
        return await readFile(fileOf(dir, slot));
      } catch (error) {
        if (isNotFound(error)) throw new Error(`save slot ${slot} is empty`, { cause: error });
        throw error;
      }
    },
    /** An empty slot stays empty. */
    async remove(slot: number): Promise<void> {
      await rm(fileOf(dir, slot), { force: true });
    },
  };
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('a save is an ArrayBuffer');
}

/** The part of `ipcMain` the handlers need. */
export interface IpcHandle {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** One handler per channel; each checks the slot before it touches `dir`. */
export function registerSaveHandlers(ipc: IpcHandle, dir: string): void {
  const files = createSaveFiles(dir);
  ipc.handle(SAVE_CHANNELS.save, async (_event, slot, bytes) => files.save(slotNumber(slot), bytesOf(bytes)));
  ipc.handle(SAVE_CHANNELS.load, async (_event, slot) => files.load(slotNumber(slot)));
  ipc.handle(SAVE_CHANNELS.list, async () => files.list());
  ipc.handle(SAVE_CHANNELS.remove, async (_event, slot) => files.remove(slotNumber(slot)));
}
