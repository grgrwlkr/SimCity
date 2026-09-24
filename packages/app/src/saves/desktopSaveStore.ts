// Saves in the desktop shell (E1): the worker hands the world over as a save file's bytes and the shell keeps them in
// `<userData>/saves/slot<n>.json` (packages/desktop/src/saves.ts). Slots there are numbers 1–255; the shell checks
// the number again, this side only refuses early.
import type { FingerprintReply, SaveSlotInfo, SimClient } from '@simcity/bridge';
import { createWorkerSaveStore, type SaveStore } from './saveStore';

export interface DesktopSlotInfo {
  readonly slot: number;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/** What packages/desktop/src/preload.ts adds to `window.simcityDesktop` for saves. */
export interface DesktopSaves {
  save(slot: number, bytes: ArrayBuffer): Promise<DesktopSlotInfo>;
  load(slot: number): Promise<Uint8Array>;
  list(): Promise<DesktopSlotInfo[]>;
  remove(slot: number): Promise<void>;
}

declare global {
  interface Window {
    /** Only inside the desktop shell. */
    simcityDesktop?: Partial<DesktopSaves> & { readonly platform: string };
  }
}

const SLOT = /^[1-9]\d{0,2}$/;
const MAX_SLOT = 255;

function slotNumber(slot: string): number {
  const n = SLOT.test(slot) ? Number(slot) : NaN;
  if (!(n <= MAX_SLOT)) throw new RangeError(`save slot ${JSON.stringify(slot)}: the desktop keeps slots 1 to ${MAX_SLOT}`);
  return n;
}

const slotInfo = (info: DesktopSlotInfo): SaveSlotInfo => ({ slot: String(info.slot), bytes: info.bytes, modifiedMs: info.modifiedMs });

export function createDesktopSaveStore(client: Pick<SimClient, 'request'>, desktop: DesktopSaves): SaveStore {
  return {
    list: async () => (await desktop.list()).map(slotInfo),
    save: async (slot) => {
      const n = slotNumber(slot);
      return slotInfo(await desktop.save(n, await client.request({ t: 'save' })));
    },
    load: async (slot): Promise<FingerprintReply> => {
      const bytes = await desktop.load(slotNumber(slot));
      // The worker takes the buffer over: hand it a copy of exactly the file's bytes.
      return client.request({ t: 'load', bytes: bytes.slice().buffer });
    },
    remove: async (slot) => desktop.remove(slotNumber(slot)),
  };
}

/** Files when the page runs in the desktop shell (`desktop` = `window.simcityDesktop`), the worker's OPFS slots in a browser. */
export function createSaveStore(client: Pick<SimClient, 'request'>, desktop: Partial<DesktopSaves> | undefined): SaveStore {
  const { save, load, list, remove } = desktop ?? {};
  if (save === undefined || load === undefined || list === undefined || remove === undefined) return createWorkerSaveStore(client);
  return createDesktopSaveStore(client, { save, load, list, remove });
}
