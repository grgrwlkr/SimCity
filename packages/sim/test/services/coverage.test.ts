// Port of the test in crates/simcity_sim/src/game/services/coverage.rs, and the TS rule of what a station is.
import { describe, expect, it } from 'vitest';
import { newBuilding, serviceRadius } from '../../src/buildings/building';
import { MapGrid } from '../../src/map/grid';
import { MASK_FIRE, updateServiceCoverage } from '../../src/services/coverage';
import type { World } from '../../src/world';
import { roadRow, t, worldOn } from '../buildings/helpers';

const coveredAt = (w: World, x: number, y: number) => w.serviceCoverage.isCovered(w.grid.idx(t(x, y))!, MASK_FIRE);

describe('service coverage', () => {
  it('maintenancePerBuildingUnderfundedStationCoversLess', () => {
    const grid = new MapGrid(64, 64);
    roadRow(grid, 29, 28, 34);
    const w = worldOn(grid);
    w.buildings.add(newBuilding({ kind: 'FireStation', anchor: t(30, 30) }));
    const full = serviceRadius('FireStation')!;

    updateServiceCoverage(w);
    expect(coveredAt(w, 30 + full, 30), 'fully funded, the station reaches its full radius').toBe(true);

    w.serviceFunding.set('Fire', 50);
    updateServiceCoverage(w);
    expect(coveredAt(w, 30 + full, 30), 'at half funding the edge of the full radius is out of reach, with no map edit').toBe(false);
    expect(coveredAt(w, 30 + Math.trunc(full / 3), 30), 'close tiles are still covered').toBe(true);
  });

  // TS: a station is an open service building beside a road, so coverage follows the building's phase.
  it('aStationCoversOnceItOpensWithNoMapEdit', () => {
    const grid = new MapGrid(64, 64);
    roadRow(grid, 29, 28, 34);
    const w = worldOn(grid);
    const station = w.buildings.add(newBuilding({ kind: 'FireStation', anchor: t(30, 30), phase: { kind: 'UnderConstruction', daysRemaining: 1 } }));

    updateServiceCoverage(w);
    expect(coveredAt(w, 30, 30), 'a station being built covers nothing').toBe(false);

    station.phase = { kind: 'Operational' };
    updateServiceCoverage(w);
    expect(coveredAt(w, 30, 30), 'the open station covers without a map edit').toBe(true);
  });
});
