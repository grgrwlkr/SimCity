// Port of crates/simcity_sim/src/game/utilities.rs: power, water and garbage collection carried along roads.
// A station feeds the road tiles beside its footprint; supply spreads through every road tile 4-connected to
// those, nearest first, until the stations' capacity is used up, and a tile is served when it fronts a
// supplied road. Every building consumes its residents plus its jobs in units of each utility.
import { BUILDING_KINDS, type BuildingKind, type TilePos } from './commands';
import { anyFootprintTile, isOperational, isZonedKind, utilityCapacity } from './buildings/building';
import type { MapGrid } from './map/grid';
import type { World } from './world';

const U32_MAX = 0xffff_ffff;

export const UTILITY_KINDS = ['Power', 'Water', 'Garbage'] as const;
export type UtilityKind = (typeof UTILITY_KINDS)[number];

const STATIONS: Readonly<Record<UtilityKind, BuildingKind>> = { Power: 'PowerPlant', Water: 'WaterPump', Garbage: 'Landfill' };

/** This utility's bit in `UtilityNetwork.served`. */
export function utilityMask(kind: UtilityKind): number {
  return 1 << UTILITY_KINDS.indexOf(kind);
}

export function utilityStation(kind: UtilityKind): BuildingKind {
  return STATIONS[kind];
}

/** The utility a building supplies, if it is a station. */
export function utilityFromStation(kind: BuildingKind): UtilityKind | undefined {
  return UTILITY_KINDS.find((utility) => STATIONS[utility] === kind);
}

/** Which utilities reach each tile of the map. */
export class UtilityNetwork {
  /** Bumps on every recompute. */
  version = 0;
  /** The map edit the network was last computed for. */
  mapVersion = 0;
  /** What its consumers drew when it was last computed: footprints and units, folded into a number. */
  consumersSignature = 0;
  /** Bitmask per tile, one bit per utility. */
  served: Uint8Array = new Uint8Array(0);

  /** A network of these masks, as a first recompute would leave it. */
  static fromServed(served: Uint8Array): UtilityNetwork {
    const network = new UtilityNetwork();
    network.version = 1;
    network.served = served;
    return network;
  }

  tileHas(idx: number, kind: UtilityKind): boolean {
    return idx < this.served.length && (this.served[idx]! & utilityMask(kind)) !== 0;
  }

  /** Whether `kind` reaches a building: any tile of its footprint is enough. */
  footprintHas(grid: MapGrid, anchor: TilePos, width: number, length: number, kind: UtilityKind): boolean {
    return anyFootprintTile(anchor, width, length, (tile) => {
      const idx = grid.idx(tile);
      return idx !== undefined && this.tileHas(idx, kind);
    });
  }
}

/** A building drawing on the networks: its footprint and the units it consumes of every utility. */
export interface Consumer {
  readonly anchor: TilePos;
  readonly width: number;
  readonly length: number;
  readonly units: number;
}

/** Supply against demand in one road component of one utility, in units. */
export interface SupplyBalance {
  readonly kind: UtilityKind;
  readonly supply: number;
  readonly demand: number;
  /** The part of the demand that is met, nearest buildings first. */
  readonly supplied: number;
}

const satAdd = (a: number, b: number) => Math.min(a + b, U32_MAX);

/** Supply and demand of every road component the stations feed. */
export class UtilitySupply {
  version = 0;
  components: SupplyBalance[] = [];

  static of(components: SupplyBalance[]): UtilitySupply {
    const supply = new UtilitySupply();
    supply.version = 1;
    supply.components = components;
    return supply;
  }

  /** The whole city's supply, demand and met demand of `kind`. */
  totals(kind: UtilityKind): SupplyBalance {
    let supply = 0;
    let demand = 0;
    let supplied = 0;
    for (const balance of this.components) {
      if (balance.kind !== kind) continue;
      supply = satAdd(supply, balance.supply);
      demand = satAdd(demand, balance.demand);
      supplied = satAdd(supplied, balance.supplied);
    }
    return { kind, supply, demand, supplied };
  }

