// Stage 2b gate: traffic through a signalized intersection moves exactly as in the composed Rust game
// — a per-tick digest of every vehicle's cursor, progress and speed and of the light's phase and
// timer over 1500 fixed ticks (fixture from examples/dump_signalized.rs).
import { describe, expect, it } from 'vitest';
import type { RoadDir, TilePos } from '../../src/commands';
import { frame, step } from '../../src/app';
import { tileKey } from '../../src/map/grid';
import { LIGHT_PHASES } from '../../src/traffic/lights';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { requestState } from '../../src/state';
import { resolveVehicle, refSlot, spawnVehicle } from '../../src/traffic/vehicles';
import { findRoute, type Route } from '../../src/transport/lanelet/pathfinding';
import { createWorld, type World } from '../../src/world';
import fixture from '../fixtures/signalized.json';
import { setRoad } from '../transport/helpers';

const TICKS = 1500;
const FACTORS = [0.8, 1.0, 1.2, 0.9].map(Math.fround);

const bits = new Uint32Array(1);
const floats = new Float32Array(bits.buffer);
const f32Bits = (x: number) => {
  floats[0] = x;
  return bits[0]!;
};

function fnv(h: number, x: number): number {
  for (let i = 0; i < 4; i++) {
    h ^= (x >>> (8 * i)) & 0xff;
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

function buildCross(w: World, lo: number, hi: number): void {
  const road = (x: number, y: number, dir: RoadDir, lane: number) => setRoad(w.grid, { x, y }, { dir, lane });
  for (let i = lo; i <= hi; i++) {
    if (i === 40 || i === 41) continue;
    road(i, 40, 'East', 0);
    road(i, 41, 'West', 1);
    road(40, i, 'North', 0);
    road(41, i, 'South', 1);
  }
  for (const [x, y] of [
    [40, 40],
    [41, 40],
    [40, 41],
    [41, 41],
  ] as const) {
    road(x, y, 'None', 0);
  }
}

function stateDump(w: World, refs: readonly number[]): string {
  const v = w.vehicles;
  const lines = refs.map((ref, i) => {
    const slot = resolveVehicle(v, ref);
    if (slot === undefined) return `vehicle ${i}: despawned`;
    return `vehicle ${i}: cursor ${v.pathCursor[slot]} progress ${v.progress[slot]} speed ${v.speed[slot]} state ${JSON.stringify(v.trafficState[slot])}`;
  });
  const light = w.trafficLights[0]!;
  return [...lines, `light: phase ${LIGHT_PHASES.indexOf(light.phase)} timer ${light.phaseTimer}`].join('\n');
}

describe('signalized intersection parity with Rust', () => {
  it('signalizedTrafficMatchesRust', () => {
    const { lo, hi, spawnEvery } = fixture;
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 0);

    buildCross(w, lo, hi);
    w.graphVersion += 1;
    w.mapEditVersion += 1;
    frame(w, 0);
    w.commands.push({ kind: 'PlaceTrafficLight', pos: { x: 40, y: 40 } });
    frame(w, 0);
    step(w, 1);

    const light = w.trafficLights[0]!;
    expect(
      { phase: LIGHT_PHASES.indexOf(light.phase), timerBits: f32Bits(light.phaseTimer).toString(16).padStart(8, '0') },
      'the light starts at the same point of its cycle',
    ).toEqual(fixture.initialLight);

    const ends: ReadonlyArray<readonly [TilePos, TilePos, number]> = [
      [{ x: lo, y: 40 }, { x: hi, y: 40 }, 1],
      [{ x: hi, y: 41 }, { x: lo, y: 41 }, 0],
      [{ x: 40, y: lo }, { x: 40, y: hi }, 3],
      [{ x: 41, y: hi }, { x: 41, y: lo }, 2],
    ];
    const ctx = { grid: w.grid, traffic: new TrafficOccupancy(), cfg: w.pathfindingConfig, jitterSeed: 0n };
    const laneAt = (tile: TilePos) => w.laneGraph.posToId.get(tileKey(tile))!;
    const routes: Route[][] = ends.map(([entry, , opposite]) =>
      [0, 1, 2, 3]
        .filter((g) => g !== opposite)
        .map((g) => {
          const route = findRoute(w.laneGraph, w.laneletGraph, ctx, laneAt(entry), laneAt(ends[g]![1]));
          expect(route.tiles.length, 'every approach reaches every exit').toBeGreaterThan(0);
          return route;
        }),
    );
    const laneletVersion = w.laneletGraph.version;

    const refs: number[] = [];
    let maxAlive = 0;
    let leftProtectedTicks = 0;
    const v = w.vehicles;
    for (let k = 0; k < TICKS; k++) {
      if (k % spawnEvery === 0) {
        const wave = k / spawnEvery;
        routes.forEach((set, s) => {
          const route = set[(wave + s) % 3]!;
          const ref = spawnVehicle(w, { route: route.tiles, speedFactor: FACTORS[(wave + s) % 4]! });
          v.laneletPlan[refSlot(v, ref)] = {
            entries: route.sidecar.map((e) => [e[0], e[1], e[2]] as const),
            builtFor: laneletVersion,
          };
          refs.push(ref);
        });
      }
      step(w, 1);

      let h = 2_166_136_261;
      let alive = 0;
      for (const ref of refs) {
        const slot = resolveVehicle(v, ref);
        if (slot === undefined) {
          h = fnv(h, 0xffff_ffff);
          continue;
        }
        alive += 1;
        h = fnv(h, v.pathCursor[slot]!);
        h = fnv(h, f32Bits(v.progress[slot]!));
        h = fnv(h, f32Bits(v.speed[slot]!));
      }
      const phase = LIGHT_PHASES.indexOf(w.trafficLights[0]!.phase);
      h = fnv(h, phase);
      h = fnv(h, f32Bits(w.trafficLights[0]!.phaseTimer));
      if (phase === 0 || phase === 4) leftProtectedTicks += 1;
      maxAlive = Math.max(maxAlive, alive);

      const digest = h.toString(16).padStart(8, '0');
      if (digest !== fixture.digests[k]) {
        expect.fail(`first divergence after tick ${k + 1} (SIGNALIZED_DUMP_TICK=${k + 1} dumps Rust):\n${stateDump(w, refs)}`);
      }
    }

    const despawned = refs.filter((ref) => resolveVehicle(v, ref) === undefined).length;
    expect({ spawned: refs.length, despawned, maxAlive, leftProtectedTicks }).toEqual({
      spawned: fixture.spawned,
      despawned: fixture.despawned,
      maxAlive: fixture.maxAlive,
      leftProtectedTicks: fixture.leftProtectedTicks,
    });
    expect(despawned, 'the run must exercise arrivals').toBeGreaterThan(0);
    expect(leftProtectedTicks, 'left-turn demand must actuate the protected left').toBeGreaterThan(0);
  });
});
