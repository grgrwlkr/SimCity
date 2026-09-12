// Port of `apply_game_commands_to_grid` and `apply_history_entry` (crates/simcity_sim/src/game/map/
// commands.rs) for roads, zones, building placement, erase and map generation. Traffic lights are read
// by their own system; saves and the test city arrive with stage 6.
import { DEFAULT_PROFILE, buildCost, cloneBuilding, footprintTiles, type Building } from '../buildings/building';
import { spawnBuilding } from '../buildings/spawn';
import type { BuildingKind, GameCommand, RoadCell, RoadDir, TilePos, ZoneDensity, ZoneKind } from '../commands';
import type { World } from '../world';
import type { MapGrid } from './grid';
import { bumpVersion } from './dirty';
import { generateMapIntoGrid } from './generation';
import type { UndoableCommand } from './history';
import { buildCostPerLaneTile, isUpgrade, roadCellEquals, roadCellIsSome, roadCellNone } from './roads';
import { canZoneTile } from './zonePlacement';

function axisOf(dir: RoadDir): 'horizontal' | 'vertical' | null {
  if (dir === 'East' || dir === 'West') return 'horizontal';
  if (dir === 'North' || dir === 'South') return 'vertical';
  return null;
}

function bumpMapEdit(w: World): void {
  w.mapEditVersion = bumpVersion(w.mapEditVersion);
}

function bumpGraph(w: World): void {
  w.graphVersion = bumpVersion(w.graphVersion);
}

function applySetRoad(w: World, pos: TilePos, road: RoadCell): void {
  const idx = w.grid.idx(pos);
  if (idx === undefined) return;
  const cell = w.grid.cellAt(idx);
  // Water tiles are not buildable.
  if (cell.water || !roadCellIsSome(road)) return;

  let newRoad = road;
  // Writing a perpendicular axis onto an existing road tile makes it an intersection node.
  const oldAxis = axisOf(cell.road.dir);
  const newAxis = axisOf(newRoad.dir);
  if (roadCellIsSome(cell.road) && oldAxis !== null && newAxis !== null && oldAxis !== newAxis) {
    newRoad = { ...newRoad, dir: 'None' };
  }
  // An intersection node stays an intersection node.
  if (roadCellIsSome(cell.road) && cell.road.dir === 'None') {
    newRoad = { ...newRoad, dir: 'None' };
  }
  if (roadCellEquals(cell.road, newRoad)) return;

  // Build on empty land, re-lay the same kind for free, upgrade for the difference; never downgrade.
  let cost: number;
  if (cell.road.kind === 'None') {
    cost = buildCostPerLaneTile(newRoad.kind);
  } else if (cell.road.kind === newRoad.kind) {
    cost = 0;
  } else if (isUpgrade(cell.road.kind, newRoad.kind)) {
    cost = buildCostPerLaneTile(newRoad.kind) - buildCostPerLaneTile(cell.road.kind);
  } else {
    return;
  }

  w.history.push({ kind: 'SetRoad', pos, old: cell.road, new: newRoad });
  // Roads may be built in debt (road tooling UX).
  w.budget.post('Construction', -cost, w.city);
  w.grid.setAt(idx, { ...cell, road: newRoad, building: null });
  w.dirty.mark(idx);
  w.roadDirty.mark(idx);
  bumpMapEdit(w);
  bumpGraph(w);
}

function applySetZone(w: World, pos: TilePos, zone: ZoneKind, density: ZoneDensity): void {
  const idx = w.grid.idx(pos);
  if (idx === undefined) return;
  const cell = w.grid.cellAt(idx);
  if (!canZoneTile(w.grid, pos)) return;
  if (cell.zone === zone && cell.density === density) return;

  w.history.push({ kind: 'SetZone', pos, old: cell.zone, new: zone, oldDensity: cell.density, newDensity: density });
  // Zoning is free and clears any building on the tile.
  w.grid.setAt(idx, { ...cell, zone, density, building: null });
  w.dirty.mark(idx);
  bumpMapEdit(w);
}

/** Manual (service) building footprint: the one size the placement check, the command and the record share. */
export const MANUAL_BUILDING_FOOTPRINT = [3, 3] as const;

/**
 * `validate_building_placement`: every footprint tile exists and is free of water, road and building, and
 * the footprint as a whole touches a road (its road-free interior cannot). The tiles, or `undefined`.
 */
export function validateBuildingPlacement(grid: MapGrid, anchor: TilePos, width: number, length: number): TilePos[] | undefined {
  const tiles: TilePos[] = [];
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < length; dy++) {
      const tile = { x: anchor.x + dx, y: anchor.y + dy };
      const cell = grid.get(tile);
      if (cell === undefined || cell.water || roadCellIsSome(cell.road) || cell.building !== null) return undefined;
      tiles.push(tile);
    }
  }
  const besideRoad = (tile: TilePos) =>
    [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ].some(([dx, dy]) => {
      const cell = grid.get({ x: tile.x + dx!, y: tile.y + dy! });
      return cell !== undefined && !cell.water && roadCellIsSome(cell.road);
    });
  return tiles.some(besideRoad) ? tiles : undefined;
}

