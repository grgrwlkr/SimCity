import {
  ROAD_DIRS,
  ROAD_KINDS,
  LivingCityScenario,
  createWorld,
  fingerprint,
  frame,
  linkRoomMeters,
  monthlyPayment,
  newCitizen,
  requestState,
  rngProbeDigest,
  step,
  tileDiagnosis,
  toHex64,
  type World,
} from '@simcity/sim';
import { describe, expect, it, vi } from 'vitest';
import { SIZED_IN_TICKS } from '../../sim/test/scenarios/sizedInTicks';
import { loadTestCity } from '../../sim/test/testCity';
import { RENDER_CAPACITY, SimHost } from '../src/host';
import { GRID_LAYER_NAMES, type GridLayers } from '../src/protocol';
import { BUS_KIND, FIRE_KIND, PARKED_TRUCK_KIND, PARKED_VEHICLE_KIND, PEDESTRIAN_KIND, RenderReader, TRUCK_KIND } from '../src/renderBuffer';
import { SAMPLE_CARS } from '../src/sample';
import { SCENARIOS } from '../src/scenarios';

const worldOf = (host: SimHost): World => (host as unknown as { world: World }).world;

describe('SimHost', { timeout: SIZED_IN_TICKS }, () => {
  // Stage 4: the HUD and the markers read the services from the snapshot; the frame draws the city's vehicles in their kinds.
  it('snapshotCarriesTheServicesOfTheCity', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    host.handle({ t: 'debugEmergency', kind: 'Fire', x: 40, y: 26 });
    expect(host.handle({ t: 'snapshot' }).services.emergencies).toEqual([{ id: 0, kind: 'Fire', x: 40, y: 26 }]);

    host.handle({ t: 'step', ticks: 5 });
    const services = host.handle({ t: 'snapshot' }).services;
    expect(services).toMatchObject({ vehicles: 2 * 3 + 3 * 4 + 2, buses: 1 });
    expect(services.vehiclesOut, 'a fire engine is on its way').toBeGreaterThan(0);
    const reader = new RenderReader(host.render);
    const frame = reader.allocate();
    reader.readInto(frame);
    const kinds = new Set(frame.kind.subarray(0, frame.count));
    expect([kinds.has(FIRE_KIND), kinds.has(BUS_KIND)], 'drawn as a fire engine and a bus').toEqual([true, true]);
  }, SIZED_IN_TICKS);

  // U0: the HUD's panels read the economy, the feed and the city's progress from the snapshot.
  it('snapshotCarriesTheBudgetOfThisMonthAndTheLast', () => {
    const host = new SimHost(16);
    const w = worldOf(host);
    const m0 = w.city.money;
    w.budget.restart(m0);
    w.budget.post('ResidentialTax', 120, w.city);
    w.budget.post('ServiceMaintenance', -20, w.city);
    // A month of one day closes on the first.
    w.budget.endOfDay(1, w.city);
    w.budget.post('RoadMaintenance', -7, w.city);
    w.budget.daysElapsed = 3;
    const { budget } = host.handle({ t: 'snapshot' });
    expect(budget.last).toEqual({
      month: 0,
      moneyStart: m0,
      moneyEnd: m0 + 100,
      lines: [
        { item: 'ResidentialTax', amount: 120 },
        { item: 'ServiceMaintenance', amount: -20 },
      ],
    });
    expect(budget.current).toEqual({ month: 1, moneyStart: m0 + 100, moneyEnd: m0 + 93, lines: [{ item: 'RoadMaintenance', amount: -7 }] });
    expect(budget.daysElapsed).toBe(3);
    expect(budget.daysPerMonth).toBe(w.economyConfig.daysPerMonth);
  });

  it('snapshotCarriesTaxRatesFundingAndLoans', () => {
    const host = new SimHost(16);
    const w = worldOf(host);
    w.taxRates.set('Commercial', 'High', 14);
    w.serviceFunding.set('Police', 80);
    expect(w.loans.take(25_000, w.budget, w.city)).toBeUndefined();
    const s = host.handle({ t: 'snapshot' });
    expect(s.taxRates).toEqual({
      Residential: { Low: 9, Middle: 9, High: 9 },
      Commercial: { Low: 9, Middle: 9, High: 14 },
      Industrial: { Low: 9, Middle: 9, High: 9 },
    });
    expect(s.serviceFunding).toEqual({ Fire: 100, Police: 80, Medical: 100 });
    expect(s.loans).toEqual([{ principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 12 }]);
    // Copies: nothing the HUD holds writes back into the world.
    (s.taxRates.Commercial as Record<string, number>).High = 0;
    (s.serviceFunding as Record<string, number>).Police = 0;
    expect(w.taxRates.get('Commercial', 'High')).toBe(14);
    expect(w.serviceFunding.get('Police')).toBe(80);
  });

  it('snapshotCarriesTheToastsOnScreenAndTheFeedHistory', () => {
    const host = new SimHost(16);
    const w = worldOf(host);
    w.notifications.add('Road built', 'Info', 4);
    w.notifications.add('Road built', 'Info', 4);
    w.notifications.addAt('Fire!', 'Warning', 8, { x: 3, y: 4 });
    const before = host.handle({ t: 'fingerprint' }).fingerprint;
    const first = host.snapshot(1_000);
    expect(first.toasts.map((t) => [t.text, t.kind, t.count, t.at])).toEqual([
      ['Road built', 'Info', 2, null],
      ['Fire!', 'Warning', 1, { x: 3, y: 4 }],
    ]);
    expect(first.history).toEqual([
      { day: 0, text: 'Road built', kind: 'Info', count: 2 },
      { day: 0, text: 'Fire!', kind: 'Warning', count: 1 },
    ]);
    // Six real seconds on, the four-second toast has retired; the history keeps both lines.
    const later = host.snapshot(7_000);
    expect(later.toasts.map((t) => t.text)).toEqual(['Fire!']);
    expect(later.history).toHaveLength(2);
    // The screen's memory is the host's: the world and its fingerprint never see the wall clock.
    expect(host.handle({ t: 'fingerprint' }).fingerprint).toBe(before);
    // A history line handed out is a copy: a later repeat does not change what the HUD already holds.
    w.notifications.add('Fire!', 'Warning', 8);
    expect(later.history[1]!.count).toBe(1);
  });

  it('updateReportsAToastRetiringWhileTheWorldStandsStill', () => {
    const host = new SimHost(16);
    worldOf(host).notifications.add('Hello', 'Info', 2);
    expect(host.update(0)?.toasts.map((t) => t.text)).toEqual(['Hello']);
    expect(host.update(1_000)).toBeNull();
    expect(host.update(3_000)?.toasts).toEqual([]);
    expect(host.update(4_000)).toBeNull();
  });

  it('snapshotCarriesTheMilestoneReachedAndTheNextOne', () => {
    const host = new SimHost(16);
    const w = worldOf(host);
    expect(host.handle({ t: 'snapshot' }).milestones).toEqual({ bestPopulation: 0, next: { population: 250, unlocks: 'School' } });
    w.milestones.reach(300);
    expect(host.handle({ t: 'snapshot' }).milestones).toEqual({ bestPopulation: 300, next: { population: 1000, unlocks: 'University' } });
    w.milestones.reach(1000);
    expect(host.handle({ t: 'snapshot' }).milestones).toEqual({ bestPopulation: 1000, next: null });
  });

  it('snapshotHasTheAdvisorsProblemsAndNoTileDiagnosis', () => {
    const s = new SimHost(16).handle({ t: 'snapshot' });
    // The advisor is S3's: the field is there, empty until it is ported.
    expect(s.advisor).toEqual([]);
    expect(Object.keys(s).sort()).toEqual(
      [
        'tick',
        'appState',
        'speed',
        'realRate',
        'errors',
        'mapSeed',
        'city',
        'mapEditVersion',
        'graphVersion',
        'lights',
        'traffic',
        'services',
        'budget',
        'taxRates',
        'serviceFunding',
        'loans',
        'toasts',
        'history',
        'milestones',
        'advisor',
      ].sort(),
    );
  });

  it('tileDiagnosisComesOnRequest', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    host.handle({ t: 'step', ticks: 10 });
    const w = worldOf(host);
    expect(host.handle({ t: 'tileDiagnosis', pos: { x: -1, y: 0 } })).toBeNull();
    let checked = 0;
    // The first few held-back tiles are enough: every tile of the map is seconds of work under a loaded machine.
    for (let y = 0; y < w.grid.height && checked < 8; y++) {
      for (let x = 0; x < w.grid.width && checked < 8; x++) {
        const expected = tileDiagnosis(w.grid, w.utilityNetwork, w.rciDemand, { x, y }, w.cityFields);
        if (expected === null) continue;
        expect(host.handle({ t: 'tileDiagnosis', pos: { x, y } })).toEqual({ zone: expected[0], reason: expected[1] });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, SIZED_IN_TICKS);

  it('mapLayersCarryTheMapSeed', () => {
    const host = new SimHost(16);
    const w = worldOf(host);
    expect(host.handle({ t: 'mapLayers' }).mapSeed).toBe(w.mapSeed.toString());
    w.mapSeed = 0xffff_ffff_ffff_fff1n;
    expect(host.handle({ t: 'mapLayers' }).mapSeed).toBe('18446744073709551601');
  });

  it('theSnapshotDoesNotGrowWithTheCitizens', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    host.handle({ t: 'step', ticks: 30 });
    const w = worldOf(host);
    const bytes = () => JSON.stringify(host.handle({ t: 'snapshot' })).length;
    const before = bytes();
    const homes = w.buildings.all().filter((b) => b.kind === 'Residential');
    for (const b of homes) b.capacityResidents += 1_000;
    const citizens = w.citizens.count;
    for (let i = 0; i < 20_000; i++) w.citizens.add(newCitizen(homes[i % homes.length]!));
    expect(w.citizens.count).toBe(citizens + 20_000);
    // A field per citizen would add at least a byte each; the counters' digits move by a few.
    expect(Math.abs(bytes() - before)).toBeLessThan(64);
  }, SIZED_IN_TICKS);

  it('stepRepliesWithTheFingerprintOfTheSameRunInProcess', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    const reply = host.handle({ t: 'step', ticks: 500 });

    const w = createWorld();
    requestState(w, 'InGame');
    step(w, 500);
    expect(reply).toEqual({ tick: 500, fingerprint: toHex64(fingerprint(w)) });
  });

  it('commandsGoThroughTheRustJsonCodec', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'step', ticks: 1 });
    host.handle({ t: 'cmd', cmd: { GenerateMap: { seed: 99 } } });
    host.handle({ t: 'step', ticks: 1 });
    expect(host.handle({ t: 'snapshot' })).toMatchObject({ mapSeed: '99', appState: 'InGame', tick: 2 });
  });

  it('undoRedoRequestsReachTheMapHistory', () => {
    const host = new SimHost(16);
    const pos = { x: 1, y: 1 };
    const roadAt = () => host.handle({ t: 'tile', pos });
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'step', ticks: 1 });

    host.handle({
      t: 'cmd',
      cmd: { SetRoad: { pos, road: { kind: 'TwoLane', dir: 'East', lane: 0, flow: 'TwoWay', lane_type: 'Regular' } } },
    });
    host.handle({ t: 'step', ticks: 1 });
    expect(roadAt()).toMatchObject({ road: { kind: 'TwoLane' } });

    host.handle({ t: 'undoRedo', redo: false });
    host.handle({ t: 'step', ticks: 1 });
    expect(roadAt()).toMatchObject({ road: { kind: 'None' } });

    host.handle({ t: 'undoRedo', redo: true });
    host.handle({ t: 'step', ticks: 1 });
    expect(roadAt()).toMatchObject({ road: { kind: 'TwoLane' } });
  });

  it('tileOutsideTheMapIsNull', () => {
    expect(new SimHost(16).handle({ t: 'tile', pos: { x: -1, y: 0 } })).toBeNull();
  });

  it('rejectsACommandRustWouldReject', () => {
    const host = new SimHost(16);
    expect(() => host.handle({ t: 'cmd', cmd: { Teleport: {} } })).toThrow();
  });

  it('rngProbeMatchesTheSimDigest', () => {
    const host = new SimHost(16);
    expect(host.handle({ t: 'rngProbe', seed: '7', draws: 1_000 })).toBe(rngProbeDigest(7n, 1_000));
  });

  it('updateRunsAtTheRequestedSpeedAndPublishesAFrame', () => {
    const host = new SimHost(16);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();

    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'setSpeed', speed: 'X3' });
    expect(host.update(0)?.appState, 'the frame that enters the game reports it').toBe('InGame');
    const snapshot = host.update(250);

    // ×3 is three times real time: a quarter of a second is seven ticks, the half left over waits for the next frame.
    expect(snapshot).toMatchObject({ tick: 7, speed: 'X3' });
    reader.readInto(out);
    expect(out.tick).toBe(7);
  });

  it('updateReportsNothingWhenNothingChanged', () => {
    const host = new SimHost(16);
    host.update(0);
    expect(host.update(16)).toBeNull();
  });

  it('mapLayersReplyCopiesTheGrid', () => {
    const host = new SimHost(16);
    const pos = { x: 3, y: 4 };
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'step', ticks: 1 });
    host.handle({
      t: 'cmd',
      cmd: { SetRoad: { pos, road: { kind: 'TwoLane', dir: 'East', lane: 0, flow: 'TwoWay', lane_type: 'Regular' } } },
    });
    host.handle({ t: 'step', ticks: 1 });

    const reply = host.handle({ t: 'mapLayers' });
    const i = pos.y * reply.width + pos.x;
    expect(reply).toMatchObject({ width: 128, height: 128, tileSize: 16 });
    expect(reply.mapEditVersion).toBeGreaterThan(0);
    expect(reply.layers.roadKind[i]).toBe(ROAD_KINDS.indexOf('TwoLane'));
    expect(reply.layers.roadDir[i]).toBe(ROAD_DIRS.indexOf('East'));

    reply.layers.roadKind.fill(0);
    expect(host.handle({ t: 'tile', pos }), 'the reply is a copy').toMatchObject({ road: { kind: 'TwoLane' } });
  });

  it('loadGridBumpsVersionsAndRebuildsGraphs', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'step', ticks: 1 });
    const before = host.handle({ t: 'snapshot' });

    host.handle({ t: 'loadGrid', layers: testCityLayers() });
    const after = host.handle({ t: 'snapshot' });
    expect(after.graphVersion).toBeGreaterThan(before.graphVersion);
    expect(after.mapEditVersion).toBeGreaterThan(before.mapEditVersion);

    host.handle({ t: 'step', ticks: 1 });
    const overlay = host.handle({ t: 'debugOverlay' });
    expect(overlay.lanelets.length, 'the lanelets of the test city are built on the next tick').toBe(
      loadTestCity().laneletGraph.lanelets.length,
    );
  });

  it('loadGridRejectsTheWrongSize', () => {
    const host = new SimHost(16);
    const layers = testCityLayers();
    expect(() => host.handle({ t: 'loadGrid', layers: { ...layers, roadKind: new Uint8Array(4) } })).toThrow();
  });

  it('updateReportsAMapEditWithoutATick', () => {
    const host = new SimHost(16);
    host.update(0);
    host.handle({ t: 'loadGrid', layers: testCityLayers() });
    expect(host.update(16)?.mapEditVersion).toBeGreaterThan(0);
  });

  it('debugOverlayListsClustersAndLanelets', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'loadGrid', layers: testCityLayers() });
    host.handle({ t: 'step', ticks: 1 });

    const w = loadTestCity();
    const overlay = host.handle({ t: 'debugOverlay' });
    expect(overlay.clusters.length).toBe(w.intersections.clusters.length);
    expect(overlay.clusters[0]!.tiles).toEqual(w.intersections.clusters[0]!.tiles.flatMap((p) => [p.x, p.y]));
    const first = w.laneletGraph.lanelets[0]!;
    expect(overlay.lanelets[0]).toEqual({
      intersection: first.intersection,
      maneuver: first.maneuver,
      // Approach lane, the in-box tiles, exit lane: the line a lanelet overlay draws.
      path: [w.laneGraph.getLane(first.entryLane)!.pos, ...first.internalPath, w.laneGraph.getLane(first.exitLane)!.pos].flatMap(
        (p) => [p.x, p.y],
      ),
    });
  });

  it('signalizedScenarioDrivesVehiclesAndReportsTheLight', () => {
    const host = new SimHost(256);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'signalizedCross' });
    host.handle({ t: 'step', ticks: 110 });

    reader.readInto(out);
    expect(out.count, 'two waves of four, at ticks 1 and 101').toBe(8);
    const { lights, mapEditVersion } = host.handle({ t: 'snapshot' });
    expect(mapEditVersion, 'the cross is on the map').toBeGreaterThan(0);
    expect(lights).toEqual([{ minX: 40, minY: 40, maxX: 41, maxY: 41, phase: expect.any(String) }]);
  });

  it('everyScenarioOfTheMenuStartsInTheHost', () => {
    for (const { name } of SCENARIOS) {
      const host = new SimHost(4096);
      host.handle({ t: 'setState', state: 'InGame' });
      // The metropolis on a small map of its own: the million is the gate's, not this check's.
      host.handle(name === 'metropolis' ? { t: 'scenario', name, size: 160 } : { t: 'scenario', name });
      host.handle({ t: 'step', ticks: 20 });
      const { mapEditVersion, lights } = host.handle({ t: 'snapshot' });
      expect(mapEditVersion, `${name} builds its map`).toBeGreaterThan(0);
      expect(lights.length, `${name} lights its crossings`).toBeGreaterThan(0);
    }
  }, SIZED_IN_TICKS);

  it('snapshotReportsCitizensTrafficAndTickCost', () => {
    const host = new SimHost(4096);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'city' });
    host.handle({ t: 'step', ticks: 300 });

    const { traffic } = host.handle({ t: 'snapshot' });
    expect(traffic.citizens, 'the city has 2000 commuters').toBe(2000);
    expect(traffic.driving + traffic.parked, 'and their cars').toBeGreaterThan(0);
    expect(traffic.tripsStarted!, 'every driving car is a started trip').toBeGreaterThanOrEqual(traffic.driving);
    expect(traffic.simTickMs!, 'the tick cost is measured').toBeGreaterThan(0);
  }, SIZED_IN_TICKS);

  it('theLivingCityReportsItsOwnCitizens', () => {
    const host = new SimHost(4096);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    host.handle({ t: 'step', ticks: 20 });
    const { traffic } = host.handle({ t: 'snapshot' });
    // The city opens built and lived in at six in the morning (stage 3½b): its people are counted from the first frame,
    // and nobody sets out before the first game minute turns.
    expect(traffic.citizens, 'the HUD counts the people who already live there').toBeGreaterThan(2000);
    expect(traffic.tripsStarted, 'and nobody has set out two seconds in').toBe(0);
  }, SIZED_IN_TICKS);

  // Stage 3½: the frame carries the people on foot and the trucks, each under an id of its own.
  it('theLivingCityPublishesItsPedestriansAndTrucks', () => {
    const host = new SimHost(RENDER_CAPACITY);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    const kinds = new Set<number>();
    for (let minute = 0; minute < 30; minute++) {
      host.handle({ t: 'step', ticks: 600 });
      reader.readInto(out);
      for (let i = 0; i < out.count; i++) kinds.add(out.kind[i]!);
      const ids = new Set(Array.from(out.slot.subarray(0, out.count)));
      expect(ids.size, `ids are unique at minute ${minute}`).toBe(out.count);
    }
    expect(kinds.has(PEDESTRIAN_KIND), `pedestrians among ${[...kinds].join(' ')}`).toBe(true);
    expect(kinds.has(TRUCK_KIND) || kinds.has(PARKED_TRUCK_KIND), 'and trucks').toBe(true);
  }, SIZED_IN_TICKS);

  // Stage 3½e gate: the cost of every tick is kept, so p50 and p99 are read off the running game, not a bench.
  it('tickStatsReportTheCostOfEachTick', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    expect(host.handle({ t: 'tickStats' }).count, 'nothing before the first tick').toBe(0);
    host.handle({ t: 'step', ticks: 100 });
    host.handle({ t: 'setSpeed', speed: 'X10' });
    host.update(0);
    const ticks = host.update(500)?.tick ?? 0;
    const stats = host.handle({ t: 'tickStats' });
    expect(stats.count, 'every tick, stepped or run').toBe(ticks);
    expect(stats.p50Ms).toBeGreaterThan(0);
    expect(stats.p99Ms).toBeGreaterThanOrEqual(stats.p50Ms);
    expect(stats.maxMs).toBeGreaterThanOrEqual(stats.p99Ms);
  });

  // Stage 3½e gate: a scenario is built and settled into its first frame in the request, so what the worker's loop did in
  // between cannot change the fingerprint.
  it('aScenarioSettlesInTheRequestThatBuildsIt', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    // No frame of the worker's loop in between: the step request comes straight after.
    const reply = host.handle({ t: 'step', ticks: 30 });

    const w = createWorld();
    requestState(w, 'InGame');
    const scenario = new LivingCityScenario(w);
    frame(w, 0);
    for (let i = 0; i < 30; i++) {
      scenario.advance(w);
      step(w, 1);
    }
    expect(reply).toEqual({ tick: 30, fingerprint: toHex64(fingerprint(w)) });
  }, SIZED_IN_TICKS);

  // Stage 3½e: the metropolis is as large as its map, and opening it keeps the speed the player chose.
  it('theMetropolisOpensOnAMapOfItsOwnSize', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'setSpeed', speed: 'X10' });
    host.handle({ t: 'scenario', name: 'metropolis', size: 160 });
    host.handle({ t: 'step', ticks: 2 });
    const layers = host.handle({ t: 'mapLayers' });
    expect([layers.width, layers.height, layers.layers.roadKind.length], 'the map of the scenario').toEqual([160, 160, 160 * 160]);
    const snapshot = host.handle({ t: 'snapshot' });
    expect(snapshot).toMatchObject({ speed: 'X10', appState: 'InGame' });
    expect(snapshot.traffic.citizens, 'lived in from the start').toBeGreaterThan(1000);
    expect(snapshot.lights.length, 'its arterial crossings lit').toBeGreaterThan(0);
  }, SIZED_IN_TICKS);

  // Stage 3½d: the frame holds what the camera can see, with a margin for a pan, and nothing of it is lost.
  it('publishKeepsOnlyWhatIsInView', () => {
    const host = new SimHost(RENDER_CAPACITY);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    for (let minute = 0; minute < 20; minute++) host.handle({ t: 'step', ticks: 600 });
    const drawn = () => {
      reader.readInto(out);
      return Array.from({ length: out.count }, (_, i) => ({ id: out.slot[i]!, x: out.x[i]!, y: out.y[i]!, kind: out.kind[i]! }));
    };
    const full = drawn();

    const view = { left: -400, right: 100, bottom: -300, top: 200 };
    host.handle({ t: 'setView', view });
    host.handle({ t: 'step', ticks: 0 });
    const inView = drawn();
    const [marginX, marginY] = [(view.right - view.left) / 4, (view.top - view.bottom) / 4];
    const within = (p: { x: number; y: number }, mx: number, my: number) =>
      p.x >= view.left - mx && p.x <= view.right + mx && p.y >= view.bottom - my && p.y <= view.top + my;
    expect(new Set(full.map((p) => p.kind)).size, `the city shows cars, parked cars and people: ${full.length}`).toBeGreaterThanOrEqual(3);
    expect(inView.length, 'less than the whole city').toBeLessThan(full.length);
    expect(inView.filter((p) => !within(p, marginX, marginY)), 'nothing beyond the margin').toEqual([]);
    const ids = new Set(inView.map((p) => p.id));
    expect(full.filter((p) => within(p, 0, 0) && !ids.has(p.id)), 'and everything in view').toEqual([]);

    host.handle({ t: 'setView', view: null });
    host.handle({ t: 'step', ticks: 0 });
    expect(drawn().length, 'without a view, the whole city again').toBe(full.length);
  }, SIZED_IN_TICKS);

  // Stage 3½d: at ×60 and above the roads show their load and a sample of the cars drives on them.
  it('fastSpeedsPublishASampleAndTheLinkLoads', () => {
    const host = new SimHost(RENDER_CAPACITY);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    for (let minute = 0; minute < 20; minute++) host.handle({ t: 'step', ticks: 600 });
    const w = (host as unknown as { world: World }).world;

    host.handle({ t: 'setSpeed', speed: 'X60' });
    host.handle({ t: 'step', ticks: 0 });
    reader.readInto(out);
    const kinds = Array.from(out.kind.subarray(0, out.count));
    expect(kinds.filter((kind) => kind === 0 || kind === TRUCK_KIND).length, 'cars drive').toBeGreaterThan(0);
    expect(kinds.length, 'a sample of them').toBeLessThanOrEqual(SAMPLE_CARS);
    expect(kinds.filter((kind) => kind === PARKED_VEHICLE_KIND || kind === PARKED_TRUCK_KIND || kind === PEDESTRIAN_KIND), 'and nothing that stands or walks').toEqual([]);
    expect([out.links, out.linksFor], 'the load of every link').toEqual([w.meso.linkCount, w.meso.builtFor]);
    const loads = Array.from({ length: w.meso.linkCount }, (_, link) => Math.round(255 * Math.min(w.mesoTraffic.usedMeters[link]! / linkRoomMeters(w, link), 1)));
    expect(loads.some((load) => load > 0), 'some links carry cars').toBe(true);
    expect(Array.from(out.load.subarray(0, out.links))).toEqual(loads);

    host.handle({ t: 'setSpeed', speed: 'X1' });
    host.handle({ t: 'step', ticks: 0 });
    reader.readInto(out);
    expect(out.links, 'at ×1 the cars themselves').toBe(0);
  }, SIZED_IN_TICKS);

  it('aScenarioSeesEveryTickOfAFastFrame', () => {
    // At ×3 a frame runs several ticks; a scenario fed once a frame missed the arrivals of all but the
    // last, and those commuters stayed "on the road" for good.
    const host = new SimHost(4096);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'city' });
    host.handle({ t: 'setSpeed', speed: 'X10' });
    // The host times its ticks on `performance.now`, and the driver cuts a frame to what that cost affords: on a busy
    // machine 670 of these ticks ran instead of 1 490. A stopped clock makes every tick free, so the frames carry exactly
    // what their game time owes; the budget itself is the driver's to test.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      // Fifteen seconds at ×10: ten ticks in each of the 149 frames after the first.
      for (let frame = 0; frame < 150; frame++) host.update(frame * 100);
    } finally {
      clock.mockRestore();
    }

    const { tick, traffic } = host.handle({ t: 'snapshot' });
    expect(tick, 'ten ticks a frame').toBe(149 * 10);
    expect(traffic.tripsDone!, 'commutes finish').toBeGreaterThan(0);
    expect(traffic.travelling, 'everyone on the road is driving or waiting to leave').toBe(traffic.driving + traffic.backlog);
  }, SIZED_IN_TICKS);

  // TS (stage 3½): the worker must not die. A frame that throws is logged in the snapshot and the next frames run.
  it('hostSurvivesAFrameError', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    const internals = host as unknown as { driver: { update: (nowMs: number, beforeTick?: unknown) => number } };
    const update = internals.driver.update.bind(internals.driver);
    internals.driver.update = () => {
      throw new Error('boom');
    };
    expect(() => host.update(0)).not.toThrow();
    expect(host.handle({ t: 'snapshot' }).errors).toEqual([expect.objectContaining({ system: 'frame', message: 'boom', count: 1 })]);

    internals.driver.update = update;
    host.update(100);
    host.update(200);
    expect(host.handle({ t: 'snapshot' }).tick, 'the next frames run').toBeGreaterThan(0);
  });

  it('aFailingSystemShowsInTheSnapshotAndTheWorldGoesOn', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'debugFailSystem', system: 'updateTrafficIndex' });
    host.handle({ t: 'step', ticks: 3 });
    const { tick, errors } = host.handle({ t: 'snapshot' });
    expect(tick).toBe(3);
    expect(errors).toEqual([expect.objectContaining({ system: 'updateTrafficIndex', count: 3 })]);
  });

  it('debugVehiclesArePublished', () => {
    const host = new SimHost(16);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();
    host.handle({
      t: 'debugVehicles',
      vehicles: [
        { x: 10, y: -20, heading: 1.5, kind: 2 },
        { x: -4, y: 8, heading: 0, kind: 0 },
      ],
    });
    reader.readInto(out);
    expect(out.count).toBe(2);
    expect([out.x[0], out.y[0], out.x[1], out.y[1], out.kind[0]]).toEqual([10, -20, -4, 8, 2]);

    host.handle({ t: 'debugVehicles', vehicles: [] });
    reader.readInto(out);
    expect(out.count, 'a new list replaces the old one').toBe(0);
  });
});

function testCityLayers() {
  const grid = loadTestCity().grid;
  return Object.fromEntries(GRID_LAYER_NAMES.map((name) => [name, grid[name].slice()])) as GridLayers;
}
