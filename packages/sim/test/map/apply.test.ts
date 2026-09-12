// Ported from crates/simcity_sim/src/game/map/tests.rs: the command-apply and undo/redo pins, building
// placement and whole-building erase. The milestone and budget pins arrive with stages 3b and 3c.
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../../src/app';
import { buildCost, newBuilding } from '../../src/buildings/building';
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

describe('building placement and erase', () => {
  /** A road along y = 1 over x = 2..=4, the row a 3×3 at (2, 2) touches from below. */
  function roadAbove(w: World): void {
    for (let x = 2; x < 5; x++) send(w, { kind: 'SetRoad', pos: { x, y: 1 }, road: roadCell('TwoLane') });
    update(w);
  }

  const footprintBuildings = (w: World) => {
    const kinds = [];
    for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 3; dy++) kinds.push(w.grid.get({ x: 2 + dx, y: 2 + dy })!.building);
    return kinds;
  };

  it('serviceBuildingASchoolIsPlacedBesideARoadAndPaidFor', () => {
    const w = commandApplyWorld(16, 16);
    roadAbove(w);
    const moneyBefore = w.city.money;
    send(w, { kind: 'PlaceBuilding', pos: { x: 2, y: 2 }, building: 'School' });
    update(w);
    expect(footprintBuildings(w).every((b) => b === 'School')).toBe(true);
    expect(moneyBefore - w.city.money, 'a school costs its price').toBe(700);
    expect(w.buildings.all()).toHaveLength(1);
  });

  /** B5: a 3×3 footprint beside a road places; the road-free interior needs no road of its own. */
  it('placeBuildingWithAdjacentRoadSpawnsEntityAndOccupiesFootprint', () => {
    const w = commandApplyWorld(16, 16);
    roadAbove(w);
    const moneyBefore = w.city.money;
    send(w, { kind: 'PlaceBuilding', pos: { x: 2, y: 2 }, building: 'Hospital' });
    update(w);
    expect(footprintBuildings(w).every((b) => b === 'Hospital'), 'every footprint cell must be occupied').toBe(true);
    expect(w.city.money).toBe(moneyBefore - buildCost('Hospital'));
    expect(w.buildings.all(), 'PlaceBuilding must add the building').toHaveLength(1);
  });

  it('placeBuildingWithoutAnyRoadIsRejected', () => {
    const w = commandApplyWorld(16, 16);
    const moneyBefore = w.city.money;
    send(w, { kind: 'PlaceBuilding', pos: { x: 5, y: 5 }, building: 'Hospital' });
    update(w);
    expect(w.grid.get({ x: 5, y: 5 })!.building).toBeNull();
    expect(w.city.money).toBe(moneyBefore);
    expect(w.buildings.all()).toHaveLength(0);
  });

  it('undoPlaceBuildingClearsFootprintAndRestoresZones', () => {
    const w = commandApplyWorld(16, 16);
    roadAbove(w);
    send(w, { kind: 'SetZone', pos: { x: 2, y: 2 }, zone: 'Residential', density: 'Medium' });
    update(w);
    send(w, { kind: 'PlaceBuilding', pos: { x: 2, y: 2 }, building: 'Hospital' });
    update(w);
    expect(w.buildings.all()).toHaveLength(1);
    expect(w.grid.get({ x: 2, y: 2 })!.zone, 'placement must clear the zone').toBe('None');

    requestUndoRedo(w, false);
    update(w);
    expect(footprintBuildings(w).every((b) => b === null), 'undo must clear every footprint cell').toBe(true);
    expect(w.grid.get({ x: 2, y: 2 })!.zone, 'undo must restore the zone cleared by placement').toBe('Residential');
    expect(w.buildings.all(), 'undo must remove the building').toHaveLength(0);
  });

  /** B6: erasing any footprint cell removes the whole building, and undo brings all of it back. */
  it('eraseOnFootprintCellRemovesWholeBuildingAndUndoRestoresIt', () => {
    const w = commandApplyWorld(16, 16);
    roadAbove(w);
    send(w, { kind: 'PlaceBuilding', pos: { x: 2, y: 2 }, building: 'Hospital' });
    update(w);
    expect(w.buildings.all()).toHaveLength(1);

    send(w, { kind: 'EraseTile', pos: { x: 4, y: 4 } });
    update(w);
    expect(footprintBuildings(w).every((b) => b === null), 'erasing one footprint cell must clear the whole building').toBe(true);
    expect(w.buildings.all(), 'erasing a footprint cell must remove the building').toHaveLength(0);

    requestUndoRedo(w, false);
    update(w);
    expect(footprintBuildings(w).every((b) => b === 'Hospital'), 'undo must restore every footprint cell').toBe(true);
    expect(w.buildings.all(), 'undo must bring the building back').toHaveLength(1);

    requestUndoRedo(w, true);
    update(w);
    expect(footprintBuildings(w).every((b) => b === null), 'redo erases it again').toBe(true);
    expect(w.buildings.all()).toHaveLength(0);
  });

  /** Growth writes cells without history: undoing a zone under a building grown since whole-erases that building. */
  it('undoSetZoneUnderGrownBuildingClearsWholeFootprint', () => {
    const w = commandApplyWorld(8, 8);
    const anchor = { x: 2, y: 2 };
    send(w, { kind: 'SetRoad', pos: { x: 1, y: 2 }, road: roadCell('TwoLane') });
    send(w, { kind: 'SetZone', pos: anchor, zone: 'Residential', density: 'Medium' });
    update(w);
    expect(w.grid.get(anchor)!.zone, 'test setup: SetZone must have been accepted').toBe('Residential');

    const footprint = [anchor, { x: 3, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }];
    for (const tile of footprint) w.grid.set(tile, { ...w.grid.get(tile)!, zone: 'Residential', building: 'Residential' });
    w.buildings.add(newBuilding({ kind: 'Residential', anchor, width: 2, length: 2, capacityResidents: 8 }));

    requestUndoRedo(w, false);
    update(w);
    for (const tile of footprint) {
      expect(w.grid.get(tile)!.building, `undo over a grown building must clear its whole footprint, (${tile.x},${tile.y})`).toBeNull();
    }
    expect(w.buildings.all(), 'the grown building must be removed by the undo').toHaveLength(0);
  });
});
