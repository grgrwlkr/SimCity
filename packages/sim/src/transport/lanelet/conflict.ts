// Port of crates/simcity_sim/src/game/transport/lanelet/conflict.rs. A row is a bitset of 32-bit
// words (Rust uses u64): the intersection arbiter ANDs rows every tick, and BigInt would be slow there.
import type { TilePos } from '../../commands';
import { tileKey } from '../../map/grid';

const WORD_BITS = 32;
const EMPTY_ROW = new Uint32Array(0);

function setBit(row: Uint32Array, bit: number): void {
  row[bit >>> 5] = row[bit >>> 5]! | (1 << (bit & 31));
}

/**
 * Per-intersection conflict matrix: lanelet `i` conflicts with `j` iff their internal paths share a
 * tile (or the pair was forced). Symmetric, no diagonal. Crosswalk rows follow the vehicle lanelets.
 */
export class ConflictMatrix {
  private constructor(
    private readonly rows: Uint32Array[],
    private readonly n: number,
    private readonly base: number,
  ) {}

  static fromPaths(paths: ReadonlyArray<readonly TilePos[]>): ConflictMatrix {
    return ConflictMatrix.build(paths, paths.length);
  }

  /** Like `fromPaths`, with `crosswalks` appended as rows starting at `crosswalkBase()`. */
  static fromPathsWithCrosswalks(
    lanelets: ReadonlyArray<readonly TilePos[]>,
    crosswalks: ReadonlyArray<readonly TilePos[]>,
  ): ConflictMatrix {
    return ConflictMatrix.build([...lanelets, ...crosswalks], lanelets.length);
  }

  private static build(paths: ReadonlyArray<readonly TilePos[]>, base: number): ConflictMatrix {
    const n = paths.length;
    const words = Math.ceil(n / WORD_BITS);
    const rows = Array.from({ length: n }, () => new Uint32Array(words));
    const occupancy = new Map<number, number[]>();
    paths.forEach((path, i) => {
      for (const tile of path) {
        const key = tileKey(tile);
        const list = occupancy.get(key);
        if (list === undefined) occupancy.set(key, [i]);
        else list.push(i);
      }
    });
    for (const lanelets of occupancy.values()) {
      for (const a of lanelets) {
        for (const b of lanelets) {
          if (a !== b) setBit(rows[a]!, b);
        }
      }
    }
    return new ConflictMatrix(rows, n, base);
  }

  /** Force a conflict the geometry cannot express (ПДД 13.12: a left or U turn yields to the oncoming through). */
  addConflictPair(a: number, b: number): void {
    if (a === b || a >= this.n || b >= this.n) return;
    setBit(this.rows[a]!, b);
    setBit(this.rows[b]!, a);
  }

  crosswalkBase(): number {
    return this.base;
  }

  conflicts(a: number, b: number): boolean {
    if (a === b || a >= this.n || b >= this.n) return false;
    return ((this.rows[a]![b >>> 5]! >>> (b & 31)) & 1) === 1;
  }

  row(a: number): Uint32Array {
    return this.rows[a] ?? EMPTY_ROW;
  }

  len(): number {
    return this.n;
  }

  isEmpty(): boolean {
    return this.n === 0;
  }
}

/** True iff the rows share a set bit; words past the shorter row count as zero. */
export function rowsOverlap(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if ((a[i]! & b[i]!) !== 0) return true;
  }
  return false;
}
