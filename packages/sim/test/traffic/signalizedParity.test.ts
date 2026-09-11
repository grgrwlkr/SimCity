// Stage 2b gate: traffic through a signalized intersection moves exactly as in the composed Rust game
// — a per-tick digest of every vehicle's cursor, progress and speed and of the light's phase and
// timer over 1500 fixed ticks (fixture from examples/dump_signalized.rs). The cross, its routes and
// its waves come from the scenario module the live view uses, so the gate covers that code too.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { LIGHT_PHASES } from '../../src/traffic/lights';
import { buildSignalizedCross, signalizedCrossRoutes, spawnSignalizedWave } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { resolveVehicle } from '../../src/traffic/vehicles';
import { createWorld, type World } from '../../src/world';
import fixture from '../fixtures/signalized.json';

const TICKS = 1500;

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

    // The Rust example's frame sequence: detect, then place the light, then one tick builds the graphs.
    buildSignalizedCross(w.grid, lo, hi);
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

    const routes = signalizedCrossRoutes(w, lo, hi);
    for (const set of routes) {
      for (const route of set) expect(route.tiles.length, 'every approach reaches every exit').toBeGreaterThan(0);
    }

    const refs: number[] = [];
    let maxAlive = 0;
    let leftProtectedTicks = 0;
    const v = w.vehicles;
    for (let k = 0; k < TICKS; k++) {
      if (k % spawnEvery === 0) refs.push(...spawnSignalizedWave(w, routes, k / spawnEvery));
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
