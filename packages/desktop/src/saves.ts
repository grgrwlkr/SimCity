// The game's saves as files (E1): `<userData>/saves/slot<n>.json`, written by the main process only. The page names a
// slot number and nothing else; the number is checked here, so no path from the renderer ever reaches the disk.
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
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
const PARTIAL = /^slot[1-9]\d{0,2}\.json\..+\.partial$/;
/** A temporary file older than this is left by a crash, not by a save still writing it. */
const STALE_PARTIAL_MS = 60_000;

let partials = 0;

export function createSaveFiles(dir: string) {
  const info = async (slot: number): Promise<SaveFileInfo> => {
    const s = await stat(fileOf(dir, slot));
    return { slot, bytes: s.size, modifiedMs: s.mtimeMs };
  };
  /** Saves and removes of one slot, one after another: the last one asked for is the last one done. */
  const queues = new Map<number, Promise<unknown>>();
  const queued = <T>(slot: number, work: () => Promise<T>): Promise<T> => {
    const done = (queues.get(slot) ?? Promise.resolve()).then(work, work);
    const settled = done.catch(() => undefined);
    queues.set(slot, settled);
    void settled.then(() => {
      if (queues.get(slot) === settled) queues.delete(slot);
    });
    return done;
  };
  return {
    /** Removes temporary files a crashed save left behind (older than a minute); a save in progress keeps its own. */
    async sweep(): Promise<void> {
      const names = await readdir(dir).catch((e: unknown) => (isNotFound(e) ? [] : Promise.reject(e)));
      const before = Date.now() - STALE_PARTIAL_MS;
      for (const name of names.filter((n) => PARTIAL.test(n))) {
        const file = path.join(dir, name);
        const s = await stat(file).catch(() => null);
        if (s !== null && s.mtimeMs < before) await rm(file, { force: true });
      }
    },
    async list(): Promise<SaveFileInfo[]> {
      await this.sweep();
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const slots = names.map((n) => Number(FILE.exec(n)?.[1])).filter((n) => Number.isInteger(n) && n <= MAX_SLOT);
      // A slot removed between readdir and stat is simply not there any more.
      const found = await Promise.all(slots.sort((a, b) => a - b).map((n) => info(n).catch((e: unknown) => (isNotFound(e) ? null : Promise.reject(e)))));
      return found.filter((f) => f !== null);
    },
    /** `bytes` into `slot`, replacing what it held only once they are all written. */
    save(slot: number, bytes: Uint8Array): Promise<SaveFileInfo> {
      const file = fileOf(dir, slot);
      return queued(slot, async () => {
        await mkdir(dir, { recursive: true });
        // A name of its own per write, on disk (fsync) before it replaces the slot, and gone if anything fails.
        const partial = `${file}.${process.pid}-${++partials}.partial`;
        try {
          const handle = await open(partial, 'w');
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(partial, file);
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
        return info(slot);
      });
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
    remove(slot: number): Promise<void> {
      const file = fileOf(dir, slot);
      return queued(slot, () => rm(file, { force: true }));
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

/**
 * One handler per channel; each checks the sender (`trusted`: the game's own page) and then the slot before it
 * touches `dir`.
 */
export function registerSaveHandlers(ipc: IpcHandle, dir: string, trusted: (event: unknown) => boolean): void {
  const files = createSaveFiles(dir);
  void files.sweep().catch((error: unknown) => console.warn('saves: sweeping temporary files failed', error));
  const from = (event: unknown) => {
    if (!trusted(event)) throw new Error('saves: refused a sender that is not the game page');
  };
  ipc.handle(SAVE_CHANNELS.save, async (event, slot, bytes) => {
    from(event);
    return files.save(slotNumber(slot), bytesOf(bytes));
  });
  ipc.handle(SAVE_CHANNELS.load, async (event, slot) => {
    from(event);
    return files.load(slotNumber(slot));
  });
  ipc.handle(SAVE_CHANNELS.list, async (event) => {
    from(event);
    return files.list();
  });
  ipc.handle(SAVE_CHANNELS.remove, async (event, slot) => {
    from(event);
    return files.remove(slotNumber(slot));
  });
}
