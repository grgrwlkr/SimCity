// Ported from crates/simcity_data/src/game/determinism.rs. Stage 0 drives an empty map; the
// horizon and the pin stay as in Rust so the test city slots in when it exists.
import { describe, expect, it } from 'vitest';
import { step } from '../src/app';
import { fingerprint, fingerprintSections } from '../src/fingerprint';
import { buildHeadlessGame, reseed } from '../src/headless';
import { firstDivergence } from '../src/probe';
import { requestState } from '../src/state';
import { refSlot, spawnVehicle } from '../src/traffic/vehicles';
import type { World } from '../src/world';

/** ~12 game days, as in Rust. */
const TICKS = 2880;

describe('determinism', () => {
  it('sameSeedProducesIdenticalFingerprintsAndDifferentSeedDiverges', () => {
    const a = buildHeadlessGame();
    const b = buildHeadlessGame();
    const c = buildHeadlessGame();
    reseed(a, 42n);
    reseed(b, 42n);
    reseed(c, 1_000_003n);

    const t0 = fingerprint(a);
    step(a, TICKS);
    step(b, TICKS);
    step(c, TICKS);

    // No field is quarantined: the Rust residual on `money` was an ECS ordering artefact.
    expect(fingerprint(a), `same seed + ${TICKS} fixed ticks must produce identical sim state`).toBe(fingerprint(b));
    expect(fingerprint(a), `a different seed must diverge within ${TICKS} ticks`).not.toBe(fingerprint(c));
    expect(fingerprint(a), `expected the sim state to change after ${TICKS} ticks`).not.toBe(t0);
  });

  // Rust `probe_first_divergence_tick` is an ignored diagnostic; here the harness is cheap enough to pin.
  it('probeFirstDivergenceTickFindsTheTickAndTheSection', () => {
    const a = buildHeadlessGame();
    const b = buildHeadlessGame();
    expect(firstDivergence(a, b, 600)).toBeNull();

    const c = buildHeadlessGame();
    const d = buildHeadlessGame();
    const found = firstDivergence(c, d, 600, (tick, _left, right) => {
      if (tick === 250) right.city.money += 1;
    });
    expect(found).toEqual({ tick: 250, sections: ['city'] });
  });

  it('fingerprintCoversEveryStateField', () => {
    const mutations: Array<readonly [string, (w: World) => void]> = [
      ['tick', (w) => void (w.tick += 1)],
      ['appState', (w) => void (w.appState = 'Paused')],
      ['nextState', (w) => requestState(w, 'MainMenu')],
      ['mapSeed', (w) => void (w.mapSeed += 1n)],
      ['city.day', (w) => void (w.city.day += 1)],
      ['city.hour', (w) => void (w.city.hour += 1)],
      ['city.money', (w) => void (w.city.money -= 1)],
      ['city.population', (w) => void (w.city.population += 1)],
      ['city.happiness', (w) => void (w.city.happiness = Math.fround(0.66))],
      ['city.lastIncome', (w) => void (w.city.lastIncome = -5)],
      ['city.lastExpense', (w) => void (w.city.lastExpense = 5)],
      ['clock', (w) => w.clock.tick(1)],
      ['buildingUpgradeClock', (w) => w.buildingUpgradeClock.tick(1)],
      ['simRng', (w) => void w.simRng.nextU32()],
      ['growthRng', (w) => void w.growthRng.nextU32()],
      ['events', (w) => void w.events.dayAdvanced.push(2)],
      ['pendingEvents', (w) => void w.pendingEvents.hourAdvanced.push({ hour: 1, day: 1 })],
      ['notifications', (w) => w.notifications.add('Fire emergency', 'Warning', 5)],
      ['notifications.day', (w) => w.notifications.setDay(9)],
      ['commands', (w) => void w.commands.push({ kind: 'LoadTestCity' })],
      ['dirty', (w) => w.dirty.mark(0)],
      ['roadDirty', (w) => w.roadDirty.mark(0)],
      ['mapEditVersion', (w) => void (w.mapEditVersion += 1)],
      ['graphVersion', (w) => void (w.graphVersion += 1)],
      [
        'history',
        (w) =>
          w.history.push({
            kind: 'SetZone',
            pos: { x: 0, y: 0 },
            old: 'None',
            new: 'Residential',
            oldDensity: 'Medium',
            newDensity: 'Medium',
          }),
      ],
      ['undoRedo', (w) => void w.undoRedo.push(true)],
      ['roadGraph', (w) => void (w.roadGraph.version += 1)],
      ['regionGraph', (w) => void (w.regionGraph.version += 1)],
      ['laneGraph', (w) => void w.laneGraph.posToId.set(1, 1)],
      ['laneletGraph', (w) => void w.laneletGraph.byEntryLane.set(1, [1])],
      ['laneletConflicts', (w) => void w.laneletConflicts.crosswalkSides.set(0, ['West'])],
      ['trafficConfig', (w) => void (w.trafficConfig.driveOnRight = false)],
      ['turnLaneAutogenVersion', (w) => void (w.turnLaneAutogenVersion += 1)],
      ['pathCache', (w) => void (w.pathCache.version += 1)],
      ['pathfindingConfig', (w) => void (w.pathfindingConfig.turnPenalty += 1)],
      ['intersections', (w) => void w.intersections.trafficLightKeys.add('0,0|0,0|1|0')],
      ['trafficOccupancy', (w) => w.trafficOccupancy.ensureLen(4)],
    ];
    // Every typed-array field of the grid, found by reflection so a new layer cannot slip past.
    const gridLayers = Object.entries(buildHeadlessGame().grid).filter(
      (entry): entry is [string, Uint8Array] => entry[1] instanceof Uint8Array,
    );
    expect(gridLayers.length).toBeGreaterThan(5);
    for (const [layer, values] of gridLayers) {
      mutations.push([
        `grid.${layer}`,
        (w) => void ((w.grid as unknown as Record<string, Uint8Array>)[layer]![values.length - 1]! ^= 1),
      ]);
    }
    // Every typed layer of a live vehicle, by reflection so a new layer cannot slip past. Dead slots
    // are not state (a spawn overwrites them), except the slot generation.
    for (const [layer, values] of Object.entries(buildHeadlessGame().vehicles)) {
      if (!ArrayBuffer.isView(values)) continue;
      mutations.push([
        `vehicles.${layer}`,
        (w) => {
          const slot = refSlot(w.vehicles, spawnVehicle(w, { route: [{ x: 0, y: 0 }] }));
          const layers = w.vehicles as unknown as Record<string, Uint8Array>;
          const before = fingerprint(w);
          layers[layer]![slot] = layers[layer]![slot]! + 3;
          expect(fingerprint(w), `fingerprint is blind to live vehicles.${layer}`).not.toBe(before);
        },
      ]);
    }
    mutations.push(
      ['vehicles.order', (w) => void spawnVehicle(w, { route: [{ x: 0, y: 0 }] })],
      [
        'vehicles.generation of a dead slot',
        (w) => void (w.vehicles.generation[w.vehicles.capacity - 1] = 9),
      ],
      [
        'vehicles.trafficState',
        (w) => {
          const slot = refSlot(w.vehicles, spawnVehicle(w, { route: [{ x: 0, y: 0 }] }));
          const before = fingerprint(w);
          w.vehicles.trafficState[slot] = { kind: 'Accelerating' };
          expect(fingerprint(w), 'fingerprint is blind to a live vehicle traffic state').not.toBe(before);
        },
      ],
      ['pathPool', (w) => void w.pathPool.intern([{ x: 1, y: 1 }])],
      ['vehicleSeq', (w) => void (w.vehicleSeq += 1)],
      ['trafficLights', (w) => void w.trafficLights.push({ intersectionId: 0, intersectionKey: 'k', pos: { x: 0, y: 0 }, phase: 'NorthSouthGreen', phaseTimer: 1, greenDuration: 10, yellowDuration: 3, allRedDuration: 4 })],
      ['leftTurnDemand', (w) => void w.leftTurnDemand.ns.add(3)],
      ['reservations', (w) => void w.reservations.ledgerMut(0).setInboxTiles([1])],
      ['events.tripFinished', (w) => void w.events.tripFinished.push({ citizen: 1, purpose: 'Work' })],
      ['trafficOccupancy.ema', (w) => void (w.trafficOccupancy.emaGlobal = 0.5)],
      ['trafficIndex', (w) => void (w.trafficIndex.vehiclesOnRoads = 3)],
      ['trafficRoadCache', (w) => void (w.trafficRoadCache.mapEditVersion = 9)],
      ['routeProducerStats', (w) => void (w.routeProducerStats.guardRefusals += 1)],
      ['laneletStallTracker', (w) => void w.laneletStallTracker.set(7, 3)],
      ['approachFairness', (w) => void w.approachFairness.set('0|North', 2)],
      ['pedestrianCrossings', (w) => void w.pedestrianCrossings.push({ intersectionId: 0, axisNs: true })],
      ['economyConfig', (w) => void (w.economyConfig = { ...w.economyConfig, daysPerMonth: 3 })],
      ['budget.current', (w) => w.budget.current.add('Construction', -1)],
      ['budget.last', (w) => w.budget.endOfDay(1, w.city)],
      ['taxRates', (w) => w.taxRates.set('Commercial', 'High', 3)],
      ['serviceFunding', (w) => w.serviceFunding.set('Fire', 60)],
      ['loans', (w) => void w.loans.active.push({ principal: 10_000, monthlyPayment: 889, monthsLeft: 12 })],
      ['serviceCoverage', (w) => void (w.serviceCoverage.fire = 0.5)],
      ['pollution', (w) => void (w.pollution.currentChunk = 1)],
      ['landValue.currentChunk', (w) => void (w.landValue.currentChunk = 1)],
    );

    for (const [label, mutate] of mutations) {
      const w = buildHeadlessGame();
      const before = fingerprint(w);
      mutate(w);
      expect(fingerprint(w), `fingerprint is blind to ${label}`).not.toBe(before);
    }
  });

  it('fingerprintIsTheSameForTwoFreshWorlds', () => {
    expect(fingerprintSections(buildHeadlessGame())).toEqual(fingerprintSections(buildHeadlessGame()));
  });
});
