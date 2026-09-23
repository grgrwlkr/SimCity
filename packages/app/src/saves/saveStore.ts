// Where the game's saves live, by slot. The browser build keeps them in the worker's OPFS (`workerStore.ts`), so a save
// never crosses to the main thread; the desktop shell may keep files (E1) behind the same interface, taking a save's
// bytes from the worker's `save` request and handing them back to `load`.
import type { FingerprintReply, SaveSlotInfo, SimClient } from '@simcity/bridge';

export type { SaveSlotInfo } from '@simcity/bridge';

export interface SaveStore {
  /** Every saved slot, by name. */
  list(): Promise<SaveSlotInfo[]>;
  /** The running world into `slot`, replacing what it held. */
  save(slot: string): Promise<SaveSlotInfo>;
  /** The world saved in `slot` in place of the running one; rejects on an empty slot or a broken file, the world as it was. */
  load(slot: string): Promise<FingerprintReply>;
  /** Empties `slot`; an empty slot stays empty. */
  remove(slot: string): Promise<void>;
}

/** Slots the worker keeps in OPFS. */
export function createWorkerSaveStore(client: Pick<SimClient, 'request'>): SaveStore {
  return {
    list: () => client.request({ t: 'listSlots' }),
    save: (slot) => client.request({ t: 'saveSlot', slot }),
    load: (slot) => client.request({ t: 'loadSlot', slot }),
    remove: async (slot) => void (await client.request({ t: 'removeSlot', slot })),
  };
}
