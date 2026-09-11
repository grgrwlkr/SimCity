// The A* open set shared by road-A* and the lanelet planner.

/** Min-heap on `(f, g, idx)`: the order Rust's reversed `BinaryHeap<HeapState>` pops in. */
export class OpenSet {
  private readonly f: number[] = [];
  private readonly g: number[] = [];
  private readonly idx: number[] = [];

  get size(): number {
    return this.idx.length;
  }

  private less(i: number, j: number): boolean {
    const fi = this.f[i]!;
    const fj = this.f[j]!;
    if (fi !== fj) return fi < fj;
    const gi = this.g[i]!;
    const gj = this.g[j]!;
    if (gi !== gj) return gi < gj;
    return this.idx[i]! < this.idx[j]!;
  }

  private swap(i: number, j: number): void {
    for (const a of [this.f, this.g, this.idx]) {
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
  }

  push(f: number, g: number, idx: number): void {
    this.f.push(f);
    this.g.push(g);
    this.idx.push(idx);
    let i = this.idx.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Removes the minimum; returns `[g, idx]`. */
  pop(): readonly [number, number] {
    const g = this.g[0]!;
    const idx = this.idx[0]!;
    const last = this.idx.length - 1;
    this.swap(0, last);
    this.f.pop();
    this.g.pop();
    this.idx.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < this.idx.length && this.less(l, smallest)) smallest = l;
      if (r < this.idx.length && this.less(r, smallest)) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
    return [g, idx];
  }
}
