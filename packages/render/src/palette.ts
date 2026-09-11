// Debug colours of a tile. Flat and far apart on purpose: the layout gate reads the class of each
// tile back from a compressed screenshot.
import type { MapLayersReply } from '@simcity/bridge';

export type TileClass = 'grass' | 'water' | 'road' | 'box' | 'residential' | 'commercial' | 'industrial' | 'building';
/** What the layout comparison with the Rust frame can tell apart. */
export type LayoutClass = 'road' | 'water' | 'other';

export const CLASS_COLORS: Readonly<Record<TileClass, readonly [number, number, number]>> = {
  grass: [116, 160, 84],
  water: [64, 128, 208],
  road: [52, 54, 62],
  box: [156, 158, 168],
  residential: [200, 210, 120],
  commercial: [220, 140, 200],
  industrial: [200, 150, 90],
  building: [240, 240, 240],
};

/** Vehicle cube colour by `kind`, sRGB. */
export const VEHICLE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 122, 26],
  [34, 211, 238],
  [224, 64, 251],
  [255, 225, 77],
];

/** `ZONE_KINDS` index -> class. */
const ZONE_CLASSES: readonly TileClass[] = ['grass', 'residential', 'commercial', 'industrial'];

/** Road over building over water over zone; a road tile without a direction is an intersection box. */
export function tileClass(map: MapLayersReply, i: number): TileClass {
  const l = map.layers;
  if (l.roadKind[i] !== 0) return l.roadDir[i] === 0 ? 'box' : 'road';
  if (l.building[i] !== 0) return 'building';
  if (l.water[i] !== 0) return 'water';
  return ZONE_CLASSES[l.zone[i] ?? 0] ?? 'grass';
}

export function layoutClass(c: TileClass): LayoutClass {
  if (c === 'road' || c === 'box') return 'road';
  return c === 'water' ? 'water' : 'other';
}

/** The class whose colour is nearest to an sRGB pixel. */
export function classifyColor(r: number, g: number, b: number): TileClass {
  let best: TileClass = 'grass';
  let bestDistance = Infinity;
  for (const [name, [cr, cg, cb]] of Object.entries(CLASS_COLORS) as Array<[TileClass, readonly [number, number, number]]>) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  return best;
}
