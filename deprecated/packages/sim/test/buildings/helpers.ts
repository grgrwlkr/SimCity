// Fixtures of the building tests, ports of the helpers in crates/simcity_sim/src/game/buildings/tests.rs,
// blockers.rs and utilities.rs.
import type { BuildingKind, TilePos, ZoneDensity, ZoneKind } from '../../src/commands';
import { newBuilding, type Building } from '../../src/buildings/building';
import type { RciDemand } from '../../src/demand';
import { MapGrid } from '../../src/map/grid';
import { UtilityNetwork, computeServed } from '../../src/utilities';
import { createWorld, type World } from '../../src/world';
import { loadGrid, setRoad } from '../transport/helpers';

export const t = (x: number, y: number): TilePos => ({ x, y });

/** Eastbound TwoLane road tiles along row `y` from `x0` to `x1` inclusive. */
export function roadRow(grid: MapGrid, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) setRoad(grid, { x, y }, { dir: 'East' });
}

/** `zone` over the rectangle `x0..=x1` × `y0..=y1`, at `density` when given. */
export function zoneRect(grid: MapGrid, zone: ZoneKind, x0: number, x1: number, y0: number, y1: number, density?: ZoneDensity): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const cell = grid.get({ x, y })!;
      grid.set({ x, y }, { ...cell, zone, density: density ?? cell.density });
    }
  }
}

/** A 3×3 station with its top-left corner at `(x, y)`, on the building layer only. */
export function station(grid: MapGrid, kind: BuildingKind, x: number, y: number): void {
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 3; dy++) {
      const cell = grid.get({ x: x + dx, y: y + dy })!;
      grid.set({ x: x + dx, y: y + dy }, { ...cell, building: kind });
    }
  }
}

/** The 3×3 at `(x, y)` back to default cells. */
export function demolish(grid: MapGrid, x: number, y: number): void {
  const empty = new MapGrid(1, 1).get({ x: 0, y: 0 })!;
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 3; dy++) grid.set({ x: x + dx, y: y + dy }, empty);
  }
}

export function network(grid: MapGrid): UtilityNetwork {
  return UtilityNetwork.fromServed(computeServed(grid));
}

export const demand = (residential: number, commercial = 0, industrial = 0): RciDemand => ({ residential, commercial, industrial });

/** A road along y = 2 with a residential zone three rows deep below it. */
export function block(): MapGrid {
  const grid = new MapGrid(24, 12);
  roadRow(grid, 2, 0, 23);
  zoneRect(grid, 'Residential', 4, 12, 3, 5);
  return grid;
}

export function house(level: number, extra: Partial<Building> = {}): Building {
  return newBuilding({
    kind: 'Residential',
    anchor: t(4, 3),
    level,
    capacityResidents: 12,
    occupancyResidents: 10,
    targetOccupancyResidents: 10,
    ...extra,
  });
}

/** An in-game world over a copy of `grid`. */
export function worldOn(grid: MapGrid): World {
  const w = createWorld({ mapWidth: grid.width, mapHeight: grid.height });
  w.appState = 'InGame';
  loadGrid(w, grid);
  return w;
}
