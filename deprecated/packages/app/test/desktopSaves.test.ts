// In the desktop shell the save leaves the worker as bytes and the shell keeps it in a file by slot number (E1);
// in the browser the worker keeps it in OPFS. `createSaveStore` picks by whether the shell is there.
import type { Request } from '@simcity/bridge';
import { describe, expect, it } from 'vitest';
import { createDesktopSaveStore, createSaveStore, type DesktopSaves } from '../src/saves/desktopSaveStore';

type Client = Parameters<typeof createDesktopSaveStore>[0];

function fakeClient() {
  const sent: Request[] = [];
  const save = new TextEncoder().encode('{"save":1}').buffer;
  const replies: Record<string, unknown> = {
    save,
    load: { tick: 7, fingerprint: '00000000000000aa' },
    saveSlot: { slot: 'a', bytes: 1, modifiedMs: 1 },
  };
  const client = { request: async (req: Request) => (sent.push(req), replies[req.t]) } as unknown as Client;
  return { client, sent, save };
}

function fakeShell() {
  const calls: unknown[][] = [];
  const files = new Map<number, Uint8Array>();
  const shell: DesktopSaves = {
    save: async (slot, bytes) => {
      calls.push(['save', slot, bytes]);
      files.set(slot, new Uint8Array(bytes.slice(0)));
      return { slot, bytes: bytes.byteLength, modifiedMs: 5 };
    },
    load: async (slot) => {
      calls.push(['load', slot]);
      const bytes = files.get(slot);
      if (bytes === undefined) throw new Error(`save slot ${slot} is empty`);
      return bytes;
    },
    list: async () => (calls.push(['list']), [...files].map(([slot, b]) => ({ slot, bytes: b.byteLength, modifiedMs: 5 }))),
    remove: async (slot) => void calls.push(['remove', slot]),
  };
  return { shell, calls };
}

describe('desktop save store', () => {
  it('movesTheSaveBetweenTheWorkerAndTheShellFiles', async () => {
    const { client, sent, save } = fakeClient();
    const { shell, calls } = fakeShell();
    const store = createDesktopSaveStore(client, shell);
    expect(await store.save('3')).toEqual({ slot: '3', bytes: save.byteLength, modifiedMs: 5 });
    expect(calls[0]).toEqual(['save', 3, save]);
    expect(await store.list()).toEqual([{ slot: '3', bytes: save.byteLength, modifiedMs: 5 }]);
    expect(await store.load('3')).toEqual({ tick: 7, fingerprint: '00000000000000aa' });
    const loaded = sent[1];
    expect(loaded?.t).toBe('load');
    expect(new TextDecoder().decode((loaded as { bytes: ArrayBuffer }).bytes)).toBe('{"save":1}');
    await store.remove('3');
    expect(calls.map((c) => c[0])).toEqual(['save', 'list', 'load', 'remove']);
    expect(sent.map((r) => r.t)).toEqual(['save', 'load']);
  });

  it('aSlotThatIsNotANumberNeverReachesTheShell', async () => {
    const { client, sent } = fakeClient();
    const { shell, calls } = fakeShell();
    const store = createDesktopSaveStore(client, shell);
    for (const slot of ['a', '', '1.5', '0', '256', '01', ' 1', '../1']) {
      await expect(store.save(slot), slot).rejects.toThrow(RangeError);
      await expect(store.load(slot), slot).rejects.toThrow(RangeError);
      await expect(store.remove(slot), slot).rejects.toThrow(RangeError);
    }
    expect({ calls, sent }).toEqual({ calls: [], sent: [] });
  });

  it('picksTheShellFilesOnlyWhenTheShellIsThere', async () => {
    const browser = fakeClient();
    await createSaveStore(browser.client, undefined).save('a');
    expect(browser.sent).toEqual([{ t: 'saveSlot', slot: 'a' }]);
    const desktop = fakeClient();
    const { shell, calls } = fakeShell();
    await createSaveStore(desktop.client, shell).save('1');
    expect(desktop.sent).toEqual([{ t: 'save' }]);
    expect(calls.map((c) => c[0])).toEqual(['save']);
  });
});
