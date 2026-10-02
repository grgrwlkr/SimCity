// Stage 3½b: travel times between districts of 16×16 tiles, from the meso graph, a few rows a tick.
import { describe, expect, it } from 'vitest';
import { MATRIX_ROWS_PER_TICK, NO_TIME, updateDistrictTimes } from '../../src/meso/districts';
import { buildAllRows, layRoads, roadWorld, t } from './helpers';

describe('district travel times', () => {
  it('districtTimesAreRoadLengthOverSpeed', () => {
    const w = roadWorld(64, 16, [[t(1, 8), t(62, 8), 'TwoLane']]);
    buildAllRows(w);
    const d = w.districtTimes;
    const [west, east] = [d.districtAt(t(8, 8))!, d.districtAt(t(56, 8))!];
    // 48 tiles of 10 m at 40 km/h, on the lane of either way.
    expect([d.seconds(west, east), d.seconds(east, west)]).toEqual([43, 43]);
    expect(d.seconds(west, west)).toBe(0);
  });

  it('unreachableDistrictsHaveNoTime', () => {
    const w = roadWorld(64, 32, [
      [t(1, 8), t(62, 8), 'TwoLane'],
      [t(1, 24), t(62, 24), 'TwoLane'],
    ]);
    buildAllRows(w);
    const d = w.districtTimes;
    expect(d.seconds(d.districtAt(t(8, 8))!, d.districtAt(t(8, 24))!), 'no road joins them').toBe(NO_TIME);
    expect(d.seconds(d.districtAt(t(8, 8))!, d.districtAt(t(56, 8))!)).toBeLessThan(NO_TIME);
  });

  it('matrixRowsRebuildWithinTheirBudget', () => {
    const w = roadWorld(64, 32, [
      [t(1, 8), t(62, 8), 'TwoLane'],
      [t(1, 24), t(62, 24), 'TwoLane'],
    ]);
    const d = w.districtTimes;
    updateDistrictTimes(w);
    expect(d.rowsBuilt(), 'a tick builds its budget of rows').toBe(MATRIX_ROWS_PER_TICK);
    updateDistrictTimes(w);
    expect(d.rowsBuilt(), 'eight districts in two ticks').toBe(Math.min(8, 2 * MATRIX_ROWS_PER_TICK));
    const apart = d.seconds(d.districtAt(t(8, 8))!, d.districtAt(t(8, 24))!);

    // A road joins the two: the graph changes, and the times of the old one serve until their rows are rebuilt.
    layRoads(w, [[t(40, 7), t(40, 25), 'TwoLane']]);
    updateDistrictTimes(w);
    expect(d.rowsBuilt(), 'a tick rebuilds its budget again').toBe(MATRIX_ROWS_PER_TICK);
    buildAllRows(w);
    expect(d.seconds(d.districtAt(t(8, 8))!, d.districtAt(t(8, 24))!), 'and the districts are joined').toBeLessThan(apart);
  });
});
