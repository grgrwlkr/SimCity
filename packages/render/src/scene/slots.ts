// Which owner holds which instance of a batch. The instances stay in a dense range `0..count`, so one instanced draw
// covers them; removing an owner moves the last instances into its holes, and the scene copies the moved matrices.

export class SlotTable {
  private readonly owners: number[] = [];
  private readonly byOwner = new Map<number, number[]>();

  get count(): number {
    return this.owners.length;
  }

  ownerOf(slot: number): number | undefined {
    return this.owners[slot];
  }

  slotsOf(owner: number): readonly number[] {
    return this.byOwner.get(owner) ?? [];
  }

  /** A new slot at the end of the range for `owner`. */
  add(owner: number): number {
    const slot = this.owners.length;
    this.owners.push(owner);
    const slots = this.byOwner.get(owner);
    if (slots === undefined) this.byOwner.set(owner, [slot]);
    else slots.push(slot);
    return slot;
  }

  /** Frees every slot of `owner`; returns the moves `[from, to]` the instance data must follow, in order. */
  remove(owner: number): Array<[from: number, to: number]> {
    const slots = this.byOwner.get(owner);
    if (slots === undefined) return [];
    this.byOwner.delete(owner);
    const moves: Array<[number, number]> = [];
    // Highest first: a hole is always filled from past every hole still to come.
    for (const slot of [...slots].sort((a, b) => b - a)) {
      const last = this.owners.length - 1;
      if (slot !== last) {
        const moved = this.owners[last]!;
        this.owners[slot] = moved;
        const theirs = this.byOwner.get(moved)!;
        theirs[theirs.indexOf(last)] = slot;
        moves.push([last, slot]);
      }
      this.owners.pop();
    }
    return moves;
  }
}
