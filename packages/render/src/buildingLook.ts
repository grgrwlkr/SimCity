// How a building shows by kind, level and profile: port of building_height, profile_height and
// profile_color (crates/simcity_sim/src/game/buildings/visual.rs) and `BuildingKind::color`.
import { densityHeightFactor, type BuildingKind, type BuildingProfile } from '@simcity/sim';

/** sRGB, each channel 0..1. */
export type Rgb = readonly [number, number, number];

/** Body height of a building of this kind and level, world units. */
export function buildingHeight(kind: BuildingKind, level: number): number {
  switch (kind) {
    case 'Residential':
    case 'Commercial':
      return level <= 1 ? 10 : level === 2 ? 22 : 36;
    case 'Industrial':
      return 10 + 3 * level;
    case 'FireStation':
    case 'PoliceStation':
    case 'Hospital':
    case 'School':
      return 14;
    case 'PowerPlant':
      return 18;
    case 'WaterPump':
      return 10;
    case 'Landfill':
      return 6;
    case 'University':
      return 20;
    case 'Park':
      return 2;
  }
}

/** Its density stretches or squats the level's height. */
export function profileHeight(kind: BuildingKind, level: number, profile: BuildingProfile): number {
  return buildingHeight(kind, level) * densityHeightFactor(profile.density);
}

const KIND_COLORS: Readonly<Record<BuildingKind, Rgb>> = {
  Residential: [0.1, 0.55, 0.18],
  Commercial: [0.1, 0.22, 0.55],
  Industrial: [0.65, 0.45, 0.08],
  FireStation: [0.75, 0.15, 0.12],
  PoliceStation: [0.12, 0.22, 0.75],
  Hospital: [0.12, 0.75, 0.22],
  PowerPlant: [0.85, 0.72, 0.15],
  WaterPump: [0.15, 0.55, 0.85],
  Landfill: [0.45, 0.36, 0.26],
  School: [0.8, 0.58, 0.3],
  University: [0.55, 0.36, 0.62],
  Park: [0.3, 0.62, 0.28],
};

export function buildingColor(kind: BuildingKind): Rgb {
  return KIND_COLORS[kind];
}

/** Its wealth class shades the kind's colour: the poor block reads darker, the rich one lighter. */
export function profileColor(kind: BuildingKind, profile: BuildingProfile): Rgb {
  const base = buildingColor(kind);
  if (profile.class === 'Low') return [base[0] * 0.88, base[1] * 0.88, base[2] * 0.88];
  if (profile.class === 'High') return [base[0] + (1 - base[0]) * 0.18, base[1] + (1 - base[1]) * 0.18, base[2] + (1 - base[2]) * 0.18];
  return base;
}
