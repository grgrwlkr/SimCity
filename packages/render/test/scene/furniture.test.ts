// Where the scene stands street furniture: the pure placement of props.ts turned into poses, one list per shared mesh.
import { describe, expect, it } from 'vitest';
import type { MapLayersReply } from '@simcity/bridge';
import { tileToWorld } from '@simcity/sim';
import { PARKED_CAR_TINTS, PROPS_CONFIG, kerbSide, wantsStreetlight } from '../../src/props';
import { placeFurniture } from '../../src/scene/furniture';

const W = 24;
const H = 12;
const TILE = 16;
/** A two-lane road along row 5, a row of buildings on its north side, empty zoned land to the south. */
function street(): MapLayersReply {
  const layer = () => new Uint8Array(W * H);
  const layers = { water: layer(), roadKind: layer(), roadDir: layer(), zone: layer(), building: layer() };
  for (let x = 0; x < W; x++) {
    layers.roadKind[5 * W + x] = 1;
    layers.roadDir[5 * W + x] = 1;
    layers.building[6 * W + x] = 2;
    layers.zone[4 * W + x] = 2;
  }
  return { width: W, height: H, tileSize: TILE, mapEditVersion: 1, graphVersion: 1, layers };
}

describe('street furniture in the scene', () => {
  const map = street();
  const cfg = { width: W, height: H, tileSize: TILE };
  const f = placeFurniture(map, 0n);
  const tileOf = (x: number, y: number) => ({ x: Math.round((x - tileToWorld(cfg, { x: 0, y: 0 }).x) / TILE), y: Math.round((y - tileToWorld(cfg, { x: 0, y: 0 }).y) / TILE) });

  it('stands a lamp on every lamp tile of the kerb, with a wire to the next one', () => {
    let expected = 0;
    for (let x = 0; x < W; x++) if (wantsStreetlight(map, x, 5, PROPS_CONFIG.streetlight)) expected += 1;
    expect(expected).toBeGreaterThan(0);
    expect(f.lamps).toHaveLength(expected);
    expect(f.wires.length).toBe(expected - 1);
    for (const wire of f.wires) expect(wire.scaleX).toBeCloseTo(PROPS_CONFIG.streetlight.spacingTiles * TILE, 3);
  });

  it('parks cars on the kerb, never on a lamp tile, in the four tints only', () => {
    expect(f.parkedCars).toHaveLength(PARKED_CAR_TINTS.length);
    const all = f.parkedCars.flat();
    expect(all.length).toBeGreaterThan(0);
    for (const car of all) {
      const t = tileOf(car.x - (kerbSide(map, 0, 5)!.x * (PROPS_CONFIG.streetlight.kerbOffset - 1.5)), car.y - kerbSide(map, 0, 5)!.y * (PROPS_CONFIG.streetlight.kerbOffset - 1.5));
      expect(t.y).toBe(5);
      expect(wantsStreetlight(map, t.x, t.y, PROPS_CONFIG.streetlight)).toBe(false);
    }
  });

  it('gives bins, signs and awnings only to built tiles facing the road', () => {
    const kerbside = [...f.bins, ...f.awnings, ...f.signs];
    expect(f.bins.length * f.signs.length * f.awnings.length).toBeGreaterThan(0);
    const edgeY = tileToWorld(cfg, { x: 0, y: 6 }).y - TILE / 2 - 0.6;
    // Every one hangs past the south edge of the built row, towards the road: none on the empty zoned row.
    for (const p of kerbside) expect(p.y).toBeCloseTo(edgeY, 3);
  });

  it('is the same for the same seed and moves with another', () => {
    expect(placeFurniture(map, 0n)).toEqual(f);
    expect(placeFurniture(map, 12345n).bins).not.toEqual(f.bins);
  });
});
