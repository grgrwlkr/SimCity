// Save slots in the origin private file system: `saves/<slot>.json`.
import { checkSlot, type SaveSlotInfo, type SaveStore } from './saveStore';

const DIRECTORY = 'saves';
const SUFFIX = '.json';

/** The part of `FileSystemDirectoryHandle` the store uses; typed here because the DOM lib leaves out `entries()`. */
export interface SaveDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SaveDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, { readonly kind: 'file' | 'directory' }]>;
}

export interface SaveFileHandle {
  getFile(): Promise<{ readonly size: number; readonly lastModified: number; text(): Promise<string> }>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

const opfsRoot = async (): Promise<SaveDirectory> => (await navigator.storage.getDirectory()) as unknown as SaveDirectory;

const isNotFound = (error: unknown): boolean => error instanceof Error && error.name === 'NotFoundError';

export function createOpfsSaveStore(root: () => Promise<SaveDirectory> = opfsRoot): SaveStore {
  let dir: Promise<SaveDirectory> | null = null;
  const saves = (): Promise<SaveDirectory> => (dir ??= root().then((r) => r.getDirectoryHandle(DIRECTORY, { create: true })));
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
        const slot = name.slice(0, -SUFFIX.length);
        slots.push(await info(slot, await d.getFileHandle(name)));
      }
      return slots.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    },
    async save(slot, text) {
      const handle = await (await saves()).getFileHandle(checkSlot(slot) + SUFFIX, { create: true });
      // A writable writes to a swap file and replaces the slot on close: a save cut short leaves the old one.
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return info(slot, handle);
    },
    async load(slot) {
      try {
        const handle = await (await saves()).getFileHandle(checkSlot(slot) + SUFFIX);
        return await (await handle.getFile()).text();
      } catch (error) {
        if (isNotFound(error)) throw new Error(`save slot ${JSON.stringify(slot)} is empty`, { cause: error });
        throw error;
      }
    },
    async remove(slot) {
      try {
        await (await saves()).removeEntry(checkSlot(slot) + SUFFIX);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}
