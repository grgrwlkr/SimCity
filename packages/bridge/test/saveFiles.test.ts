// The worker's OPFS save files against an in-memory directory with OPFS's behaviour: a missing entry is a
// `NotFoundError`, an access handle locks its file, `move` replaces a file of the new name.
import { describe, expect, it } from 'vitest';
import { checkSlot, createOpfsSaveFiles, type SaveAccess, type SaveDirectory, type SaveFileHandle } from '../src/saveFiles';

const notFound = (name: string) => Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });

interface MemoryFile {
  bytes: Uint8Array;
  modified: number;
  locked: boolean;
}

class MemoryDirectory implements SaveDirectory {
  readonly dirs = new Set<string>();
  readonly files = new Map<string, MemoryFile>();
  clock = 1_000;
  /** Bytes a write takes before it fails, as a full disk would: `Infinity` for all. */
  room = Infinity;

  /** One level is enough for the store: its `saves` directory is this one. */
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SaveDirectory> {
    if (!this.dirs.has(name)) {
      if (options?.create !== true) throw notFound(name);
      this.dirs.add(name);
    }
    return this;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle> {
    if (!this.files.has(name)) {
      if (options?.create !== true) throw notFound(name);
      this.files.set(name, { bytes: new Uint8Array(0), modified: this.clock, locked: false });
    }
    let current = name;
    const file = () => this.files.get(current)!;
    return {
      getFile: async () => ({ size: file().bytes.length, lastModified: file().modified }),
      createSyncAccessHandle: async () => {
        const f = file();
        if (f.locked) throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' });
        f.locked = true;
        const access: SaveAccess = {
          getSize: () => f.bytes.length,
          read: (buffer, { at }) => {
            const part = f.bytes.subarray(at, at + buffer.length);
            buffer.set(part);
            return part.length;
          },
          write: (buffer, { at }) => {
            if (buffer.length > this.room) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
            const grown = new Uint8Array(Math.max(f.bytes.length, at + buffer.length));
            grown.set(f.bytes);
            grown.set(buffer, at);
            f.bytes = grown;
            f.modified = this.clock += 1;
            return buffer.length;
          },
          truncate: (size) => void (f.bytes = f.bytes.slice(0, size)),
          flush: () => {},
          close: () => void (f.locked = false),
        };
        return access;
      },
      move: async (to) => {
        const f = file();
        this.files.delete(current);
        this.files.set(to, f);
        current = to;
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw notFound(name);
  }

  async *entries(): AsyncIterable<[string, { readonly kind: 'file' | 'directory' }]> {
    for (const name of this.files.keys()) yield [name, { kind: 'file' }];
  }
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('OPFS save files', () => {
  it('writesListsReadsAndRemovesBySlot', async () => {
    const dir = new MemoryDirectory();
    const files = createOpfsSaveFiles(async () => dir);
    expect(await files.list()).toEqual([]);

    expect(await files.write('slot-b', bytes('{"b":1}'))).toEqual({ slot: 'slot-b', bytes: 7, modifiedMs: 1_001 });
    await files.write('slot_a', bytes('ё'));
    expect([...dir.files.keys()].sort(), 'one file a slot, nothing left half-written').toEqual(['slot-b.json', 'slot_a.json']);
    dir.files.set('notes.txt', { bytes: bytes('not a save'), modified: 0, locked: false });
    expect(await files.list()).toEqual([
      { slot: 'slot-b', bytes: 7, modifiedMs: 1_001 },
      { slot: 'slot_a', bytes: 2, modifiedMs: 1_002 },
    ]);

    await files.write('slot-b', bytes('{"b":22}'));
    expect(text(await files.read('slot-b')), 'a save replaces the slot').toBe('{"b":22}');
    expect(dir.files.get('slot-b.json')!.locked, 'the access handle is closed').toBe(false);
    await files.remove('slot-b');
    await files.remove('slot-b');
    await expect(files.read('slot-b')).rejects.toThrow('save slot "slot-b" is empty');
    expect((await files.list()).map((s) => s.slot)).toEqual(['slot_a']);
  });

  it('aWriteThatFailsLeavesTheSlotAsItWas', async () => {
    const dir = new MemoryDirectory();
    const files = createOpfsSaveFiles(async () => dir);
    await files.write('keep', bytes('old'));
    dir.room = 2;
    await expect(files.write('keep', bytes('newer'))).rejects.toThrow('full');
    expect(text(await files.read('keep'))).toBe('old');
    expect(dir.files.get('keep.json.partial')!.locked, 'the partial file is closed, not left locked').toBe(false);
    dir.room = Infinity;
    await files.write('keep', bytes('newer'));
    expect(text(await files.read('keep'))).toBe('newer');
  });

  it('aFailedOpenIsTriedAgain', async () => {
    let calls = 0;
    const dir = new MemoryDirectory();
    const files = createOpfsSaveFiles(async () => {
      calls += 1;
      if (calls === 1) throw new Error('no storage yet');
      return dir;
    });
    await expect(files.list()).rejects.toThrow('no storage yet');
    expect(await files.list()).toEqual([]);
  });

  it('refusesASlotThatIsNotAFileName', async () => {
    const files = createOpfsSaveFiles(async () => new MemoryDirectory());
    for (const slot of ['', '../x', 'a/b', 'a.json', 'x'.repeat(65)]) {
      expect(() => checkSlot(slot)).toThrow(RangeError);
      await expect(files.write(slot, bytes('x'))).rejects.toThrow(RangeError);
    }
    expect(checkSlot('Quick-Save_1')).toBe('Quick-Save_1');
  });
});
