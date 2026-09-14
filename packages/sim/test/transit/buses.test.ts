// Port of the test in crates/simcity_sim/src/game/public_transport.rs, and TS tests of what its systems did untested: a
// bus loops its stops with a dwell at each, skips a stop it cannot reach, and the demo route tours the city's through roads.
import { describe, expect, it } from 'vitest';
import { step } from '../../src/app';
import { buildCity } from '../../src/scenarios/cityGen';
import { BUS_DWELL_SECS, BusRoutes, seedDemoBusRoute } from '../../src/transit/buses';
import { createWorld, type World } from '../../src/world';
import { layRoads } from '../meso/helpers';
import { street, t } from '../services/helpers';

/** The stops a bus comes to rest at, in order, until it has reached `count` of them; and the ticks each dwell took. */
function stopsReached(w: World, count: number, limit: number): { stops: number[]; dwellTicks: number[] } {
  const stops: number[] = [];
  const dwellTicks: number[] = [];
  let dwelling = false;
  for (let tick = 0; tick < limit && stops.length < count; tick++) {
    step(w, 1);
    const bus = w.fleet.buses[0];
    if (bus === undefined) continue;
    if (bus.state === 'Dwelling' && !dwelling) {
      stops.push(bus.stop);
      dwellTicks.push(0);
    }
    if (bus.state === 'Dwelling') dwellTicks[dwellTicks.length - 1]! += 1;
    dwelling = bus.state === 'Dwelling';
  }
  return { stops, dwellTicks };
}

describe('buses', () => {
  it('routeManagerResetClearsRoutesAndId', () => {
    const routes = new BusRoutes();
    const id = routes.createRoute([t(1, 1), t(5, 1)]);
    expect(id).toBe(0);
    expect(routes.routes).toHaveLength(1);
    expect(routes.nextRouteId).toBe(1);
    const version = routes.version;

    routes.reset();
    expect(routes.routes, 'reset must clear routes').toEqual([]);
    expect(routes.nextRouteId, 'reset must rewind the id counter').toBe(0);
    expect(routes.version).toBeGreaterThan(version);
  });

  it('aBusLoopsItsStops', () => {
    const w = street();
    w.busRoutes.createRoute([t(10, 8), t(30, 8), t(50, 8)]);
    const { stops, dwellTicks } = stopsReached(w, 4, 2000);
    expect(w.fleet.buses, 'one bus a route').toHaveLength(1);
    expect(stops, 'from the first stop to the second and third, and round again').toEqual([1, 2, 0, 1]);
    // A tick carries six game seconds on the street's hour of a minute.
    expect(Math.min(...dwellTicks.slice(0, 3)), `dwells of ${dwellTicks.join(' ')} ticks`).toBeGreaterThanOrEqual(Math.floor(BUS_DWELL_SECS / 6));
  });

  it('anUnreachableStopIsSkipped', () => {
    const w = street();
    layRoads(w, [[t(20, 2), t(40, 2), 'TwoLane']]);
    w.busRoutes.createRoute([t(10, 8), t(30, 2), t(50, 8)]);
    expect(stopsReached(w, 3, 2000).stops, 'the stop on the street no road leads to is passed by').toEqual([2, 0, 2]);
  });

  it('theDemoRouteToursTheThroughRoadsOfTheCity', () => {
    const w: World = createWorld();
    buildCity(w);
    seedDemoBusRoute(w.grid, w.busRoutes);
    expect(w.busRoutes.routes).toHaveLength(1);
    const stops = w.busRoutes.routes[0]!.stops;
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(stops.length).toBeLessThanOrEqual(8);
    expect(new Set(stops.map((s) => `${s.x},${s.y}`)).size, 'no stop twice').toBe(stops.length);
    const road = (x: number, y: number) => (w.grid.get({ x, y })?.road.kind ?? 'None') !== 'None';
    for (const s of stops) {
      expect(road(s.x, s.y) && w.grid.get(s)!.road.dir !== 'None', `${s.x},${s.y} is a lane`).toBe(true);
      expect([road(s.x - 1, s.y), road(s.x + 1, s.y), road(s.x, s.y - 1), road(s.x, s.y + 1)].filter(Boolean).length, 'on a through road').toBeGreaterThanOrEqual(2);
    }
    seedDemoBusRoute(w.grid, w.busRoutes);
    expect(w.busRoutes.routes, 'seeded once').toHaveLength(1);
  });
});
