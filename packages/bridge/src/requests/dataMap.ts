// The worker's side of a data map (U4): the numbers one overlay is painted and read from, copied out of the world for
// the map on screen. Only reads: a data map is a way of colouring the frame, never a change to the city. The colours,
// legends and readings are `packages/render/src/dataMap.ts`, which takes this reply under the same field names.
import {
  CIVIC_KINDS,
  MAX_ZONE_DEPTH,
  blockHas,
  utilityMask,
  type CityField,
  type MapGrid,
  type TilePos,
  type UtilityKind,
  type UtilityNetwork,
  type World,
} from '@simcity/sim';

/** Every map a player reads: `OverlayMode` less the plain map and the developer path view. */
export const DATA_MAP_OVERLAYS = [
  'Water',
  'Height',
  'Zones',
  'Roads',
  'Traffic',
  'ServiceCoverage',
  'LandValue',
  'Pollution',
  'Power',
  'WaterSupply',
  'Garbage',
  'Crime',
  'FireHazard',
  'Health',
  'Education',
  'Attractiveness',
] as const;
export type DataMapOverlay = (typeof DATA_MAP_OVERLAYS)[number];

export interface DataMapRequest {
  readonly t: 'dataMap';
  readonly overlay: DataMapOverlay;
}

/**
 * One overlay's numbers per tile, row-major over the map. Water, roads and zones are painted from the map layers the
 * renderer already holds and carry nothing here. An index not computed for this map yet is left out, so it reads as
 * "not computed" rather than as a measurement of zero.
 */
export interface DataMapReply {
  readonly overlay: DataMapOverlay;
  readonly width: number;
  readonly height: number;
  /** Moves whenever what the layer was read from did: the same version paints the same picture. */
  readonly version: string;
  /** Terrain elevation, `u8`. */
  readonly heights?: Uint8Array;
  readonly landValue?: Float32Array;
  readonly pollution?: Float32Array;
  /** Road heat as a share of the busiest road's, 0..1; 0 off the roads. */
  readonly traffic?: Float32Array;
  /** `MASK_FIRE | MASK_POLICE | MASK_MEDICAL` per tile. */
  readonly coverage?: Uint8Array;
  /** `utilityMask(kind)` where the map's utility reaches, 0 elsewhere. */
  readonly utilities?: Uint8Array;
  /** The one field on screen. */
  readonly fields?: Readonly<Partial<Record<CityField, Float32Array>>>;
  /** Civic strength per tile, in `CIVIC_KINDS` order. */
  readonly civic?: readonly Float32Array[];
}

const UTILITY_OF: Partial<Record<DataMapOverlay, UtilityKind>> = { Power: 'Power', WaterSupply: 'Water', Garbage: 'Garbage' };
const CITY_FIELD_OF: Partial<Record<DataMapOverlay, CityField>> = {
  Crime: 'Crime',
  FireHazard: 'FireHazard',
  Health: 'Health',
  Education: 'Education',
  Attractiveness: 'Attractiveness',
};

/**
 * Whether `kind` reaches `tile` as a player reads the map: a tile the network touches, or a dry zoned tile within zone
 * depth of a supplied road — the reach growth and the diagnosis use (`blockHas`).
 */
export function utilityReaches(grid: MapGrid, network: UtilityNetwork, tile: TilePos, kind: UtilityKind): boolean {
  const idx = grid.idx(tile);
  if (idx === undefined) return false;
  if (network.tileHas(idx, kind)) return true;
  return grid.zone[idx] !== 0 && grid.water[idx] === 0 && blockHas(grid, network, tile, kind);
}

/** `utilityReaches` over the whole map, tile for tile (the handler's test checks every tile of a map against it). */
function utilityReach(grid: MapGrid, network: UtilityNetwork, kind: UtilityKind): Uint8Array {
  const { width, height } = grid;
  const len = width * height;
  const mask = utilityMask(kind);
  // `blockHas` looks for a supplied road within a diamond of zone depth: the supplied roads grown by one tile in the
  // four directions, zone-depth times, are exactly the tiles that diamond reaches. Three passes instead of a diamond
  // search per zoned tile (a second on the metropolis).
  let near = new Uint8Array(len);
  for (let i = 0; i < len; i++) if (grid.roadKind[i] !== 0 && (network.served[i]! & mask) !== 0) near[i] = 1;
  let next = new Uint8Array(len);
  for (let step = 0; step < MAX_ZONE_DEPTH; step++) {
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        next[i] = near[i]! | (x > 0 ? near[i - 1]! : 0) | (x < width - 1 ? near[i + 1]! : 0) | (y > 0 ? near[i - width]! : 0) | (y < height - 1 ? near[i + width]! : 0);
      }
    }
    [near, next] = [next, near];
  }
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    if ((network.served[i]! & mask) !== 0 || (near[i] === 1 && grid.zone[i] !== 0 && grid.water[i] === 0)) out[i] = mask;
  }
  return out;
}

/** The numbers `overlay` shows, copied out of `w`; nothing in `w` changes. */
export function dataMapLayer(w: World, overlay: DataMapOverlay): DataMapReply {
  const grid = w.grid;
  const len = grid.len();
  const base = { overlay, width: grid.width, height: grid.height };
  const version = (...parts: number[]) => [overlay, w.mapEditVersion, ...parts].join(':');
  const measured = <T extends Float32Array | Uint8Array>(values: T): T | undefined => (len > 0 && values.length === len ? (values.slice() as T) : undefined);

  const field = CITY_FIELD_OF[overlay];
  if (field !== undefined) {
    const fields = w.cityFields;
    return { ...base, version: version(fields.version), ...(fields.covers(len) ? { fields: { [field]: fields.values(field).slice() } } : {}) };
  }
  const utility = UTILITY_OF[overlay];
  if (utility !== undefined) {
    const network = w.utilityNetwork;
    const computed = len > 0 && network.served.length === len;
    return { ...base, version: version(network.version), ...(computed ? { utilities: utilityReach(grid, network, utility) } : {}) };
  }
  switch (overlay) {
    case 'LandValue':
      return withArray({ ...base, version: version(w.landValue.version) }, 'landValue', measured(w.landValue.values));
    case 'Pollution':
      return withArray({ ...base, version: version(w.pollution.version) }, 'pollution', measured(w.pollution.values));
    case 'Height':
      return withArray({ ...base, version: version() }, 'heights', measured(grid.elevation));
    case 'Traffic': {
      const occ = w.trafficOccupancy;
      if (len === 0 || occ.emaScaled.length !== len) return { ...base, version: version(w.tick) };
      const heat = new Float32Array(len);
      const busiest = Math.max(occ.maxHeat(), 0.001);
      for (let i = 0; i < len; i++) if (grid.roadKind[i] !== 0) heat[i] = Math.min(occ.heatIdx(i) / busiest, 1);
      return { ...base, version: version(w.tick), traffic: heat };
    }
    case 'ServiceCoverage': {
      const civic = w.civicCoverage;
      const layer = withArray({ ...base, version: version(w.serviceCoverage.version, civic.version) }, 'coverage', measured(w.serviceCoverage.coverageMap));
      return civic.covers(len) && civic.strength.length === CIVIC_KINDS.length ? { ...layer, civic: civic.strength.map((s) => s.slice()) } : layer;
    }
    default:
      // Water, roads and zones: the renderer's own map layers.
      return { ...base, version: version() };
  }
}

function withArray<K extends 'landValue' | 'pollution' | 'heights' | 'coverage'>(reply: DataMapReply, key: K, values: DataMapReply[K] | undefined): DataMapReply {
  return values === undefined ? reply : { ...reply, [key]: values };
}
