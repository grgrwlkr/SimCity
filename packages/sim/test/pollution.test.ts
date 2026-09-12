// Port of the tests in crates/simcity_sim/src/game/pollution.rs: the chunked recompute never shows a zeroed
// tile beside a factory and forgets a removed factory within one pass.
import { describe, expect, it } from 'vitest';
import { newBuilding } from '../src/buildings/building';
import { MapGrid } from '../src/map/grid';
import { computePollution } from '../src/pollution';
import type { World } from '../src/world';
import { t, worldOn } from './buildings/helpers';

/** An 8×8 map: 64 tiles, two chunks of 32 a full pass. */
function factoryWorld(): { w: World; id: number; idx: number } {
  const w = worldOn(new MapGrid(8, 8));
  const factory = w.buildings.add(newBuilding({ kind: 'Industrial', anchor: t(4, 4), capacityJobs: 8 }));
  return { w, id: factory.id, idx: w.grid.idx(t(4, 4))! };
}

const ticksPerPass = (w: World) => Math.ceil(w.grid.len() / w.pollution.chunkSize);

describe('pollution', () => {
  it('sourceTileNeverReadsZeroAfterFirstFullPass', () => {
    const { w, idx } = factoryWorld();
    computePollution(w);
    const passes = ticksPerPass(w);
    for (let i = 1; i < passes; i++) computePollution(w);
    expect(w.pollution.get(idx), 'the source tile is polluted after the first full pass').toBeGreaterThan(0);

    // Every tick for five more passes: a two-phase reset would zero the tile for a whole pass.
    for (let tick = 0; tick < passes * 5; tick++) {
      computePollution(w);
      expect(w.pollution.get(idx), `a tile beside a factory read zero at tick ${tick}`).toBeGreaterThan(0);
    }
  });

  it('pollutionClearsWithinOneFullPassAfterSourceRemoved', () => {
    const { w, id, idx } = factoryWorld();
    computePollution(w);
    const passes = ticksPerPass(w);
    for (let i = 1; i < passes * 2; i++) computePollution(w);
    expect(w.pollution.get(idx)).toBeGreaterThan(0);

    w.buildings.remove(id);
    for (let i = 0; i < passes; i++) computePollution(w);
    expect(w.pollution.get(idx), 'pollution is gone within one full pass after the source is removed').toBe(0);
  });

  // TS: a factory still being built does not pollute; Rust counted every industrial record.
  it('aFactoryUnderConstructionDoesNotPollute', () => {
    const w = worldOn(new MapGrid(8, 8));
    w.buildings.add(newBuilding({ kind: 'Industrial', anchor: t(4, 4), phase: { kind: 'UnderConstruction', daysRemaining: 2 } }));
    for (let i = 0; i < 4; i++) computePollution(w);
    expect(w.pollution.values.every((v) => v === 0)).toBe(true);
  });
});
