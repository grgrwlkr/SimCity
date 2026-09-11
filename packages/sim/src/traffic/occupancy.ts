// Port of crates/simcity_sim/src/game/traffic/occupancy.rs: vehicles per road tile at the end of the
// last tick (routing and capacity gates read it), a heat EMA for the overlay, and `TrafficIndex`.
import type { World } from '../world';
import { capacityPerLaneTile } from '../map/roads';
import { ROAD_KINDS } from '../commands';

const f32 = Math.fround;
const U16_MAX = 0xffff;

export class TrafficOccupancy {
  perTickVehicles = new Uint16Array(0);
  /** Tiles counted in the latest build, cleared next tick without a full fill. */
  touched: number[] = [];
  /** Heat is `emaScaled[i] * emaGlobal`, so decay is O(1) a tick. */
  emaScaled = new Float32Array(0);
  emaGlobal = 1;
  maxScaled = 0;

  ensureLen(len: number): void {
    if (this.perTickVehicles.length !== len) {
      this.perTickVehicles = new Uint16Array(len);
      this.touched = [];
    }
    if (this.emaScaled.length !== len) {
      this.emaScaled = new Float32Array(len);
      this.emaGlobal = 1;
      this.maxScaled = 0;
    }
    if (!(this.emaGlobal > 0) || !Number.isFinite(this.emaGlobal)) this.emaGlobal = 1;
    if (!Number.isFinite(this.maxScaled)) this.maxScaled = 0;
  }

  heatIdx(idx: number): number {
    return f32((this.emaScaled[idx] ?? 0) * this.emaGlobal);
  }

  maxHeat(): number {
    return f32(this.maxScaled * this.emaGlobal);
  }
}

export interface TrafficIndex {
  roadTiles: number;
  vehiclesOnRoads: number;
  /** Mean congestion over road tiles, [0..1]. */
  avgCongestion: number;
  maxCongestion: number;
  maxCongestionTile: { x: number; y: number } | null;
  maxCongestionTileVehicles: number;
  maxCongestionTileCapacity: number;
}

export function emptyTrafficIndex(): TrafficIndex {
  return {
    roadTiles: 0,
    vehiclesOnRoads: 0,
    avgCongestion: 0,
    maxCongestion: 0,
    maxCongestionTile: null,
    maxCongestionTileVehicles: 0,
    maxCongestionTileCapacity: 0,
  };
}

/** Per-tile road capacity and the road tile count, rebuilt when the map edit version moves. */
export class TrafficRoadCache {
  gridLen = 0;
  mapEditVersion = 0;
  capacityPerTile = new Uint16Array(0);
  roadTiles = 0;

  ensureBuilt(w: World): void {
    const grid = w.grid;
    const len = grid.len();
    if (this.gridLen === len && this.capacityPerTile.length === len && w.mapEditVersion === this.mapEditVersion) return;
    this.gridLen = len;
    this.mapEditVersion = w.mapEditVersion;
    this.capacityPerTile = new Uint16Array(len);
    this.roadTiles = 0;
    for (let i = 0; i < len; i++) {
      if (grid.water[i] !== 0 || grid.roadKind[i] === 0) continue;
      this.roadTiles += 1;
      this.capacityPerTile[i] = capacityPerLaneTile(ROAD_KINDS[grid.roadKind[i]!]!);
    }
  }
}

function writeIndex(w: World, tiles: Iterable<number>): void {
  const occ = w.trafficOccupancy;
  const roads = w.trafficRoadCache;
  const idx = w.trafficIndex;
  let vehiclesOnRoads = 0;
  let sum = 0;
  let max = 0;
  let maxTile: number | null = null;
  let maxVehicles = 0;
  let maxCap = 0;
  for (const ti of tiles) {
    const cap = roads.capacityPerTile[ti] ?? 0;
    if (cap <= 0) continue;
    const c = occ.perTickVehicles[ti]!;
    vehiclesOnRoads += c;
    const cong = Math.min(Math.max(f32(c / cap), 0), 1);
    sum = f32(sum + cong);
    if (cong > max) {
      max = cong;
      maxTile = ti;
      maxVehicles = c;
      maxCap = cap;
    }
  }
  idx.roadTiles = roads.roadTiles;
  idx.vehiclesOnRoads = vehiclesOnRoads;
  idx.avgCongestion = roads.roadTiles > 0 ? f32(sum / roads.roadTiles) : 0;
  idx.maxCongestion = roads.roadTiles > 0 ? max : 0;
  idx.maxCongestionTile = maxTile === null ? null : { x: maxTile % w.grid.width, y: Math.floor(maxTile / w.grid.width) };
  idx.maxCongestionTileVehicles = maxVehicles;
  idx.maxCongestionTileCapacity = maxCap;
}

/** `update_traffic_occupancy` (TrafficStep::Flow, first): counts non-parked vehicles with an active route. */
export function updateTrafficOccupancy(w: World): void {
  const occ = w.trafficOccupancy;
  const grid = w.grid;
  occ.ensureLen(grid.len());
  w.trafficRoadCache.ensureBuilt(w);

  const touched = occ.touched;
  for (const i of touched) occ.perTickVehicles[i] = 0;
  touched.length = 0;

  const v = w.vehicles;
  for (const slot of v.order) {
    if (v.parked[slot] === 1) continue;
    const handle = v.pathHandle[slot]!;
    if (w.pathPool.len(handle) <= 1) continue;
    const pos = w.pathPool.getTile(handle, v.pathCursor[slot]!);
    const i = pos === undefined ? undefined : grid.idx(pos);
    if (i === undefined) continue;
    occ.perTickVehicles[i] = Math.min(occ.perTickVehicles[i]! + 1, U16_MAX);
    if (occ.perTickVehicles[i] === 1) touched.push(i);
  }

  writeIndex(w, touched);

  const decay = Math.min(Math.max(w.trafficConfig.heatEmaDecay, 0), f32(0.999));
  if (decay <= 0) {
    occ.emaScaled.fill(0);
    occ.maxScaled = 0;
    for (const ti of touched) {
      const c = occ.perTickVehicles[ti]!;
      occ.emaScaled[ti] = c;
      if (c > occ.maxScaled) occ.maxScaled = c;
    }
    occ.emaGlobal = 1;
    return;
  }
  occ.emaGlobal = f32(occ.emaGlobal * decay);
  if (occ.emaGlobal < f32(1e-20)) {
    const g = occ.emaGlobal;
    for (let i = 0; i < occ.emaScaled.length; i++) occ.emaScaled[i] = f32(occ.emaScaled[i]! * g);
    occ.maxScaled = f32(occ.maxScaled * g);
    occ.emaGlobal = 1;
  }
  const invG = f32(1 / Math.max(occ.emaGlobal, f32(1e-30)));
  const k = f32(f32(1 - decay) * invG);
  for (const ti of touched) {
    const next = f32(occ.emaScaled[ti]! + f32(occ.perTickVehicles[ti]! * k));
    occ.emaScaled[ti] = next;
    if (next > occ.maxScaled) occ.maxScaled = next;
  }
}

/** `update_traffic_index` (PostSimStep::TrafficIndex): the same metrics over every tile at the end of the tick. */
export function updateTrafficIndex(w: World): void {
  w.trafficOccupancy.ensureLen(w.grid.len());
  w.trafficRoadCache.ensureBuilt(w);
  writeIndex(w, { [Symbol.iterator]: function* () { for (let i = 0; i < w.grid.len(); i++) yield i; } });
}
