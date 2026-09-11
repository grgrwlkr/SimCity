// Port of `apply_game_commands_to_grid` and `apply_history_entry` (crates/simcity_sim/src/game/map/
// commands.rs) for roads, zones, erase and map generation. Building placement and the building
// cases of erase and undo arrive with stage 3; traffic lights with stage 2; saves and the test city
// with stage 6. Those commands are read by their own systems, as in Rust.
import type { GameCommand, RoadCell, RoadDir, TilePos, ZoneDensity, ZoneKind } from '../commands';
import type { World } from '../world';
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
  w.city.money -= cost;
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

  w.history.push({ kind: 'EraseTile', pos, oldRoad: cell.road, oldZone: cell.zone });
  clearTile(w, idx);
}

function applyGenerateMap(w: World, seed: bigint): void {
  w.mapSeed = BigInt.asUintN(64, seed);
  generateMapIntoGrid(w.grid, w.mapSeed);
  // History was recorded against the old grid; restoring it would stamp stale cells into the new map.
  w.history.clear();
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
      restoreRoadCell(w, entry.pos, forward ? entry.new : entry.old);
      break;
    case 'SetZone':
      restoreZoneCell(
        w,
        entry.pos,
        forward ? entry.new : entry.old,
        forward ? entry.newDensity : entry.oldDensity,
      );
      break;
    case 'EraseTile': {
      if (forward) {
        const idx = w.grid.idx(entry.pos);
        if (idx !== undefined) clearTile(w, idx);
      } else {
        restoreRoadCell(w, entry.pos, entry.oldRoad);
        // Erasing clears the zone but leaves the tile density, so undo keeps it.
        const density = w.grid.get(entry.pos)?.density ?? 'Medium';
        restoreZoneCell(w, entry.pos, entry.oldZone, density);
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
