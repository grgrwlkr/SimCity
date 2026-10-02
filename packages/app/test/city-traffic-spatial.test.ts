import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CITY_GRID, LEGACY_CITY_GRID } from '../src/city/cityGrid';
import { Harbor, freightPlans } from '../src/city/harbor';
import { cityVehicleKits, freightJunctions } from '../src/city/harborLayout';
import { CityTraffic } from '../src/city/trafficFlow';
import { RouteBuilder } from '../src/city/life/network';

const expected = {
  legacy: 'f313617341afc969e035c8fe2c00862976a70cb4bf6281aa63ef1336257056b1',
  expanded: '759fa4b62097cea8ebd0ec793a0b3c001c14cbbc0ebf54695b307589ba11fb0b',
  harbor: 'd252e35450382d533d94af2a29fb6dc65b349e24092998a03b197e8bd2813ccf',
};

describe('traffic spatial broad phase', () => {
  it.each(['legacy', 'expanded', 'harbor'] as const)('preserves every original traffic state field for %s', (name) => {
    const grid = name === 'legacy' ? LEGACY_CITY_GRID : CITY_GRID;
    const harbor = name === 'harbor' ? new Harbor() : null;
    const traffic = new CityTraffic(cityVehicleKits('689856').slice(0, harbor ? 116 : 112), {
      roads: grid.roads,
      junctions: freightJunctions(grid.roads.length ** 2),
      ...(harbor
        ? {
            plans: freightPlans(),
            onStep: (seconds: number, flow: CityTraffic) => harbor.advance(seconds, flow),
            onReset: () => harbor.reset(),
          }
        : {}),
    });
    traffic.update(10);
    const state = { traffic: traffic.save(), ...(harbor ? { harbor: harbor.save() } : {}) };
    // Captured from the full-scan implementation; covers vehicles, routes and reservations.
    expect(createHash('sha256').update(JSON.stringify(state)).digest('hex')).toBe(expected[name]);
  });

  it('rebuilds the index on restore and reset and updates it during finite trips', () => {
    const sizes = cityVehicleKits('689856').slice(0, 16);
    const direct = new CityTraffic(sizes),
      resumed = new CityTraffic(sizes);
    direct.update(3);
    resumed.restore(direct.save());
    direct.update(5);
    for (let time = 3.1; time < 5; time += 0.1) {
      resumed.update(time);
    }
    resumed.update(5);
    expect(resumed.save()).toEqual(direct.save());
    resumed.update(0);
    const fresh = new CityTraffic(sizes);
    fresh.update(0);
    expect(resumed.save()).toEqual(fresh.save());
  });

  it('keeps future maneuver sweeps occupied even when the car body is in another bucket', () => {
    const traffic = new CityTraffic([]);
    const a = traffic.addCar({ length: 2.8, width: 1.5 }),
      b = traffic.addCar({ length: 2.8, width: 1.5 });
    const departure = new RouteBuilder({ x: 0, z: 0 }).line({ x: 20, z: 0 }).route();
    const approach = new RouteBuilder({ x: 17, z: 0 }).line({ x: 30, z: 0 }).route();
    expect(traffic.beginTrip(b, approach)).toBe(true);
    expect(traffic.beginTrip(a, departure, departure.length)).toBe(false);
    traffic.park(b);
    expect(traffic.beginTrip(a, departure, departure.length)).toBe(true);
    expect(traffic.beginTrip(b, approach)).toBe(false);
    const restored = new CityTraffic([]);
    restored.restore(traffic.save());
    expect(restored.beginTrip(b, approach)).toBe(false);
    restored.park(a);
    expect(restored.beginTrip(b, approach)).toBe(true);
  });
});
