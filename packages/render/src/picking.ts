// Port of `ray_ground_t` (simcity_core/src/game/map/coords.rs): picking intersects the view ray
// with the ground plane z = 0, which stays valid for any camera the later stages bring.

export type Vec3 = readonly [number, number, number];

/** Ray parameter `t` where `origin + t * dir` crosses z = 0; `undefined` when parallel or pointing away. */
export function rayGroundT(origin: Vec3, dir: Vec3): number | undefined {
  if (Math.abs(dir[2]) < 1e-6) return undefined;
  const t = -origin[2] / dir[2];
  return t >= 0 ? t : undefined;
}
