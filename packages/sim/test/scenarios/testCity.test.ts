// Ported from crates/simcity_data/src/game/mod.rs (mod tests, mod bus_seeding_tests) and
// crates/simcity_data/src/game/test_city.rs (mod tests) at tag rust-final: the `LoadTestCity` command and the
// test city it builds. Not ported, with the reason in the S4 handoff: `no_mass_freeze_by_day_18` and
// `demo_bus_gets_a_lanelet_planned_route_with_sidecar`.
import { describe, expect, it } from 'vitest';
import { SIZED_IN_TICKS } from './sizedInTicks';
import { frame, step } from '../../src/app';
import { blockHas } from '../../src/buildings/blockers';
import type { TilePos } from '../../src/commands';
import { fleetTripId } from '../../src/fleet';
import { NO_LINK } from '../../src/meso/graph';
import { applyGameCommandsToGrid } from '../../src/map/apply';
import { MAX_ZONE_DEPTH, isWithinZoneDepth } from '../../src/map/zonePlacement';
import { TEST_CITY_MONEY, loadTestCity } from '../../src/scenarios/testCity';
import { requestState } from '../../src/state';
import { UTILITY_KINDS, UtilityNetwork, computeServed, type UtilityKind } from '../../src/utilities';
import { createWorld, type World } from '../../src/world';

/** A world that has just applied `LoadTestCity`, the way the Rust tests ran the handler alone. */
function loadedTestCity(): World {
  const w = createWorld();
  applyGameCommandsToGrid(w, [{ kind: 'LoadTestCity' }]);
  return w;
}

/** A running game that loads the test city through the schedule, like `build_headless_game`. */
function headlessTestCity(): World {
  const w = createWorld();
  requestState(w, 'InGame');
  frame(w, 0);
  w.commands.push({ kind: 'LoadTestCity' });
  // The command applies at the end of the first frame; the fixed tick of the second builds the graphs.
  step(w, 2);
  return w;
}

/** Where a leg of bus `id` still is: waiting to join meso traffic, or on a link. */
function legsOf(w: World, id: number): string[] {
  const m = w.mesoTraffic;
  const trip = fleetTripId(id);
  const legs = m.pending.filter((leg) => leg.citizen === trip).map(() => 'pending');
  for (let car = 0; car < m.highWater; car++) if (m.link[car] !== NO_LINK && m.citizen[car] === trip) legs.push(`link ${m.link[car]}`);
  return legs;
}

function allTiles(w: World): TilePos[] {
  const tiles: TilePos[] = [];
  for (let y = 0; y < w.grid.height; y++) for (let x = 0; x < w.grid.width; x++) tiles.push({ x, y });
  return tiles;
}