  /** Whether some component of `kind` leaves buildings without supply. */
  isShort(kind: UtilityKind): boolean {
    return this.components.some((balance) => balance.kind === kind && balance.supplied < balance.demand);
  }
}

/** Tiles of one station footprint: stations side by side merge into one block, each full footprint in it counting. */
const STATION_TILES = 9;

/** Supply masks for every tile of `grid` with nothing drawing on the stations. */
export function computeServed(grid: MapGrid): Uint8Array {
  return computeSupply(grid, []).served;
}

/** Supply masks and balances for `grid` with `consumers` drawing on it. Every walk is over typed arrays by tile index. */
export function computeSupply(grid: MapGrid, consumers: readonly Consumer[]): { served: Uint8Array; components: SupplyBalance[] } {
  const len = grid.len();
  const width = grid.width;
  const height = grid.height;
  const served = new Uint8Array(len);
  const components: SupplyBalance[] = [];
  const roadKind = grid.roadKind;
  const building = grid.building;
  // Neighbours in the order of the Rust port: west, east, south (y − 1), north (y + 1); -1 off the map.
  const neighbour = (idx: number, n: number): number => {
    const x = idx % width;
    if (n === 0) return x > 0 ? idx - 1 : -1;
    if (n === 1) return x + 1 < width ? idx + 1 : -1;
    if (n === 2) return idx >= width ? idx - width : -1;
    return idx + width < width * height ? idx + width : -1;
  };
  const distance = new Uint32Array(len);
  const component = new Int32Array(len);
  const queue = new Int32Array(len);
  const load = new Float64Array(len);
  const seen = new Uint8Array(len);

  for (const utility of UTILITY_KINDS) {
    const stationCode = 1 + BUILDING_KINDS.indexOf(STATIONS[utility]);
    const bit = utilityMask(utility);
    const capacity = utilityCapacity(STATIONS[utility]) ?? 0;

    // Distance along the road from the nearest station for every road tile a station feeds; a station tile is served itself.
    distance.fill(U32_MAX);
    let tail = 0;
    for (let idx = 0; idx < len; idx++) {
      if (building[idx] !== stationCode) continue;
      served[idx] = served[idx]! | bit;
      for (let n = 0; n < 4; n++) {
        const next = neighbour(idx, n);
        if (next >= 0 && roadKind[next] !== 0 && distance[next] === U32_MAX) {
          distance[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    for (let head = 0; head < tail; head++) {
      const idx = queue[head]!;
      for (let n = 0; n < 4; n++) {
        const next = neighbour(idx, n);
        if (next >= 0 && roadKind[next] !== 0 && distance[next] === U32_MAX) {
          distance[next] = distance[idx]! + 1;
          queue[tail++] = next;
        }
      }
    }

    // The road components the stations feed, and their tiles.
    component.fill(-1);
    const tilesOf: Int32Array[] = [];
    for (let start = 0; start < len; start++) {
      if (distance[start] === U32_MAX || component[start] !== -1) continue;
      const id = tilesOf.length;
      component[start] = id;
      let size = 0;
      queue[size++] = start;
      for (let cursor = 0; cursor < size; cursor++) {
        const idx = queue[cursor]!;
        for (let n = 0; n < 4; n++) {
          const next = neighbour(idx, n);
          if (next >= 0 && distance[next] !== U32_MAX && component[next] === -1) {
            component[next] = id;
            queue[size++] = next;
          }
        }
      }
      tilesOf.push(queue.slice(0, size));
    }

    // Each component's supply: every station block beside it.
    const supply = new Float64Array(tilesOf.length);
    seen.fill(0);
    for (let start = 0; start < len; start++) {
      if (building[start] !== stationCode || seen[start] === 1) continue;
      seen[start] = 1;
      let size = 0;
      queue[size++] = start;
      const fed: number[] = [];
      for (let cursor = 0; cursor < size; cursor++) {
        const idx = queue[cursor]!;
        for (let n = 0; n < 4; n++) {
          const next = neighbour(idx, n);
          if (next < 0) continue;
          if (building[next] === stationCode) {
            if (seen[next] === 0) {
              seen[next] = 1;
              queue[size++] = next;
            }
          } else if (component[next] !== -1 && !fed.includes(component[next]!)) {
            fed.push(component[next]!);
          }
        }
      }
      const stations = Math.ceil(size / STATION_TILES);
      for (const id of fed) supply[id] = satAdd(supply[id]!, Math.min(stations * capacity, U32_MAX));
    }

    // Every building draws on the road tile it fronts nearest to a station.
    load.fill(0);
    for (const c of consumers) {
      let nearest = -1;
      for (let dy = 0; dy < c.length; dy++) {
        for (let dx = 0; dx < c.width; dx++) {
          const idx = grid.idx({ x: c.anchor.x + dx, y: c.anchor.y + dy });
          if (idx === undefined) continue;
          for (let n = 0; n < 4; n++) {
            const next = neighbour(idx, n);
            if (next < 0 || distance[next] === U32_MAX) continue;
            if (nearest < 0 || distance[next]! < distance[nearest]! || (distance[next] === distance[nearest] && next < nearest)) nearest = next;
          }
        }
      }
      if (nearest >= 0) load[nearest] = satAdd(load[nearest]!, c.units);
    }

    // Nearest road tiles first, until the component's supply is used up.
    const suppliedRoad = new Uint8Array(len);
    tilesOf.forEach((tiles, id) => {
      // By distance, then index: one number each, sorted as numbers.
      const keys = Float64Array.from(tiles, (idx) => distance[idx]! * len + idx).sort();
      let demand = 0;
      for (const idx of tiles) demand = satAdd(demand, load[idx]!);
      let used = 0;
      for (const key of keys) {
        const idx = key % len;
        const withTile = satAdd(used, load[idx]!);
        if (withTile > supply[id]!) break;
        used = withTile;
        suppliedRoad[idx] = 1;
      }
      components.push({ kind: utility, supply: supply[id]!, demand, supplied: used });
    });

    // A supplied road tile is served, and so is every non-road tile beside it: a road tile beyond the
    // shortage stays dark even beside a supplied one.
    for (let idx = 0; idx < len; idx++) {
      if (suppliedRoad[idx] === 0) continue;
      served[idx] = served[idx]! | bit;
      for (let n = 0; n < 4; n++) {
        const next = neighbour(idx, n);
        if (next >= 0 && roadKind[next] === 0) served[next] = served[next]! | bit;
      }
    }
  }
  return { served, components };
}

/**
 * `update_utility_network` (PostSimStep::Utilities): recomputes after a map edit, and on a new day when what its consumers
 * draw has changed since (stage 3½e: Rust and 3½c recomputed every day, a city of ten thousand buildings or not).
 */
export function updateUtilityNetwork(w: World): void {
  const network = w.utilityNetwork;
  const newDay = w.events.dayAdvanced.length > 0;
  const current = network.version > 0 && network.mapVersion === w.mapEditVersion && network.served.length === w.grid.len();
  if (current && !newDay) return;
  const consumers: Consumer[] = [];
  let signature = 0;
  for (const b of w.buildings.all()) {
    if (!isOperational(b) || !isZonedKind(b.kind)) continue;
    const units = b.capacityResidents + b.capacityJobs;
    consumers.push({ anchor: b.anchor, width: b.width, length: b.length, units });
    for (const value of [b.id, b.anchor.x, b.anchor.y, b.width, b.length, units]) signature = (Math.imul(signature, 31) + value) | 0;
  }
  if (current && signature === network.consumersSignature) return;
  const { served, components } = computeSupply(w.grid, consumers);
  network.served = served;
  network.consumersSignature = signature;
  network.mapVersion = w.mapEditVersion;
  network.version += 1;
  w.utilitySupply.components = components;
  w.utilitySupply.version = network.version;
}
