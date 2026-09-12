// Port of the tests in crates/simcity_sim/src/game/land_value.rs: service coverage, crime and local traffic heat
// move the value of a tile.
import { describe, expect, it } from 'vitest';
import { computeLandValue } from '../src/landValue';
import { MapGrid } from '../src/map/grid';
import { MASK_FIRE, MASK_MEDICAL, MASK_POLICE } from '../src/services/coverage';
import { roadRow, worldOn } from './buildings/helpers';

describe('land value', () => {
  it('landValueUsesPerTileServiceCoverage', () => {
    const w = worldOn(new MapGrid(3, 1));
    w.serviceCoverage.coverageMap = new Uint8Array([MASK_FIRE | MASK_POLICE | MASK_MEDICAL, 0, 0]);
    computeLandValue(w);
    expect(w.landValue.values[0], 'a covered tile is worth more than an uncovered one').toBeGreaterThan(w.landValue.values[2]!);
  });

  it('cityFieldsCrimeLowersLandValue', () => {
    const w = worldOn(new MapGrid(3, 1));
    w.cityFields.setValues('Crime', new Float32Array([0.9, 0.2, 0.2]));
    computeLandValue(w);
    const [crimeRidden, , safe] = w.landValue.values;
    expect(crimeRidden, `crime-ridden tile ${crimeRidden} against a safe one ${safe}`).toBeLessThan(safe!);
  });

  it('landValueUsesLocalTrafficHeatNotCitywideAverage', () => {
    const grid = new MapGrid(3, 1);
    roadRow(grid, 0, 0, 2);
    const w = worldOn(grid);
    const occ = w.trafficOccupancy;
    occ.ensureLen(3);
    // Only the left tile is congested.
    occ.emaScaled.set([10, 1, 1]);
    occ.maxScaled = 10;
    computeLandValue(w);
    expect(w.landValue.values[0]).toBeLessThan(w.landValue.values[2]!);
  });
});
