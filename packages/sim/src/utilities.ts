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

/** Supply masks and balances for `grid` with `consumers` drawing on it. */
export function computeSupply(grid: MapGrid, consumers: readonly Consumer[]): { served: Uint8Array; components: SupplyBalance[] } {
  const len = grid.len();
  const served = new Uint8Array(len);
  const components: SupplyBalance[] = [];
  const width = grid.width;
  const neighbours = (idx: number): number[] => {
    const x = idx % width;
    const y = Math.trunc(idx / width);
    const out: number[] = [];
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const next = grid.idx({ x: x + dx, y: y + dy });
      if (next !== undefined) out.push(next);
    }
    return out;
  };
  const isRoad = (idx: number) => grid.roadKind[idx] !== 0;

  for (const utility of UTILITY_KINDS) {
    const stationCode = 1 + BUILDING_KINDS.indexOf(STATIONS[utility]);
    const bit = utilityMask(utility);
    const capacity = utilityCapacity(STATIONS[utility]) ?? 0;
    const isStation = (idx: number) => grid.building[idx] === stationCode;

    // Distance along the road from the nearest station for every road tile a station feeds; a station tile is served itself.
    const distance = new Array<number>(len).fill(U32_MAX);
    const queue: number[] = [];
    for (let idx = 0; idx < len; idx++) {
      if (!isStation(idx)) continue;
      served[idx] = served[idx]! | bit;
      for (const next of neighbours(idx)) {
        if (isRoad(next) && distance[next] === U32_MAX) {
          distance[next] = 0;
          queue.push(next);
        }
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const idx = queue[head]!;
      for (const next of neighbours(idx)) {
        if (isRoad(next) && distance[next] === U32_MAX) {
          distance[next] = distance[idx]! + 1;
          queue.push(next);
        }
      }
    }
    const reached = (idx: number) => distance[idx] !== U32_MAX;

    // The road components the stations feed.
    const component = new Int32Array(len).fill(-1);
    const tilesOf: number[][] = [];
    for (let start = 0; start < len; start++) {
      if (!reached(start) || component[start] !== -1) continue;
      const id = tilesOf.length;
      component[start] = id;
      const tiles = [start];
      for (let cursor = 0; cursor < tiles.length; cursor++) {
        for (const next of neighbours(tiles[cursor]!)) {
          if (reached(next) && component[next] === -1) {
            component[next] = id;
            tiles.push(next);
          }
        }
      }
      tilesOf.push(tiles);
    }

    // Each component's supply: every station block beside it.
    const supply = new Array<number>(tilesOf.length).fill(0);
    const seen = new Uint8Array(len);
    for (let start = 0; start < len; start++) {
      if (!isStation(start) || seen[start] === 1) continue;
      seen[start] = 1;
      const block = [start];
      const fed: number[] = [];
      for (let cursor = 0; cursor < block.length; cursor++) {
        for (const next of neighbours(block[cursor]!)) {
          if (isStation(next)) {
            if (seen[next] === 0) {
              seen[next] = 1;
              block.push(next);
            }
          } else if (component[next] !== -1 && !fed.includes(component[next]!)) {
            fed.push(component[next]!);
          }
        }
      }
      const stations = Math.ceil(block.length / STATION_TILES);
      for (const id of fed) supply[id] = satAdd(supply[id]!, Math.min(stations * capacity, U32_MAX));
    }

    // Every building draws on the road tile it fronts nearest to a station.
    const load = new Array<number>(len).fill(0);
    for (const c of consumers) {
      let nearest: number | undefined;
      for (let dy = 0; dy < c.length; dy++) {
        for (let dx = 0; dx < c.width; dx++) {
          const idx = grid.idx({ x: c.anchor.x + dx, y: c.anchor.y + dy });
          if (idx === undefined) continue;
          for (const next of neighbours(idx)) {
            if (!reached(next)) continue;
            if (nearest === undefined || distance[next]! < distance[nearest]! || (distance[next] === distance[nearest] && next < nearest)) nearest = next;
          }
        }
      }
      if (nearest !== undefined) load[nearest] = satAdd(load[nearest]!, c.units);
    }

    // Nearest road tiles first, until the component's supply is used up.
    const suppliedRoad = new Uint8Array(len);
    tilesOf.forEach((tiles, id) => {
      tiles.sort((a, b) => distance[a]! - distance[b]! || a - b);
      const demand = tiles.reduce((total, idx) => satAdd(total, load[idx]!), 0);
      let used = 0;
      for (const idx of tiles) {
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
      for (const next of neighbours(idx)) if (!isRoad(next)) served[next] = served[next]! | bit;
    }
  }
  return { served, components };
}

/** `update_utility_network` (PostSimStep::Utilities): recomputes after a map edit or when a day has passed. */
export function updateUtilityNetwork(w: World): void {
  const network = w.utilityNetwork;
  const newDay = w.events.dayAdvanced.length > 0;
  if (!newDay && network.version > 0 && network.mapVersion === w.mapEditVersion && network.served.length === w.grid.len()) return;
  const consumers: Consumer[] = [];
  for (const b of w.buildings.all()) {
    if (!isOperational(b) || !isZonedKind(b.kind)) continue;
    consumers.push({ anchor: b.anchor, width: b.width, length: b.length, units: b.capacityResidents + b.capacityJobs });
  }
  const { served, components } = computeSupply(w.grid, consumers);
  network.served = served;
  network.mapVersion = w.mapEditVersion;
  network.version += 1;
  w.utilitySupply.components = components;
  w.utilitySupply.version = network.version;
}
