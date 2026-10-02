// The tile map: port of simcity_core `MapGrid` / `MapCell` as one typed array per cell field.
// An enum field stores the index of its value in the exported tuple; `building` and `roadFlow`
// reserve 0 for "no building" and `TwoWay`.
import {
  BUILDING_KINDS,
  LANE_TYPES,
  ROAD_DIRS,
  ROAD_KINDS,
  ZONE_DENSITIES,
  ZONE_KINDS,
  type BuildingKind,
  type RoadCell,
  type RoadFlow,
  type TilePos,
  type ZoneDensity,
  type ZoneKind,
} from '../commands';

export const TILE_KINDS = ['Water', 'Grass', 'Road', 'Residential', 'Commercial', 'Industrial'] as const;
export type TileKind = (typeof TILE_KINDS)[number];

export interface MapCell {
  readonly height: number;
  readonly water: boolean;
  /** Base terrain; roads and zones are separate layers. */
  readonly terrain: TileKind;
  readonly road: RoadCell;
  readonly zone: ZoneKind;
  /** How densely the zone on this tile builds. */
  readonly density: ZoneDensity;
  readonly building: BuildingKind | null;
}

/** A number key for a tile position (Rust hashes `TilePos`); covers i32 coordinates within ±32767, off the map too. */
export function tileKey(pos: TilePos): number {
  return (pos.y + 32768) * 65536 + (pos.x + 32768);
}

export const GRASS_CODE = TILE_KINDS.indexOf('Grass');
const MEDIUM_CODE = ZONE_DENSITIES.indexOf('Medium');

function encodeFlow(flow: RoadFlow): number {
  return flow.kind === 'TwoWay' ? 0 : 1 + ROAD_DIRS.indexOf(flow.dir);
}

function decodeFlow(code: number): RoadFlow {
  return code === 0 ? { kind: 'TwoWay' } : { kind: 'OneWay', dir: ROAD_DIRS[code - 1]! };
}

export class MapGrid {
  readonly width: number;
  readonly height: number;
  /** `MapCell::height` (terrain elevation, `u8`). */
  readonly elevation: Uint8Array;
  readonly water: Uint8Array;
  readonly terrain: Uint8Array;
  readonly roadKind: Uint8Array;
  readonly roadDir: Uint8Array;
  readonly roadLane: Uint8Array;
  readonly roadFlow: Uint8Array;
  readonly laneType: Uint8Array;
  readonly zone: Uint8Array;
  readonly density: Uint8Array;
  readonly building: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const len = Math.max(width, 0) * Math.max(height, 0);
    this.elevation = new Uint8Array(len);
    this.water = new Uint8Array(len);
    this.terrain = new Uint8Array(len).fill(GRASS_CODE);
    this.roadKind = new Uint8Array(len);
    this.roadDir = new Uint8Array(len);
    this.roadLane = new Uint8Array(len);
    this.roadFlow = new Uint8Array(len);
    this.laneType = new Uint8Array(len);
    this.zone = new Uint8Array(len);
    this.density = new Uint8Array(len).fill(MEDIUM_CODE);
    this.building = new Uint8Array(len);
  }

  len(): number {
    return this.elevation.length;
  }

  idx(pos: TilePos): number | undefined {
    if (pos.x < 0 || pos.y < 0 || pos.x >= this.width || pos.y >= this.height) return undefined;
    return pos.y * this.width + pos.x;
  }

  get(pos: TilePos): MapCell | undefined {
    const i = this.idx(pos);
    return i === undefined ? undefined : this.cellAt(i);
  }

  set(pos: TilePos, cell: MapCell): boolean {
    const i = this.idx(pos);
    if (i === undefined) return false;
    this.setAt(i, cell);
    return true;
  }

  cellAt(i: number): MapCell {
    const building = this.building[i]!;
    return {
      height: this.elevation[i]!,
      water: this.water[i] !== 0,
      terrain: TILE_KINDS[this.terrain[i]!]!,
      road: {
        kind: ROAD_KINDS[this.roadKind[i]!]!,
        dir: ROAD_DIRS[this.roadDir[i]!]!,
        lane: this.roadLane[i]!,
        flow: decodeFlow(this.roadFlow[i]!),
        laneType: LANE_TYPES[this.laneType[i]!]!,
      },
      zone: ZONE_KINDS[this.zone[i]!]!,
      density: ZONE_DENSITIES[this.density[i]!]!,
      building: building === 0 ? null : BUILDING_KINDS[building - 1]!,
    };
  }

  setAt(i: number, cell: MapCell): void {
    this.elevation[i] = cell.height;
    this.water[i] = cell.water ? 1 : 0;
    this.terrain[i] = TILE_KINDS.indexOf(cell.terrain);
    this.roadKind[i] = ROAD_KINDS.indexOf(cell.road.kind);
    this.roadDir[i] = ROAD_DIRS.indexOf(cell.road.dir);
    this.roadLane[i] = cell.road.lane;
    this.roadFlow[i] = encodeFlow(cell.road.flow);
    this.laneType[i] = LANE_TYPES.indexOf(cell.road.laneType);
    this.zone[i] = ZONE_KINDS.indexOf(cell.zone);
    this.density[i] = ZONE_DENSITIES.indexOf(cell.density);
    this.building[i] = cell.building === null ? 0 : 1 + BUILDING_KINDS.indexOf(cell.building);
  }

  /** Every cell layer in a fixed order (fingerprint). */
  layers(): readonly Uint8Array[] {
    return [
      this.elevation,
      this.water,
      this.terrain,
      this.roadKind,
      this.roadDir,
      this.roadLane,
      this.roadFlow,
      this.laneType,
      this.zone,
      this.density,
      this.building,
    ];
  }
}
