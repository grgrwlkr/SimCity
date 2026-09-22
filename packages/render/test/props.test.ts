// Port of the `props_placement` tests of crates/simcity_sim/src/game/map/tests.rs (tag rust-final), plus a pin of the
// constants of `props.ts` at the values the game shipped with (rust-final:assets/config/props.ron). Placement is a pure
// function of the grid and the map seed: a roll that drifted between runs would be a save-load difference nobody sees
// until the city reloads wrong.
import type { MapLayersReply } from '@simcity/bridge';
import { describe, expect, it } from 'vitest';
import { SIGN_NIGHT_EMISSIVE } from '../src/renderConfig';
import {
  PARKED_CAR_TINTS,
  PROPS_CONFIG,
  PROP_SALT,
  kerbSide,
  kerbsideSide,
  parkedCarTint,
  propGrid,
  propRoll,
  roadSide,
  wantsShowing,
  wantsStreetlight,
  wirePartner,
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

describe('props config', () => {
  it('propsConfigPinsTheShippedFurniture', () => {
    expect(PROPS_CONFIG).toEqual({
      streetlight: { enabled: true, spacingTiles: 4, poleHeight: 9, armLength: 2.5, kerbOffset: 6, wires: true, wireSag: 1.4 },
      sign: { enabled: true, chancePercent: 45, width: 5, height: 1.8, mountHeight: 7, nightEmissive: 2.8 },
      bin: { enabled: true, chancePercent: 30 },
      awning: { enabled: true, chancePercent: 40 },
      parkedCar: { enabled: true, chancePercent: 28 },
    });
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

// Not in the Rust test module: `wire_partner`, `PropRole::wants_showing` and the grid the renderer feeds them were
// pinned by eye there. The wire's side comparison is the subtlest line of props.rs, so it gets a test of its own.
describe('props wiring and visibility', () => {
  /** Three road rows, `y = 1..3`: the middle one has road on every side, so it carries no kerb at all. */
  function roadBand(len: number): PropGrid {
    const width = len + 4;
    const height = 5;
    const layers = { water: new Uint8Array(width * height), roadKind: new Uint8Array(width * height) };
    for (let y = 1; y <= 3; y++) for (let x = 0; x < len; x++) layers.roadKind[y * width + x] = 1;
    return { width, height, layers };
  }

  const cfg: StreetlightConfig = PROPS_CONFIG.streetlight;

  it('aWireReachesTheNextLampAlongTheRun', () => {
    const grid = roadRow(16);
    // Lamps of a `y = 2` run sit where `(x + y) % 4 == 0`: x = 2, 6, 10, 14.
    expect(wantsStreetlight(grid, 2, 2, cfg) && wantsStreetlight(grid, 6, 2, cfg)).toBe(true);
    expect(wirePartner(grid, 2, 2, cfg)).toEqual({ x: 6, y: 2 });
    // The last lamp of the run has nothing to string towards: the road ends at x = 15 and the map at y = 4.
    expect(wirePartner(grid, 14, 2, cfg)).toBeNull();
  });

  it('aWireRunsDownAVerticalStreetToo', () => {
    // A two-lane road down `x = 2` of a 5 by `len + 4` map: the same road as `roadRow`, turned.
    const len = 16;
    const width = 5;
    const height = len + 4;
    const layers = { water: new Uint8Array(width * height), roadKind: new Uint8Array(width * height) };
    for (let y = 0; y < len; y++) layers.roadKind[y * width + 2] = 1;
    const grid: PropGrid = { width, height, layers };
    // Lamps sit at y = 2, 6, 10, 14; the step along x lands off the map, so only the step along y can find the wire.
    expect(kerbSide(grid, 2, 2)).toEqual({ x: 1, y: 0 });
    expect(wirePartner(grid, 2, 2, cfg)).toEqual({ x: 2, y: 6 });
    expect(wirePartner(grid, 2, 10, cfg)).toEqual({ x: 2, y: 14 });
    // The last lamp: the road ends at y = 15.
    expect(wirePartner(grid, 2, 14, cfg)).toBeNull();
  });

  it('switchingWiresOffLeavesTheLampsUnstrung', () => {
    const grid = roadRow(16);
    expect(wirePartner(grid, 2, 2, { ...cfg, wires: false })).toBeNull();
    expect(wirePartner(grid, 2, 2, { ...cfg, spacingTiles: 0 })).toBeNull();
  });

  it('aWireNeedsBothEndsOnTheSameKerb', () => {
    const grid = roadRow(16);
    // A spur at (6, 3) turns the lamp at (6, 2) around: its kerb is now below, while (2, 2) still faces up.
    grid.layers.roadKind[3 * grid.width + 6] = 1;
    expect(kerbSide(grid, 2, 2)).toEqual({ x: 0, y: 1 });
    expect(kerbSide(grid, 6, 2)).toEqual({ x: 0, y: -1 });
    expect(wantsStreetlight(grid, 6, 2, cfg), 'the far tile is still a lamp site').toBe(true);
    expect(wirePartner(grid, 2, 2, cfg), 'two kerbs facing apart are not one run').toBeNull();
    // Both ends mid-carriageway: the Rust `kerb_side(next) == kerb_side(pos)` would hold as `None == None`, but
    // `wants_streetlight` has already refused a tile without a kerb, so no wire is strung either way (props.rs:72).
    const band = roadBand(16);
    expect(kerbSide(band, 2, 2)).toBeNull();
    expect(kerbSide(band, 6, 2)).toBeNull();
    expect(wantsStreetlight(band, 6, 2, cfg)).toBe(false);
    expect(wirePartner(band, 2, 2, cfg)).toBeNull();
  });

  it('wantsShowingAsksWhatTheRoleNeeds', () => {
    const grid = roadRow(16);
    // A lamp lives on its spacing, a parked car on any kerb tile, shop furniture on a built lot facing the road.
    expect(wantsShowing('Streetlight', grid, 2, 2, false, cfg)).toBe(true);
    expect(wantsShowing('Streetlight', grid, 3, 2, false, cfg)).toBe(false);
    expect(wantsShowing('ParkedCar', grid, 3, 2, false, cfg)).toBe(true);
    expect(wantsShowing('ParkedCar', grid, 3, 0, false, cfg)).toBe(false);
    expect(wantsShowing('Kerbside', grid, 3, 3, true, cfg)).toBe(true);
    expect(wantsShowing('Kerbside', grid, 3, 3, false, cfg), 'no shop, nothing to show').toBe(false);
    expect(wantsShowing('Kerbside', grid, 3, 4, true, cfg), 'a lot that faces no road carries nothing').toBe(false);
  });

  it('propGridReadsTheRoadAndWaterLayersOfAMapReply', () => {
    const width = 6;
    const height = 3;
    const cells = width * height;
    const water = new Uint8Array(cells);
    const roadKind = new Uint8Array(cells);
    for (let x = 0; x < width; x++) roadKind[width + x] = 1;
    water[width + 4] = 1;
    const map: MapLayersReply = {
      width,
      height,
      tileSize: 8,
      mapEditVersion: 1,
      graphVersion: 1,
      layers: { water, roadKind, roadDir: new Uint8Array(cells), zone: new Uint8Array(cells), building: new Uint8Array(cells) },
    };
    const grid = propGrid(map);
    expect({ width: grid.width, height: grid.height }).toEqual({ width, height });
    // The arrays are read, not copied: a map edit that rewrites them in place needs no second pass here.
    expect(grid.layers.roadKind).toBe(roadKind);
    expect(grid.layers.water).toBe(water);
    expect(kerbSide(grid, 2, 1), 'a road tile of the reply is a kerb').toEqual({ x: 0, y: 1 });
    expect(kerbSide(grid, 4, 1), 'a flooded tile carries no furniture').toBeNull();
    // The lot at (2, 0) sits below the road of `y = 1`, so its furniture faces up.
    expect(roadSide(grid, 2, 0)).toEqual({ x: 0, y: 1 });
  });
});