function applyPlaceBuilding(w: World, pos: TilePos, kind: BuildingKind): void {
  const [width, length] = MANUAL_BUILDING_FOOTPRINT;
  const tiles = validateBuildingPlacement(w.grid, pos, width, length);
  if (tiles === undefined) return;
  const cost = buildCost(kind);
  if (w.city.money < cost) return;

  w.history.push({ kind: 'PlaceBuilding', pos, building: kind, oldZones: tiles.map((tile) => [tile, w.grid.get(tile)!.zone] as const) });
  w.budget.post('Construction', -cost, w.city);
  for (const tile of tiles) {
    const idx = w.grid.idx(tile)!;
    w.grid.setAt(idx, { ...w.grid.cellAt(idx), building: kind, zone: 'None' });
    w.dirty.mark(idx);
  }
  bumpMapEdit(w);
  spawnBuilding(w, pos, width, length, kind, false, DEFAULT_PROFILE);
}

/** The building whose footprint contains `pos`. */
function buildingContaining(w: World, pos: TilePos): Building | undefined {
  return w.buildings.all().find((b) => pos.x >= b.anchor.x && pos.y >= b.anchor.y && pos.x < b.anchor.x + b.width && pos.y < b.anchor.y + b.length);
}

/** Clears the building layer of `b`'s footprint where it still shows `b`'s kind. */
function eraseBuildingCells(w: World, b: Building): void {
  for (const tile of footprintTiles(b)) {
    const idx = w.grid.idx(tile);
    if (idx === undefined || w.grid.cellAt(idx).building !== b.kind) continue;
    w.grid.setAt(idx, { ...w.grid.cellAt(idx), building: null });
    w.dirty.mark(idx);
  }
}

/**
 * Clears any building on `tile` before an exact restore writes over it. Growth writes cells without history,
 * so a restore can land on a building that did not exist when the entry was recorded: its owner goes whole,
 * an ownerless cell is cleared in place.
 */
function clearBuildingAt(w: World, tile: TilePos): void {
  const idx = w.grid.idx(tile);
  if (idx === undefined || w.grid.cellAt(idx).building === null) return;
  const owner = buildingContaining(w, tile);
  if (owner !== undefined) {
    eraseBuildingCells(w, owner);
    w.buildings.remove(owner.id);
  }
  const cell = w.grid.cellAt(idx);
  if (cell.building !== null) {
    w.grid.setAt(idx, { ...cell, building: null });
    w.dirty.mark(idx);
  }
}

function clearTile(w: World, idx: number): void {
  const cell = w.grid.cellAt(idx);
  const roadChanged = roadCellIsSome(cell.road);
  w.grid.setAt(idx, { ...cell, road: roadCellNone(), zone: 'None', building: null });
  w.dirty.mark(idx);
  bumpMapEdit(w);
  if (roadChanged) {
    bumpGraph(w);
    w.roadDirty.mark(idx);
  }
}

function applyEraseTile(w: World, pos: TilePos): void {
  const idx = w.grid.idx(pos);
  if (idx === undefined) return;
  const cell = w.grid.cellAt(idx);
  if (cell.water) return;
  // Nothing to erase: a no-op entry would wipe the redo stack while drag-erasing empty land.
  if (!roadCellIsSome(cell.road) && cell.zone === 'None' && cell.building === null) return;

  // Erasing any cell of a footprint removes the whole building; one cleared cell would orphan the rest.
  let oldBuilding: Building | null = null;
  const owner = cell.building === null ? undefined : buildingContaining(w, pos);
  if (owner !== undefined) {
    eraseBuildingCells(w, owner);
    w.buildings.remove(owner.id);
    oldBuilding = cloneBuilding(owner);
  }
  w.history.push({ kind: 'EraseTile', pos, oldRoad: cell.road, oldZone: cell.zone, oldBuilding });
  clearTile(w, idx);
}

function applyGenerateMap(w: World, seed: bigint): void {
  w.mapSeed = BigInt.asUintN(64, seed);
  generateMapIntoGrid(w.grid, w.mapSeed);
  // History was recorded against the old grid; restoring it would stamp stale cells into the new map.
  w.history.clear();
  // Derived fields of the old city would feed growth and land value for a whole recompute pass.
  w.pollution.resetValues();
  w.landValue.resetValues();
  w.cityFields.resetValues();
  w.dirty.markAll();
  w.roadDirty.markAll();
  bumpMapEdit(w);
  bumpGraph(w);
}

