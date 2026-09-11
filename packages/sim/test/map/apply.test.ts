// Ported from crates/simcity_sim/src/game/map/tests.rs: the command-apply and undo/redo pins that
// need no buildings. Placement, erase-of-a-footprint and budget pins move to stage 3.
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../../src/app';
import type { GameCommand, RoadCell, RoadKind, TilePos } from '../../src/commands';
import type { MapGrid } from '../../src/map/grid';
import { createWorld, type World } from '../../src/world';

/** `build_command_apply_app`: a map of the given size with commands applied on each update. */
function commandApplyWorld(width: number, height: number): World {
  const w = createWorld({ mapWidth: width, mapHeight: height });
  w.appState = 'InGame';
  w.graphVersion = 1;
  return w;
}

const send = (w: World, cmd: GameCommand): void => void w.commands.push(cmd);
const requestUndoRedo = (w: World, redo: boolean): void => void w.undoRedo.push(redo);
const update = (w: World): void => applyCommands(w);

function roadCell(kind: RoadKind): RoadCell {
  return { kind, dir: 'East', lane: 0, flow: { kind: 'TwoWay' }, laneType: 'Regular' };
}

const roadKindAt = (w: World, pos: TilePos): RoadKind => w.grid.get(pos)!.road.kind;
const snapshotCells = (grid: MapGrid) => Array.from({ length: grid.len() }, (_, i) => grid.cellAt(i));

