// The app's save store asks the worker for every slot operation: the save itself never reaches the main thread.
import type { Request } from '@simcity/bridge';
import { describe, expect, it } from 'vitest';
import { createWorkerSaveStore } from '../src/saves/saveStore';

describe('worker save store', () => {
  it('sendsEverySlotOperationToTheWorker', async () => {
    const sent: Request[] = [];
    const replies: Record<string, unknown> = {
      listSlots: [{ slot: 'a', bytes: 3, modifiedMs: 1 }],
      saveSlot: { slot: 'a', bytes: 3, modifiedMs: 1 },
      loadSlot: { tick: 5, fingerprint: '00000000000000ff' },
      removeSlot: null,
    };
    const client = { request: async (req: Request) => (sent.push(req), replies[req.t]) } as unknown as Parameters<typeof createWorkerSaveStore>[0];
    const store = createWorkerSaveStore(client);
    expect(await store.save('a')).toEqual({ slot: 'a', bytes: 3, modifiedMs: 1 });
    expect(await store.list()).toEqual([{ slot: 'a', bytes: 3, modifiedMs: 1 }]);
    expect(await store.load('a')).toEqual({ tick: 5, fingerprint: '00000000000000ff' });
    expect(await store.remove('a')).toBeUndefined();
    expect(sent).toEqual([{ t: 'saveSlot', slot: 'a' }, { t: 'listSlots' }, { t: 'loadSlot', slot: 'a' }, { t: 'removeSlot', slot: 'a' }]);
  });
});
