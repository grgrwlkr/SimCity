import {
  ROAD_DIRS,
  ROAD_KINDS,
  LivingCityScenario,
  createWorld,
  fingerprint,
  frame,
  linkRoomMeters,
  requestState,
  rngProbeDigest,
  step,
  toHex64,
  type World,
} from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { loadTestCity } from '../../sim/test/testCity';
import { RENDER_CAPACITY, SimHost } from '../src/host';
import { GRID_LAYER_NAMES, type GridLayers } from '../src/protocol';
import { PARKED_TRUCK_KIND, PARKED_VEHICLE_KIND, PEDESTRIAN_KIND, RenderReader, TRUCK_KIND } from '../src/renderBuffer';
import { SAMPLE_CARS } from '../src/sample';
import { SCENARIOS } from '../src/scenarios';

describe('SimHost', () => {
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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 120_000);

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
  }, 60_000);

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
  }, 120_000);

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
  }, 120_000);

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
  }, 120_000);

  it('aScenarioSeesEveryTickOfAFastFrame', () => {
    // At ×3 a frame runs several ticks; a scenario fed once a frame missed the arrivals of all but the
    // last, and those commuters stayed "on the road" for good.
    const host = new SimHost(4096);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'city' });
    host.handle({ t: 'setSpeed', speed: 'X10' });
    // Fifteen seconds at ×10: up to fifteen hundred ticks. How many the tick budget lets through depends on how busy the
    // machine is (983 under a parallel suite), so the check is only that frames run several ticks.
    for (let frame = 0; frame < 150; frame++) host.update(frame * 100);

    const { tick, traffic } = host.handle({ t: 'snapshot' });
    expect(tick, 'several ticks a frame').toBeGreaterThan(2 * 150);
    expect(traffic.tripsDone!, 'commutes finish').toBeGreaterThan(0);
    expect(traffic.travelling, 'everyone on the road is driving or waiting to leave').toBe(traffic.driving + traffic.backlog);
  }, 120_000);

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