describe('map command apply', () => {
  it('commandApplyMarksDirtyAndBumpsGraphVersionOnRoadChange', () => {
    const w = commandApplyWorld(8, 8);
    const pos = { x: 1, y: 1 };
    send(w, { kind: 'SetRoad', pos, road: roadCell('TwoLane') });
    update(w);

    expect(roadKindAt(w, pos)).toBe('TwoLane');
    expect(w.graphVersion, 'GraphVersion should bump on road change').not.toBe(1);
    expect(w.dirty.isMarked(w.grid.idx(pos)!), 'Dirty flag must be set for edited tile').toBe(true);
  });

  it('waterTilesAreNotBuildableByCommands', () => {
    const w = commandApplyWorld(8, 8);
    const pos = { x: 2, y: 2 };
    w.grid.set(pos, { ...w.grid.get(pos)!, water: true });

    const moneyBefore = w.city.money;
    send(w, { kind: 'SetRoad', pos, road: roadCell('TwoLane') });
    update(w);

    expect(w.city.money, 'Should not spend money on water tiles').toBe(moneyBefore);
    expect(roadKindAt(w, pos)).toBe('None');
    expect(w.graphVersion, 'GraphVersion should not bump when command is rejected').toBe(1);
  });

  /** B1: undo of a road build removes the road; undo of an upgrade restores the exact previous kind. */
  it('undoRemovesBuiltRoadAndRestoresDowngradedKind', () => {
    const w = commandApplyWorld(8, 8);
    const pos = { x: 1, y: 1 };

    send(w, { kind: 'SetRoad', pos, road: roadCell('TwoLane') });
    update(w);
    expect(roadKindAt(w, pos)).toBe('TwoLane');

    requestUndoRedo(w, false);
    update(w);
    expect(roadKindAt(w, pos), 'undo of a road build must remove the road').toBe('None');

    send(w, { kind: 'SetRoad', pos, road: roadCell('TwoLane') });
    update(w);
    send(w, { kind: 'SetRoad', pos, road: roadCell('FourLane') });
    update(w);
    expect(roadKindAt(w, pos)).toBe('FourLane');

    requestUndoRedo(w, false);
    update(w);
    expect(roadKindAt(w, pos), 'undo of a road upgrade must restore the exact previous kind').toBe('TwoLane');
  });

  /** B2: undo walks history back to the pre-edit state and the redo stack survives undo. */
  it('undoUndoThenRedoRedoWalksHistory', () => {
    const w = commandApplyWorld(8, 8);
    const preA = snapshotCells(w.grid);

    send(w, { kind: 'SetRoad', pos: { x: 1, y: 1 }, road: roadCell('TwoLane') });
    update(w);
    const postA = snapshotCells(w.grid);
    expect(postA).not.toEqual(preA);

    send(w, { kind: 'SetZone', pos: { x: 2, y: 1 }, zone: 'Residential', density: 'Medium' });
    update(w);
    const postB = snapshotCells(w.grid);
    expect(postB).not.toEqual(postA);

    requestUndoRedo(w, false);
    update(w);
    expect(snapshotCells(w.grid), 'first undo must revert edit B').toEqual(postA);

    requestUndoRedo(w, false);
    update(w);
    expect(snapshotCells(w.grid), 'second undo must revert edit A').toEqual(preA);

    requestUndoRedo(w, true);
    update(w);
    expect(snapshotCells(w.grid), 'redo must re-apply edit A').toEqual(postA);

    requestUndoRedo(w, true);
    update(w);
    expect(snapshotCells(w.grid), 'second redo must re-apply edit B').toEqual(postB);
  });

  /** The zone command paints a block as deep as a building grows and refuses land beyond that depth. */
  it('zoneDensityZoneCommandPaintsABlockAsDeepAsBuildingsGrow', () => {
    const w = commandApplyWorld(16, 16);
    for (let x = 0; x < 16; x++) send(w, { kind: 'SetRoad', pos: { x, y: 1 }, road: roadCell('TwoLane') });
    update(w);

    for (let x = 2; x < 8; x++) {
      for (let y = 2; y < 6; y++) {
        send(w, { kind: 'SetZone', pos: { x, y }, zone: 'Residential', density: 'High' });
      }
    }
    update(w);

    for (let x = 2; x < 8; x++) {
      for (let y = 2; y < 5; y++) {
        const cell = w.grid.get({ x, y })!;
        expect(cell.zone, `(${x},${y}) is within depth`).toBe('Residential');
        expect(cell.density, `(${x},${y}) keeps the density`).toBe('High');
      }
      expect(w.grid.get({ x, y: 5 })!.zone, `(${x},5) is four tiles from the road`).toBe('None');
    }
  });

  /** GenerateMap replaces the grid, so history recorded against the old map must be dropped. */
  it('generateMapClearsCommandHistory', () => {
    const w = commandApplyWorld(8, 8);
    send(w, { kind: 'SetRoad', pos: { x: 1, y: 1 }, road: roadCell('TwoLane') });
    update(w);
    expect(w.history.canUndo(), 'road build must record history').toBe(true);

    send(w, { kind: 'GenerateMap', seed: 7n });
    update(w);
    expect(!w.history.canUndo() && !w.history.canRedo(), 'GenerateMap must clear the command history').toBe(true);
  });

  it('zoneDensityZoneCommandPaintsDensityAndUndoRestoresIt', () => {
    const w = commandApplyWorld(8, 8);
    send(w, { kind: 'SetRoad', pos: { x: 1, y: 1 }, road: roadCell('TwoLane') });
    update(w);
    const zonePos = { x: 2, y: 1 };
    const cellAt = () => w.grid.get(zonePos)!;

    send(w, { kind: 'SetZone', pos: zonePos, zone: 'Residential', density: 'High' });
    update(w);
    expect([cellAt().zone, cellAt().density]).toEqual(['Residential', 'High']);

    send(w, { kind: 'SetZone', pos: zonePos, zone: 'Residential', density: 'Low' });
    update(w);
    expect(cellAt().density, 'the same zone at another density is an edit').toBe('Low');

    requestUndoRedo(w, false);
    update(w);
    expect(cellAt().density, 'undo restores the density it replaced').toBe('High');

    requestUndoRedo(w, false);
    update(w);
    expect([cellAt().zone, cellAt().density]).toEqual(['None', 'Medium']);
  });
});
