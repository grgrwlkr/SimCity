// Stage 2a gate: a platoon on a two-lane corridor without intersections moves exactly as in the
// composed Rust game — cursor, progress and speed of every vehicle after each of 400 fixed ticks
// (fixture from examples/dump_platoon.rs).
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { requestState } from '../../src/state';
import { resolveVehicle, spawnVehicle } from '../../src/traffic/vehicles';
import { createWorld } from '../../src/world';
import fixture from '../fixtures/platoon.json';
import { setRoad } from '../transport/helpers';

type Cell = readonly [number, string, string] | null;

const bits = new Uint32Array(1);
const floats = new Float32Array(bits.buffer);
const f32Hex = (x: number) => {
  floats[0] = x;
  return bits[0]!.toString(16).padStart(8, '0');
};
const hexF32 = (hex: string) => {
  bits[0] = Number.parseInt(hex, 16);
  return floats[0]!;
};

describe('platoon parity with Rust', () => {
  it('platoonMatchesRust', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 0);

    const { x0, x1, eastY, westY } = fixture.corridor;
    for (let x = x0; x <= x1; x++) {
      setRoad(w.grid, { x, y: eastY }, { dir: 'East', lane: 0 });
      setRoad(w.grid, { x, y: westY }, { dir: 'West', lane: 1 });
    }
    w.graphVersion += 1;
    w.mapEditVersion += 1;
    step(w, 1);

    const east = Array.from({ length: x1 - x0 + 1 }, (_, i) => ({ x: x0 + i, y: eastY }));
    const west = Array.from({ length: x1 - x0 + 1 }, (_, i) => ({ x: x1 - i, y: westY }));
    const refs = fixture.vehicles.map((s) =>
      spawnVehicle(w, {
        route: s.eastbound ? east : west,
        cursor: s.cursor,
        progress: Math.fround(s.progress),
        speed: Math.fround(s.speed),
        maxSpeed: Math.fround(s.maxSpeed),
        speedFactor: Math.fround(s.speedFactor),
      }),
    );

    const v = w.vehicles;
    (fixture.ticks as Cell[][]).forEach((row, tick) => {
      step(w, 1);
      const actual: Cell[] = refs.map((ref) => {
        const slot = resolveVehicle(v, ref);
        return slot === undefined ? null : [v.pathCursor[slot]!, f32Hex(v.progress[slot]!), f32Hex(v.speed[slot]!)];
      });
      row.forEach((want, i) => {
        const got = actual[i]!;
        const readable = (c: Cell) => (c === null ? 'despawned' : `cursor ${c[0]} progress ${hexF32(c[1])} speed ${hexF32(c[2])}`);
        expect(got, `tick ${tick + 1}, vehicle ${i}: want ${readable(want)}, got ${readable(got)}`).toEqual(want);
      });
    });
    const last = (fixture.ticks as Cell[][]).at(-1)!;
    expect(last.some((c) => c !== null), 'the fixture must keep some vehicles driving').toBe(true);
    expect(last.some((c) => c === null), 'the fixture must exercise arrivals').toBe(true);
  });
});
