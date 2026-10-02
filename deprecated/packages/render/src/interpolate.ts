// The display draws between two sim frames: positions move linearly and headings turn the short way
// round. Packed indices differ between frames, so every vehicle is first found in the older one.

const TAU = Math.PI * 2;
const HASH = 0x9e37_79b1;

/** What pairing needs of a sim frame. */
export interface VehicleIdentities {
  readonly count: number;
  readonly slot: Uint32Array;
  readonly generation: Uint32Array;
}

/**
 * For every vehicle of `to`, its index in `from`, or -1 when `from` does not have it (spawned since, or its slot was
 * reused). Returns how many are unpaired. `table` is scratch, a power of two longer than `from` holds: an open-addressing
 * hash of the render ids, so ids can run into the millions without an array that long.
 */
export function pairVehicles(from: VehicleIdentities, to: VehicleIdentities, table: Int32Array, out: Int32Array): number {
  const size = table.length;
  if (size < 2 || (size & (size - 1)) !== 0 || size <= from.count) throw new RangeError(`pairing table of ${size} for ${from.count} vehicles`);
  const shift = Math.clz32(size) + 1;
  const mask = size - 1;
  table.fill(-1);
  for (let j = 0; j < from.count; j++) {
    let h = Math.imul(from.slot[j]!, HASH) >>> shift;
    while (table[h] !== -1) h = (h + 1) & mask;
    table[h] = j;
  }
  let unpaired = 0;
  for (let i = 0; i < to.count; i++) {
    const slot = to.slot[i]!;
    let found = -1;
    for (let h = Math.imul(slot, HASH) >>> shift; table[h] !== -1; h = (h + 1) & mask) {
      const j = table[h]!;
      if (from.slot[j] !== slot) continue;
      if (from.generation[j] === to.generation[i]) found = j;
      break;
    }
    out[i] = found;
    if (found < 0) unpaired += 1;
  }
  return unpaired;
}

/** `pairs[i]` indexes `prev`; an unpaired vehicle (-1) stands where `next` has it. */
export function interpolatePositions(
  prev: Float32Array,
  next: Float32Array,
  pairs: Int32Array,
  alpha: number,
  count: number,
  out: Float32Array,
): void {
  for (let i = 0; i < count; i++) {
    const j = pairs[i]!;
    const b = next[i]!;
    if (j < 0) {
      out[i] = b;
      continue;
    }
    const a = prev[j]!;
    out[i] = a + (b - a) * alpha;
  }
}

/** Into [-π, π). */
export function wrapAngle(angle: number): number {
  return angle - TAU * Math.floor((angle + Math.PI) / TAU);
}

export function interpolateHeading(from: number, to: number, alpha: number): number {
  return wrapAngle(from + wrapAngle(to - from) * alpha);
}
