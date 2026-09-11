// Port of crates/simcity_sim/src/game/map/dirty.rs: which tiles changed since the render side last
// looked, and the version counters read models key their caches on.

export class DirtyTiles {
  private readonly flags: Uint8Array;
  private list: number[] = [];

  constructor(len: number) {
    this.flags = new Uint8Array(len);
  }

  mark(idx: number): void {
    if (idx >= 0 && idx < this.flags.length && this.flags[idx] === 0) {
      this.flags[idx] = 1;
      this.list.push(idx);
    }
  }

  markAll(): void {
    this.list = [];
    for (let i = 0; i < this.flags.length; i++) {
      this.flags[i] = 1;
      this.list.push(i);
    }
  }

  /** The marked indices in marking order; clears them. */
  drain(): number[] {
    const out = this.list;
    this.list = [];
    for (const i of out) this.flags[i] = 0;
    return out;
  }

  isMarked(idx: number): boolean {
    return this.flags[idx] === 1;
  }

  isEmpty(): boolean {
    return this.list.length === 0;
  }

  /** Marked indices in marking order, without clearing (fingerprint). */
  marked(): readonly number[] {
    return this.list;
  }
}

/** `GraphVersion::bump` / `MapEditVersion::bump`: never 0 after a bump. */
export function bumpVersion(version: number): number {
  const next = version + 1;
  return next > Number.MAX_SAFE_INTEGER ? 1 : next;
}
