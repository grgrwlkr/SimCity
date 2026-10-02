// Ported from crates/simcity_sim/src/game/traffic/components.rs (mod tests) and
// traffic/vehicle_seq.rs (mod tests).
import { describe, expect, it } from 'vitest';
import { assignVehicleSeq } from '../../src/traffic/seq';
import {
  clearLaneletPlanOnReroute,
  laneletPlanIsCurrent,
  spawnVehicle,
  upcomingLaneletAt,
  type VehicleLaneletPlan,
} from '../../src/traffic/vehicles';
import { createWorld } from '../../src/world';

describe('vehicle lanelet plan', () => {
  it('upcomingLaneletResolvesAtOffsetMinusOne', () => {
    const plan: VehicleLaneletPlan = {
      entries: [
        [3, 7, 2],
        [9, 8, 5],
      ],
      builtFor: 1,
    };
    expect(upcomingLaneletAt(plan, 2)).toEqual([7, 2]);
    expect(upcomingLaneletAt(plan, 8)).toEqual([8, 5]);
    expect(upcomingLaneletAt(plan, 5)).toBeUndefined();
    expect(upcomingLaneletAt({ entries: [], builtFor: 0 }, 0)).toBeUndefined();
  });

  it('isCurrentRequiresMatchingVersionAndEntries', () => {
    const plan: VehicleLaneletPlan = { entries: [[3, 7, 2]], builtFor: 4 };
    expect(laneletPlanIsCurrent(plan, 4), 'same version + non-empty = current').toBe(true);
    expect(laneletPlanIsCurrent(plan, 5), 'other version = stale').toBe(false);
    expect(laneletPlanIsCurrent({ entries: [], builtFor: 4 }, 4), 'empty plan never claims currency').toBe(false);
  });

  it('clearLaneletPlanOnRerouteClearsAndNoOps', () => {
    const plan: VehicleLaneletPlan = { entries: [[3, 7, 2]], builtFor: 1 };
    clearLaneletPlanOnReroute(plan);
    expect(plan.entries, 'non-empty plan is cleared on reroute').toEqual([]);
    clearLaneletPlanOnReroute(undefined);
    const empty: VehicleLaneletPlan = { entries: [], builtFor: 0 };
    clearLaneletPlanOnReroute(empty);
    expect(empty.entries).toEqual([]);
  });
});

describe('vehicle sequence numbers', () => {
  it('vehiclesAreNumberedInTheOrderTheyArriveAndKeepTheirNumber', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    const spawn = () => spawnVehicle(w, { route: [{ x: 0, y: 0 }] });
    const first = spawn();
    const second = spawn();
    assignVehicleSeq(w);
    const third = spawn();
    assignVehicleSeq(w);
    assignVehicleSeq(w);
    const seq = (ref: number) => w.vehicles.seq[ref % w.vehicles.alive.length];
    expect([seq(first), seq(second), seq(third)]).toEqual([1, 2, 3]);
  });
});
