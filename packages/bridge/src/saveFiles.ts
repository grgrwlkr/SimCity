// Save slots in the origin private file system, from the worker: `saves/<slot>.json`, read and written as bytes
// through a synchronous access handle, so a save of hundreds of megabytes is never a string on the main thread.
import type { SaveSlotInfo } from './protocol';

export interface SaveFiles {
  /** Every saved slot, by name. */
  list(): Promise<SaveSlotInfo[]>;
  /** `bytes` into `slot`, replacing what it held only once they are all written. */
  write(slot: string, bytes: Uint8Array): Promise<SaveSlotInfo>;
  /** The bytes saved in `slot`; rejects when the slot is empty. */
  read(slot: string): Promise<Uint8Array>;
  /** Empties `slot`; an empty slot stays empty. */
  remove(slot: string): Promise<void>;
}

/** The part of OPFS the store uses; typed here because the WebWorker lib leaves out `entries()` and `move()`. */
export interface SaveDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SaveDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, { readonly kind: 'file' | 'directory' }]>;
}

export interface SaveFileHandle {
  getFile(): Promise<{ readonly size: number; readonly lastModified: number }>;
  createSyncAccessHandle(): Promise<SaveAccess>;
  /** Renames the file, replacing a file of that name. */
  move(name: string): Promise<void>;
}

export interface SaveAccess {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const DIRECTORY = 'saves';
const SUFFIX = '.json';
/** Where a save is written before it replaces its slot. */
const PARTIAL = '.partial';
/** A slot name that is a file name everywhere: letters, digits, `-` and `_`, up to 64. */
const SLOT = /^[A-Za-z0-9_-]{1,64}$/;

export function checkSlot(slot: string): string {
  if (!SLOT.test(slot)) throw new RangeError(`save slot ${JSON.stringify(slot)}: use 1 to 64 letters, digits, "-" or "_"`);
  return slot;
}

const isNotFound = (error: unknown): boolean => error instanceof Error && error.name === 'NotFoundError';

async function removeIfThere(dir: SaveDirectory, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

const opfsRoot = async (): Promise<SaveDirectory> => (await navigator.storage.getDirectory()) as unknown as SaveDirectory;

export function createOpfsSaveFiles(root: () => Promise<SaveDirectory> = opfsRoot): SaveFiles {
  let dir: Promise<SaveDirectory> | null = null;
  const saves = (): Promise<SaveDirectory> => {
    // A failed open is not kept: the next call tries again.
    dir ??= root()
      .then((r) => r.getDirectoryHandle(DIRECTORY, { create: true }))
      .catch((error: unknown) => {
        dir = null;
        throw error;
      });
    return dir;
  };
  const info = async (slot: string, handle: SaveFileHandle): Promise<SaveSlotInfo> => {
    const file = await handle.getFile();
    return { slot, bytes: file.size, modifiedMs: file.lastModified };
  };
  return {
    async list() {
      const d = await saves();
      const slots: SaveSlotInfo[] = [];
      for await (const [name, entry] of d.entries()) {
        if (entry.kind !== 'file' || !name.endsWith(SUFFIX)) continue;
        slots.push(await info(name.slice(0, -SUFFIX.length), await d.getFileHandle(name)));
      }
      return slots.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    },
    async write(slot, bytes) {
      const name = checkSlot(slot) + SUFFIX;
      const d = await saves();
      const handle = await d.getFileHandle(name + PARTIAL, { create: true });
      try {
        const access = await handle.createSyncAccessHandle();
        try {
          access.truncate(0);
          if (access.write(bytes, { at: 0 }) !== bytes.length) throw new Error(`save slot ${JSON.stringify(slot)}: the file took fewer bytes than the save`);
          access.flush();
        } finally {
          access.close();
        }
        await handle.move(name);
      } catch (error) {
        // A save cut short must not hold on to the quota: the slot keeps its last whole save.
        await removeIfThere(d, name + PARTIAL);
        throw error;
      }
      return info(slot, handle);
    },
    async read(slot) {
      let handle: SaveFileHandle;
      try {
        handle = await (await saves()).getFileHandle(checkSlot(slot) + SUFFIX);
      } catch (error) {
        if (isNotFound(error)) throw new Error(`save slot ${JSON.stringify(slot)} is empty`, { cause: error });
        throw error;
      }
      const access = await handle.createSyncAccessHandle();
      try {
        const bytes = new Uint8Array(access.getSize());
        if (access.read(bytes, { at: 0 }) !== bytes.length) throw new Error(`save slot ${JSON.stringify(slot)}: the file gave fewer bytes than it holds`);
        return bytes;
      } finally {
        access.close();
      }
    },
    async remove(slot) {
      const d = await saves();
      const name = checkSlot(slot) + SUFFIX;
      await removeIfThere(d, name);
      await removeIfThere(d, name + PARTIAL);
    },
  };
}
