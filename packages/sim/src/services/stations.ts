// Service stations of crates/simcity_sim/src/game/services/components.rs and systems.rs. A station is an open fire
// station, police station or hospital with a road on or beside its footprint, derived from the building records.
// Rust attached the station once, under construction or not, and kept it after its road was gone. Service
// vehicles come with stage 4.
import { anyFootprintTile, isOperational } from '../buildings/building';
import type { BuildingKind, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import type { World } from '../world';

export const SERVICE_KINDS = ['Fire', 'Police', 'Medical'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export interface ServiceStation {
  readonly kind: ServiceKind;
  /** The anchor of the building; coverage is measured from it. */
  readonly pos: TilePos;
  readonly buildingId: number;
}

export function serviceKindFromBuilding(kind: BuildingKind): ServiceKind | undefined {
  if (kind === 'FireStation') return 'Fire';
  if (kind === 'PoliceStation') return 'Police';
  return kind === 'Hospital' ? 'Medical' : undefined;
}

export function serviceBuildingKind(kind: ServiceKind): BuildingKind {
  return kind === 'Fire' ? 'FireStation' : kind === 'Police' ? 'PoliceStation' : 'Hospital';
}

/** `adjacent_road_any`: a dry road on the tile or one of its four neighbours. */
function roadOnOrBeside(grid: MapGrid, tile: TilePos): boolean {
  for (const [dx, dy] of [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const cell = grid.get({ x: tile.x + dx, y: tile.y + dy });
    if (cell !== undefined && !cell.water && cell.road.kind !== 'None') return true;
  }
  return false;
}

/** The stations of the city, in building order. */
export function serviceStations(w: World): ServiceStation[] {
  const stations: ServiceStation[] = [];
  for (const b of w.buildings.all()) {
    const kind = serviceKindFromBuilding(b.kind);
    if (kind === undefined || !isOperational(b)) continue;
    if (!anyFootprintTile(b.anchor, b.width, b.length, (tile) => roadOnOrBeside(w.grid, tile))) continue;
    stations.push({ kind, pos: b.anchor, buildingId: b.id });
  }
  return stations;
}