/** Exact restore of a road cell: bypasses the build rules, keeps every side effect. */
function restoreRoadCell(w: World, pos: TilePos, road: RoadCell): void {
  const idx = w.grid.idx(pos);
  if (idx === undefined) return;
  const cell = w.grid.cellAt(idx);
  if (roadCellEquals(cell.road, road)) return;
  w.grid.setAt(idx, { ...cell, road });
  w.dirty.mark(idx);
  w.roadDirty.mark(idx);
  bumpMapEdit(w);
  bumpGraph(w);
}

/** Exact restore of a zone cell: bypasses the zoning adjacency rules. */
function restoreZoneCell(w: World, pos: TilePos, zone: ZoneKind, density: ZoneDensity): void {
  const idx = w.grid.idx(pos);
  if (idx === undefined) return;
  const cell = w.grid.cellAt(idx);
  if (cell.zone === zone && cell.density === density) return;
  w.grid.setAt(idx, { ...cell, zone, density });
  w.dirty.mark(idx);
  bumpMapEdit(w);
}

/** `forward == false` restores the captured pre-state (undo), `true` re-applies the post-state (redo). */
function applyHistoryEntry(w: World, entry: UndoableCommand, forward: boolean): void {
  switch (entry.kind) {
    case 'SetRoad':
      clearBuildingAt(w, entry.pos);
      restoreRoadCell(w, entry.pos, forward ? entry.new : entry.old);
      break;
    case 'SetZone':
      clearBuildingAt(w, entry.pos);
      restoreZoneCell(
        w,
        entry.pos,
        forward ? entry.new : entry.old,
        forward ? entry.newDensity : entry.oldDensity,
      );
      break;
    case 'PlaceBuilding': {
      // Whole-erases whatever grew over these tiles since, so no outside cell survives as a phantom.
      for (const [tile] of entry.oldZones) clearBuildingAt(w, tile);
      for (const [tile, zone] of entry.oldZones) {
        const idx = w.grid.idx(tile);
        if (idx === undefined) continue;
        w.grid.setAt(idx, { ...w.grid.cellAt(idx), building: forward ? entry.building : null, zone: forward ? 'None' : zone });
        w.dirty.mark(idx);
      }
      bumpMapEdit(w);
      if (forward) spawnBuilding(w, entry.pos, MANUAL_BUILDING_FOOTPRINT[0], MANUAL_BUILDING_FOOTPRINT[1], entry.building, false, DEFAULT_PROFILE);
      break;
    }
    case 'EraseTile': {
      const old = entry.oldBuilding;
      if (forward) {
        if (old !== null) {
          eraseBuildingCells(w, old);
          const owner = buildingContaining(w, entry.pos);
          if (owner !== undefined) w.buildings.remove(owner.id);
        }
        const idx = w.grid.idx(entry.pos);
        if (idx !== undefined) clearTile(w, idx);
      } else {
        restoreRoadCell(w, entry.pos, entry.oldRoad);
        // Erasing clears the zone but leaves the tile density, so undo keeps it.
        const density = w.grid.get(entry.pos)?.density ?? 'Medium';
        restoreZoneCell(w, entry.pos, entry.oldZone, density);
        if (old !== null) {
          // A building may have grown over part of the old footprint since: whole-erase it first.
          for (const tile of footprintTiles(old)) clearBuildingAt(w, tile);
          for (const tile of footprintTiles(old)) {
            const idx = w.grid.idx(tile);
            if (idx === undefined) continue;
            w.grid.setAt(idx, { ...w.grid.cellAt(idx), building: old.kind });
            w.dirty.mark(idx);
          }
          bumpMapEdit(w);
          // Verbatim, so level, phase and occupancy survive.
          w.buildings.add(cloneBuilding(old));
        }
      }
      break;
    }
  }
}

/** `GameSet::CommandApply`: the frame's map commands in order, then the frame's undo/redo requests. */
export function applyGameCommandsToGrid(w: World, commands: readonly GameCommand[]): void {
  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'SetRoad':
        applySetRoad(w, cmd.pos, cmd.road);
        break;
      case 'SetZone':
        applySetZone(w, cmd.pos, cmd.zone, cmd.density);
        break;
      case 'EraseTile':
        applyEraseTile(w, cmd.pos);
        break;
      case 'GenerateMap':
        applyGenerateMap(w, cmd.seed);
        break;
      case 'PlaceBuilding':
        applyPlaceBuilding(w, cmd.pos, cmd.building);
        break;
      case 'DumpSaveContract':
      case 'SaveGame':
      case 'LoadGame':
      case 'LoadTestCity':
      case 'PlaceTrafficLight':
      case 'RemoveTrafficLight':
        break;
    }
  }

  // Undo/redo is applied by the owner of the history, not replayed as commands: a replay would
  // re-record history and be rejected by the build rules.
  for (const redo of w.undoRedo) {
    const entry = redo ? w.history.redo() : w.history.undo();
    if (entry !== undefined) applyHistoryEntry(w, entry, redo);
  }
}
