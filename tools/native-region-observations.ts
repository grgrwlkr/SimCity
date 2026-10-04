export interface ObservedVehicle {
  id: number;
  x: number;
  z: number;
  dx: number;
  dz: number;
  length: number;
  width: number;
}

/** Exact oriented body footprints, using the real native vehicle dimensions. */
export function trafficCollisions(
  vehicles: readonly ObservedVehicle[],
): Array<[number, number]> {
  const collisions: Array<[number, number]> = [];

  for (let i = 0; i < vehicles.length; i++) {
    const a = vehicles[i]!;

    for (let j = i + 1; j < vehicles.length; j++) {
      const b = vehicles[j]!;
      const x = b.x - a.x;
      const z = b.z - a.z;
      const al = a.length / 2;
      const aw = a.width / 2;
      const bl = b.length / 2;
      const bw = b.width / 2;
      const reach = al + aw + bl + bw;

      if (Math.abs(x) > reach || Math.abs(z) > reach) {
        continue;
      }

      const c = Math.abs(a.dx * b.dx + a.dz * b.dz);
      const s = Math.abs(a.dx * b.dz - a.dz * b.dx);

      if (
        Math.abs(x * a.dx + z * a.dz) < al + bl * c + bw * s - 0.0001 &&
        Math.abs(-x * a.dz + z * a.dx) < aw + bl * s + bw * c - 0.0001 &&
        Math.abs(x * b.dx + z * b.dz) < bl + al * c + aw * s - 0.0001 &&
        Math.abs(-x * b.dz + z * b.dx) < bw + al * s + aw * c - 0.0001
      ) {
        collisions.push([a.id, b.id]);
      }
    }
  }

  return collisions;
}