describe('test city', () => {
  /** B3 pin: stale history entries would let Ctrl+Z write tile state from the previous map into the loaded one. */
  it('loadTestCityClearsCommandHistory', () => {
    const w = createWorld();
    for (let i = 0; i < 2; i++) {
      w.history.push({ kind: 'SetZone', pos: { x: 1, y: 1 }, old: 'None', new: 'Residential', oldDensity: 'Medium', newDensity: 'Medium' });
    }
    w.history.undo();
    expect(w.history.canUndo() && w.history.canRedo(), 'both stacks are filled before the load').toBe(true);

    applyGameCommandsToGrid(w, [{ kind: 'LoadTestCity' }]);

    expect(w.history.canUndo(), 'LoadTestCity must clear the undo stack (stale entries reference the old map)').toBe(false);
    expect(w.history.canRedo(), 'LoadTestCity must clear the redo stack (stale entries reference the old map)').toBe(false);
  });

  /** A test city is a new city: the milestones of the city before it do not carry over. */
  it('milestoneLoadingTheTestCityStartsMilestonesOver', () => {
    const w = createWorld();
    w.milestones.reach(500);
    applyGameCommandsToGrid(w, [{ kind: 'LoadTestCity' }]);
    expect(w.milestones.bestPopulation).toBe(0);
  });

  it('loadTestCityKeepsZonesWithoutPrebuiltRci', () => {
    const w = loadedTestCity();
    const tiles = allTiles(w);
    const cells = tiles.map((tile) => w.grid.get(tile)!);
    for (const zone of ['Residential', 'Commercial', 'Industrial'] as const) {
      expect(cells.filter((cell) => cell.zone === zone).length, `LoadTestCity should include ${zone} zoning`).toBeGreaterThan(0);
    }

    const highwayY = w.grid.height / 2;
    const arterial2X = (w.grid.width * 3) / 4;
    let upperRightCommercial = 0;
    for (let y = highwayY + 8; y < w.grid.height - 40; y++) {
      for (let x = arterial2X + 5; x < w.grid.width - 15; x++) if (w.grid.get({ x, y })!.zone === 'Commercial') upperRightCommercial++;
    }
    expect(upperRightCommercial, 'LoadTestCity should place Commercial zoning in the upper-right district').toBeGreaterThan(0);

    const deadZoned = tiles.filter((tile) => w.grid.get(tile)!.zone !== 'None' && !isWithinZoneDepth(tile, w.grid, MAX_ZONE_DEPTH));
    expect(deadZoned, `LoadTestCity should not create dead-zoned R/C/I tiles (MAX_ZONE_DEPTH=${MAX_ZONE_DEPTH})`).toEqual([]);

    const rci = new Set(['Residential', 'Commercial', 'Industrial']);
    expect(cells.filter((cell) => cell.building !== null && rci.has(cell.building)).length, 'LoadTestCity should not preseed R/C/I building tiles').toBe(0);
    expect(w.buildings.all().filter((b) => rci.has(b.kind)).length, 'LoadTestCity should not spawn prebuilt R/C/I building records').toBe(0);
    const services = w.buildings.all().filter((b) => b.kind === 'FireStation' || b.kind === 'PoliceStation' || b.kind === 'Hospital');
    expect(services.length, 'LoadTestCity should still spawn service buildings (FireStation, PoliceStation, Hospital)').toBeGreaterThan(0);
    expect(
      services.every((b) => b.phase.kind === 'Operational'),
      'the services are prebuilt, so the city has them from the first tick',
    ).toBe(true);
  });

  /** B1: supply travels only along roads, so the test city's stations must reach every zoned block with a road. */
  it('utilityNetworkTestCitySuppliesEveryZonedBlockWithARoad', () => {
    const w = loadedTestCity();
    const network = new UtilityNetwork();
    network.version = 1;
    network.served = computeServed(w.grid);
    let zoned = 0;
    const dark: [UtilityKind, TilePos][] = [];
    for (const tile of allTiles(w)) {
      if (w.grid.get(tile)!.zone === 'None' || !isWithinZoneDepth(tile, w.grid, MAX_ZONE_DEPTH)) continue;
      zoned++;
      for (const kind of UTILITY_KINDS) if (!blockHas(w.grid, network, tile, kind)) dark.push([kind, tile]);
    }
    expect(zoned, 'the test city has zoned blocks').toBeGreaterThan(0);
    expect(dark.slice(0, 8), `${dark.length} of ${zoned} zoned tiles lack a utility`).toEqual([]);
  });

  /** The lanelet graph of the test city's four-lane and mixed-width boxes builds and is not empty. */
  it('loadTestCityBuildsLaneletGraphWithoutPanic', () => {
    const w = headlessTestCity();
    expect(w.laneletGraph.lanelets.length, 'the FourLane test city must produce lanelets').toBeGreaterThan(0);
    expect(w.laneletConflicts.byIntersection.size, 'conflict matrices must be built for the FourLane intersections').toBeGreaterThan(0);
  }, SIZED_IN_TICKS);

  it('loadTestCitySeedsOneBusRouteAndSpawnsABus', () => {
    const w = headlessTestCity();
    step(w, 1);
    expect(w.busRoutes.routes.length, 'test city seeds exactly one demo bus route').toBe(1);
    expect(w.busRoutes.routes[0]!.stops.length, 'route has >=2 stops').toBeGreaterThanOrEqual(2);
    step(w, 40);
    expect(w.fleet.buses.length, 'at least one bus must spawn from the demo route').toBeGreaterThanOrEqual(1);
  }, SIZED_IN_TICKS);

  /** The demo bus reaches stops and keeps advancing around the loop: it dwells and targets at least four stops. */
  it('demoBusToursAtLeastTwoStops', () => {
    const w = headlessTestCity();
    const targets = new Set<number>();
    let dwelled = false;
    for (let t = 0; t < 4000 && !(targets.size >= 4 && dwelled); t++) {
      step(w, 1);
      const bus = w.fleet.buses[0];
      if (bus === undefined) continue;
      targets.add(bus.stop);
      if (bus.state === 'Dwelling') dwelled = true;
    }
    expect({ targets: targets.size >= 4, dwelled }, `bus never toured: distinct targets ${[...targets].join(',')}`).toEqual({ targets: true, dwelled: true });
  }, SIZED_IN_TICKS);

  /**
   * The buses go with the routes they ran (rust-final mod.rs:121-135): a survivor keeps a stale-map leg, and its route
   * id collides with the rewound counter, so the new route never gets a bus of its own.
   */
  it('reloadingTheTestCityLeavesOneNewBusOnTheNewRoute', () => {
    const w = headlessTestCity();
    step(w, 40);
    expect(w.fleet.buses.length, 'the first city has its bus').toBe(1);
    const old = w.fleet.buses[0]!.id;

    w.commands.push({ kind: 'LoadTestCity' });
    step(w, 40);

    expect(w.fleet.buses.map((bus) => bus.route), 'exactly one bus, on the new route').toEqual([w.busRoutes.routes[0]!.id]);
    expect(w.fleet.buses[0]!.id, 'the old bus went; the new route got its own').not.toBe(old);
    expect(legsOf(w, old), 'no leg of the old bus is left, pending or on the road').toEqual([]);
    const at = w.grid.get(w.fleet.buses[0]!.at)!;
    expect(at.road.kind !== 'None' && !at.water, 'the bus stands on a road').toBe(true);
  }, SIZED_IN_TICKS);

  it('aNewMapTakesTheBusesWithItsRoutes', () => {
    const w = headlessTestCity();
    step(w, 40);
    const old = w.fleet.buses[0]!.id;
    w.commands.push({ kind: 'GenerateMap', seed: 7n });
    w.commands.push({ kind: 'LoadTestCity' });
    step(w, 40);
    expect(w.fleet.buses.length).toBe(1);
    expect(w.fleet.buses[0]!.id).not.toBe(old);
    expect(legsOf(w, old)).toEqual([]);
  }, SIZED_IN_TICKS);

  it('generateMapAloneTakesTheBusesAndTheirLegs', () => {
    const w = headlessTestCity();
    step(w, 40);
    const old = w.fleet.buses[0]!.id;
    w.commands.push({ kind: 'GenerateMap', seed: 7n });
    step(w, 40);
    expect(w.fleet.buses).toEqual([]);
    expect(legsOf(w, old)).toEqual([]);
  }, SIZED_IN_TICKS);

  /** Rust's generator reset the treasury and the calendar with the map. */
  it('loadTestCityStartsTheTreasuryAndTheCalendarOver', () => {
    const w = createWorld();
    w.city.money = 3;
    w.city.day = 40;
    applyGameCommandsToGrid(w, [{ kind: 'LoadTestCity' }]);
    expect({ money: w.city.money, day: w.city.day, population: w.city.population }).toEqual({ money: TEST_CITY_MONEY, day: 1, population: 0 });
  });

  /** The test city is a frozen 128×128 map: a world of another size keeps its own map and its history. */
  it('loadTestCityLeavesAMapOfAnotherSizeAlone', () => {
    const w = createWorld({ mapWidth: 16, mapHeight: 16 });
    w.history.push({ kind: 'SetZone', pos: { x: 1, y: 1 }, old: 'None', new: 'Residential', oldDensity: 'Medium', newDensity: 'Medium' });
    const version = w.mapEditVersion;
    applyGameCommandsToGrid(w, [{ kind: 'LoadTestCity' }]);
    expect({ version: w.mapEditVersion, undo: w.history.canUndo() }).toEqual({ version, undo: true });
  });

  /**
   * Characterisation pin from test_city.rs: the Height overlay paints `height / 255`, so the test city's gentle
   * relief (0..29) reads dark. The mean is the frozen dump's 10.03, not the 10.86 of the Rust generator: see
   * docs/oracle-deviations.md.
   */
  it('theTestCityHasReliefAndItIsGentle', () => {
    const height = loadTestCity().grid.elevation;
    let lo = 255;
    let hi = 0;
    let total = 0;
    for (const h of height) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      total += h;
    }
    expect(hi, 'the terrain must vary, not be a constant plate').toBeGreaterThan(lo);
    expect([lo, hi], 'range quoted in assets/README.md').toEqual([0, 29]);
    expect(Math.abs(total / height.length - 10.03), 'mean of the frozen dump is 10.03').toBeLessThan(0.01);
    expect(hi / 255, 'the highest ground is under a fifth of the ramp').toBeLessThan(0.2);
  });
});
