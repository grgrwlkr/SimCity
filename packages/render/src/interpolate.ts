// The display draws between two sim frames: positions move linearly and headings turn the short way
// round. Packed indices differ between frames, so every vehicle is first found in the older one.

const TAU = Math.PI * 2;

/** What pairing needs of a sim frame. */
export interface VehicleIdentities {
  readonly count: number;
  readonly slot: Uint32Array;
  readonly generation: Uint32Array;
}

/**
 * For every vehicle of `to`, its index in `from`, or -1 when `from` does not have it (spawned since,
 * or its slot was reused). Returns how many are unpaired. `bySlot` is scratch longer than the largest
 * slot; what an earlier call left in it is checked, never trusted, so it needs no clearing.
 */
export function pairVehicles(from: VehicleIdentities, to: VehicleIdentities, bySlot: Int32Array, out: Int32Array): number {
  for (let j = 0; j < from.count; j++) bySlot[from.slot[j]!] = j;
  let unpaired = 0;
  for (let i = 0; i < to.count; i++) {
    const slot = to.slot[i]!;
    const j = bySlot[slot]!;
    const same = j >= 0 && j < from.count && from.slot[j] === slot && from.generation[j] === to.generation[i];
    out[i] = same ? j : -1;
    if (!same) unpaired += 1;
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
