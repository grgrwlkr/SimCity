// Where save files live, by slot. The browser keeps them in OPFS (`opfs.ts`); the desktop shell may keep them as
// files (E1) behind the same interface.

/** One saved slot. */
export interface SaveSlotInfo {
  readonly slot: string;
  /** Size of the save file. */
  readonly bytes: number;
  /** When it was last written, ms since the epoch. */
  readonly modifiedMs: number;
}

export interface SaveStore {
  /** Every saved slot, by name. */
  list(): Promise<SaveSlotInfo[]>;
  /** Writes `text` to `slot`, replacing what it held. */
  save(slot: string, text: string): Promise<SaveSlotInfo>;
  /** The text saved in `slot`; rejects when the slot is empty. */
  load(slot: string): Promise<string>;
  /** Empties `slot`; an empty slot stays empty. */
  remove(slot: string): Promise<void>;
}

/** A slot name that is a file name everywhere: letters, digits, `-` and `_`, up to 64. */
const SLOT = /^[A-Za-z0-9_-]{1,64}$/;

export function checkSlot(slot: string): string {
  if (!SLOT.test(slot)) throw new RangeError(`save slot ${JSON.stringify(slot)}: use 1 to 64 letters, digits, "-" or "_"`);
  return slot;
}
