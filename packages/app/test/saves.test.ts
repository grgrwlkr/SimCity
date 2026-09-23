// The OPFS save store against an in-memory directory with OPFS's behaviour: a missing entry is a `NotFoundError`.
import { describe, expect, it } from 'vitest';
import { createOpfsSaveStore, type SaveDirectory, type SaveFileHandle } from '../src/saves/opfs';
import { checkSlot } from '../src/saves/saveStore';

const notFound = (name: string) => Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });

class MemoryDirectory implements SaveDirectory {
  readonly dirs = new Map<string, MemoryDirectory>();
  readonly files = new Map<string, { text: string; modified: number }>();
  clock = 1_000;

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SaveDirectory> {
    let dir = this.dirs.get(name);
    if (dir === undefined) {
      if (options?.create !== true) throw notFound(name);
      dir = new MemoryDirectory();
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle> {
    if (!this.files.has(name)) {
      if (options?.create !== true) throw notFound(name);
      this.files.set(name, { text: '', modified: this.clock });
    }
    return {
      getFile: async () => {
        const file = this.files.get(name)!;
        return { size: new TextEncoder().encode(file.text).length, lastModified: file.modified, text: async () => file.text };
      },
      createWritable: async () => {
        let staged = '';
        return {
          write: async (data: string) => void (staged += data),
          close: async () => void this.files.set(name, { text: staged, modified: (this.clock += 1) }),
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound(name);
  }

  async *entries(): AsyncIterable<[string, { readonly kind: 'file' | 'directory' }]> {
    for (const name of this.files.keys()) yield [name, { kind: 'file' }];
    for (const name of this.dirs.keys()) yield [name, { kind: 'directory' }];
  }
}

describe('OPFS save store', () => {
  it('savesListsLoadsAndRemovesBySlot', async () => {
    const root = new MemoryDirectory();
    const store = createOpfsSaveStore(async () => root);
    expect(await store.list()).toEqual([]);

    expect(await store.save('slot-b', '{"b":1}')).toEqual({ slot: 'slot-b', bytes: 7, modifiedMs: 1_001 });
    await store.save('slot_a', 'ё');
    const saves = root.dirs.get('saves')!;
    expect([...saves.files.keys()].sort(), 'one file a slot, in its own directory').toEqual(['slot-b.json', 'slot_a.json']);
    saves.files.set('notes.txt', { text: 'not a save', modified: 0 });
    expect(await store.list()).toEqual([
      { slot: 'slot-b', bytes: 7, modifiedMs: 1_001 },
      { slot: 'slot_a', bytes: 2, modifiedMs: 1_002 },
    ]);

    await store.save('slot-b', '{"b":2}');
    expect(await store.load('slot-b'), 'a save replaces the slot').toBe('{"b":2}');
    await store.remove('slot-b');
    await store.remove('slot-b');
    await expect(store.load('slot-b')).rejects.toThrow('save slot "slot-b" is empty');
    expect((await store.list()).map((s) => s.slot)).toEqual(['slot_a']);
  });

  it('refusesASlotThatIsNotAFileName', async () => {
    const store = createOpfsSaveStore(async () => new MemoryDirectory());
    for (const slot of ['', '../x', 'a/b', 'a.json', 'x'.repeat(65)]) {
      expect(() => checkSlot(slot)).toThrow(RangeError);
      await expect(store.save(slot, 'x')).rejects.toThrow(RangeError);
    }
    expect(checkSlot('Quick-Save_1')).toBe('Quick-Save_1');
  });
});
