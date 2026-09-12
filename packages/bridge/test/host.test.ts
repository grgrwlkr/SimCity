import {
  ROAD_DIRS,
  ROAD_KINDS,
  createWorld,
  fingerprint,
  requestState,
  rngProbeDigest,
  step,
  toHex64,
} from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { loadTestCity } from '../../sim/test/testCity';
import { SimHost } from '../src/host';
import { GRID_LAYER_NAMES, type GridLayers } from '../src/protocol';
import { RenderReader } from '../src/renderBuffer';
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
      host.handle({ t: 'scenario', name });
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
    expect([traffic.citizens, traffic.tripsStarted], 'nobody lives there yet, and the HUD says so rather than nothing').toEqual([0, 0]);
  }, 60_000);

  it('aScenarioSeesEveryTickOfAFastFrame', () => {
    // At ×3 a frame runs several ticks; a scenario fed once a frame missed the arrivals of all but the
    // last, and those commuters stayed "on the road" for good.
    const host = new SimHost(4096);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'city' });
    host.handle({ t: 'setSpeed', speed: 'X10' });
    // Fifteen seconds at ×10: fifteen hundred ticks, over a thousand even when the tick budget caps them.
    for (let frame = 0; frame < 150; frame++) host.update(frame * 100);

    const { tick, traffic } = host.handle({ t: 'snapshot' });
    expect(tick, 'several ticks a frame').toBeGreaterThan(1000);
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
