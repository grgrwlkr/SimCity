// Port of the `props_placement` tests of crates/simcity_sim/src/game/map/tests.rs (tag rust-final), plus a check that
// the constants of `props.ts` still say what assets/config/props.ron says. Placement is a pure function of the grid
// and the map seed: a roll that drifted between runs would be a save-load difference nobody sees until the city
// reloads wrong.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIGN_NIGHT_EMISSIVE } from '../src/renderConfig';
import {
  PARKED_CAR_TINTS,
  PROPS_CONFIG,
  PROP_SALT,
  kerbSide,
  kerbsideSide,
  parkedCarTint,
  propRoll,
  roadSide,
  wantsStreetlight,
  type PropGrid,
  type StreetlightConfig,
} from '../src/props';

/** A straight two-lane road along `y = 2` of a `len + 4` by 5 map, as `road_row` of the Rust tests. */
function roadRow(len: number): PropGrid {
  const width = len + 4;
  const height = 5;
  const layers = { water: new Uint8Array(width * height), roadKind: new Uint8Array(width * height) };
  // `RoadKind::TwoLane` is index 1 of `ROAD_KINDS`; 0 is `None`, the same encoding `tileClass` reads.
  for (let x = 0; x < len; x++) layers.roadKind[2 * width + x] = 1;
  return { width, height, layers };
}

type Scalar = number | boolean | string;

/** The RON subset of the config files, as renderConfig.test.ts reads them: nested unnamed structs of `name: value`. */
function readRon(file: string): Map<string, Scalar> {
  const text = readFileSync(join(import.meta.dirname, '../../../assets/config', file), 'utf8').replace(/\/\/.*$/gm, '');
  const tokens = text.match(/[():,]|[A-Za-z_]\w*|-?\d+(?:\.\d+)?/g) ?? [];
  let at = 0;
  const out = new Map<string, Scalar>();
  const next = () => tokens[at++] ?? '';
  const struct = (prefix: string) => {
    expect(next()).toBe('(');
    while (tokens[at] !== ')') {
      const name = next();
      expect(next(), `':' after ${prefix}${name}`).toBe(':');
      if (tokens[at] === '(') struct(`${prefix}${name}.`);
      else {
        const raw = next();
        out.set(`${prefix}${name}`, raw === 'true' ? true : raw === 'false' ? false : /^-?\d/.test(raw) ? Number(raw) : raw);
      }
      if (tokens[at] === ',') at++;
    }
    next();
  };
  struct('');
  return out;
}

/** The config as `snake_case.path → value`, the names the .ron file uses. */
function flatten(value: object, prefix = '', out = new Map<string, Scalar>()): Map<string, Scalar> {
  for (const [key, v] of Object.entries(value)) {
    const name = prefix + key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (typeof v === 'object' && v !== null) flatten(v as object, `${name}.`, out);
    else out.set(name, v as Scalar);
  }
  return out;
}

describe('props config', () => {
  it('propsConfigIsPropsRon', () => {
    expect(flatten(PROPS_CONFIG)).toEqual(readRon('props.ron'));
  });

  it('signNightEmissiveAgreesWithRenderConfig', () => {
    // renderConfig.ts carries the same knob for the night materials; one file drifting from the other is a bug.
    expect(PROPS_CONFIG.sign.nightEmissive).toBe(SIGN_NIGHT_EMISSIVE);
  });
});

describe('props placement', () => {
  it('aLampStandsOnTheKerbAndNeverMidCarriageway', () => {
    const grid = roadRow(12);
    // The road runs along y = 2, so every road tile has a non-road neighbour above and below: that is a kerb.
    expect(kerbSide(grid, 4, 2)).not.toBeNull();
    // A tile off the road is not a lamp site at all.
    expect(kerbSide(grid, 4, 0)).toBeNull();
  });

  it('lampsKeepTheConfiguredSpacing', () => {
    const grid = roadRow(16);
    const cfg: StreetlightConfig = { ...PROPS_CONFIG.streetlight, spacingTiles: 4 };
    const lit: number[] = [];
    for (let x = 0; x < 16; x++) if (wantsStreetlight(grid, x, 2, cfg)) lit.push(x);
    expect(lit.length, `a 16-tile street should carry lamps: ${lit}`).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < lit.length; i++) {
      expect(lit[i]! - lit[i - 1]!, `lamps must sit exactly spacingTiles apart: ${lit}`).toBe(4);
    }
  });

  it('switchingLampsOffInTheConfigLeavesTheStreetBare', () => {
    const grid = roadRow(16);
    const cfg: StreetlightConfig = { ...PROPS_CONFIG.streetlight, enabled: false };
    for (let x = 0; x < 16; x++) {
      expect(wantsStreetlight(grid, x, 2, cfg), 'a disabled knob must actually disable').toBe(false);
    }
  });

  // Shop furniture needs a shop, and "is there a building here" cannot be read off the grid: `MapCell::building` is
  // written for service buildings and hand-placed ones only, while R/C/I grown by the simulation leaves it `None`.
  // Trusting it found 15 tiles in a whole city and put signs nowhere.
  it('shopFurnitureNeedsAShopAndTakesThatFromTheCaller', () => {
    const grid = roadRow(8);
    // The tile faces the road either way — that part is geometry.
    expect(roadSide(grid, 3, 3)).toEqual({ x: 0, y: -1 });
    // Whether a shop stands on it is the caller's to say.
    expect(kerbsideSide(grid, 3, 3, false), 'no shop, no sign').toBeNull();
    expect(kerbsideSide(grid, 3, 3, true), 'with a shop, the furniture faces the road').toEqual({ x: 0, y: -1 });
  });

  // Parked cars come from a fixed palette, not from a free hash: the first version keyed the car mesh on a continuous
  // tint and blew the distinct-mesh count from 44 to 139.
  it('parkedCarsDrawFromASmallFixedPalette', () => {
    expect(PARKED_CAR_TINTS.length, 'a bigger palette is a bigger batch count').toBeLessThanOrEqual(4);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const tint = parkedCarTint(i % 20, Math.floor(i / 20), 42n);
      expect(PARKED_CAR_TINTS, `${tint} is not in the palette`).toContainEqual(tint);
      seen.add(tint.join(','));
    }
    expect(seen.size, 'one colour for every car is not a palette').toBeGreaterThan(1);
  });

  it('aRollIsStableForATileAndSpreadAcrossTheMap', () => {
    const first = propRoll(7, 9, 42n, PROP_SALT.parkedCar, 50);
    expect(propRoll(7, 9, 42n, PROP_SALT.parkedCar, 50), 'same tile, same answer').toBe(first);
    let hits = 0;
    for (let i = 0; i < 400; i++) if (propRoll(i % 20, Math.floor(i / 20), 42n, PROP_SALT.parkedCar, 25)) hits++;
    expect(hits, `25% of 400 tiles should be roughly 100, got ${hits}`).toBeGreaterThanOrEqual(60);
    expect(hits).toBeLessThanOrEqual(140);
    for (let i = 0; i < 400; i++) {
      expect(propRoll(i % 20, Math.floor(i / 20), 42n, PROP_SALT.parkedCar, 0), 'a zero chance must place nothing').toBe(false);
    }
  });
});
