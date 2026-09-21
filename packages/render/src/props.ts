// Where street furniture stands: port of crates/simcity_sim/src/game/map/props.rs with the knobs of
// crates/simcity_core/src/game/props_config.rs, values from assets/config/props.ron (tag rust-final). Pure functions
// only — the scene that spawns the meshes is stage R2, so nothing here touches three.js.
//
// Placement is a function of the grid and the map seed: no RNG state, no spawn order dependence. Props are spawned
// once per map and afterwards only their visibility is toggled; despawn churn frees entity ids for sim spawns to
// reuse, and sim behaviour must never depend on render allocation (that variant shifted the soak's orphan-car timing).
import type { MapLayersReply } from '@simcity/bridge';

/** What placement reads of the map: a `MapLayersReply` is one. */
export interface PropGrid {
  readonly width: number;
  readonly height: number;
  readonly layers: {
    /** Non-zero where the tile is water. */
    readonly water: Uint8Array;
    /** `ROAD_KINDS` index; 0 is `None`, so non-zero is carriageway. */
    readonly roadKind: Uint8Array;
  };
}

/** A step to a neighbouring tile, `IVec2` of the Rust side. */
export interface TileDir {
  readonly x: number;
  readonly y: number;
}

export interface TilePos {
  readonly x: number;
  readonly y: number;
}

/** Lamp posts along the kerb, and the wires strung between them. */
export interface StreetlightConfig {
  readonly enabled: boolean;
  /** One lamp every N eligible kerb tiles along a road run. */
  readonly spacingTiles: number;
  readonly poleHeight: number;
  /** How far the lamp arm reaches over the carriageway. */
  readonly armLength: number;
  /** Distance from the tile centre to the kerb line. */
  readonly kerbOffset: number;
  /** Wires between consecutive lamps; off when the lamps are off. */
  readonly wires: boolean;
  /** How far a wire dips between two lamps, in world units. */
  readonly wireSag: number;
}

/** Shop signs — the one prop that is meant to be seen at night. */
export interface SignConfig {
  readonly enabled: boolean;
  readonly chancePercent: number;
  readonly width: number;
  readonly height: number;
  /** Height above the pavement the sign hangs at. */
  readonly mountHeight: number;
  /** Emissive strength after dark. Day keeps the sign unlit. */
  readonly nightEmissive: number;
}

/** Anything placed by a per-tile dice roll: bins, awnings, parked cars. */
export interface PropChanceConfig {
  readonly enabled: boolean;
  /** Percent of eligible tiles that get one; the roll is a hash of the tile and the map seed. */
  readonly chancePercent: number;
}

export interface PropsConfig {
  readonly streetlight: StreetlightConfig;
  readonly sign: SignConfig;
  readonly bin: PropChanceConfig;
  readonly awning: PropChanceConfig;
  readonly parkedCar: PropChanceConfig;
}

/**
 * assets/config/props.ron, as constants until the RON loader of stage 6 — the same arrangement `renderConfig.ts`
 * uses; props.test.ts reads the file and fails when a value drifts or a knob is added without its constant. Where
 * the file differs from the Rust defaults (the sign's night emissive: 5.0 blew the boards out to white bars under
 * ACES), the file wins: it is what the game ran with.
 */
export const PROPS_CONFIG: PropsConfig = {
  // Denser than 4 turns a street into a picket fence at far zoom; sparser and the night reads unlit.
  streetlight: { enabled: true, spacingTiles: 4, poleHeight: 9.0, armLength: 2.5, kerbOffset: 6.0, wires: true, wireSag: 1.4 },
  // Signs and awnings hang on BUILT tiles only — over an empty lot they read as a bug.
  sign: { enabled: true, chancePercent: 45, width: 5.0, height: 1.8, mountHeight: 7.0, nightEmissive: 2.8 },
  bin: { enabled: true, chancePercent: 30 },
  awning: { enabled: true, chancePercent: 40 },
  // Kerbside parking is visual only — these are not sim vehicles and the traffic model must not see them.
  parkedCar: { enabled: true, chancePercent: 28 },
};

/** The four neighbours, in a fixed order so the answer never depends on iteration luck. */
const NEIGHBOURS: readonly TileDir[] = [
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
];

interface Cell {
  readonly road: boolean;
  readonly water: boolean;
}

/** The cell at `(x, y)`, or `null` off the map — `MapGrid::get` of the Rust side. */
function cellAt(grid: PropGrid, x: number, y: number): Cell | null {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  const i = y * grid.width + x;
  return { road: grid.layers.roadKind[i] !== 0, water: grid.layers.water[i] !== 0 };
}

/**
 * Direction from a road tile towards its kerb, or `null` when the tile is not a road or sits in the middle of a
 * carriageway with road on every side.
 */
export function kerbSide(grid: PropGrid, x: number, y: number): TileDir | null {
  const cell = cellAt(grid, x, y);
  if (cell === null || !cell.road || cell.water) return null;
  return (
    NEIGHBOURS.find((d) => {
      const n = cellAt(grid, x + d.x, y + d.y);
      // Off the map counts as kerb: a road running to the edge still has an outside.
      return n === null || (!n.road && !n.water);
    }) ?? null
  );
}

/** Whether this kerb tile carries a lamp post. */
export function wantsStreetlight(grid: PropGrid, x: number, y: number, cfg: StreetlightConfig = PROPS_CONFIG.streetlight): boolean {
  if (!cfg.enabled || cfg.spacingTiles === 0) return false;
  if (kerbSide(grid, x, y) === null) return false;
  // Along a straight run one of x or y is constant, so the sum steps by one per tile and the lamps come out evenly
  // spaced. `rem_euclid`: the remainder stays non-negative left of the origin.
  return (((x + y) % cfg.spacingTiles) + cfg.spacingTiles) % cfg.spacingTiles === 0;
}

/** The tile a lamp's wire reaches towards: the next lamp along the same run, if there is one. */
export function wirePartner(grid: PropGrid, x: number, y: number, cfg: StreetlightConfig = PROPS_CONFIG.streetlight): TilePos | null {
  if (!cfg.wires || cfg.spacingTiles === 0) return null;
  const step = cfg.spacingTiles;
  const here = kerbSide(grid, x, y);
  // A run is horizontal or vertical; try the direction the neighbouring road actually continues in.
  for (const d of [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]) {
    const nx = x + d.x * step;
    const ny = y + d.y * step;
    const there = kerbSide(grid, nx, ny);
    if (wantsStreetlight(grid, nx, ny, cfg) && here !== null && there !== null && here.x === there.x && here.y === there.y) {
      return { x: nx, y: ny };
    }
  }
  return null;
}

/** Salts keep one kind of prop from landing on the same tiles as another. */
export const PROP_SALT = {
  parkedCar: 1n,
  bin: 2n,
  sign: 3n,
  awning: 4n,
  carTint: 5n,
} as const;

const U64 = (v: bigint) => BigInt.asUintN(64, v);

/** Deterministic value hash of (tile, seed, salt); the Rust `prop_hash`, wrapping u64 arithmetic and all. */
export function propHash(x: number, y: number, seed: bigint, salt: bigint): bigint {
  // `pos.x as u64` of the Rust side sign-extends an i32, so a tile left of the origin hashes the same here.
  let h = U64(
    U64(seed) ^ U64(U64(salt) * 0xa24b_aed4_963e_e407n) ^ U64(BigInt.asUintN(64, BigInt(x)) * 0x9e37_79b1_85eb_ca87n) ^ U64(BigInt.asUintN(64, BigInt(y)) * 0xc2b2_ae3d_27d4_eb4fn),
  );
  h ^= h >> 33n;
  h = U64(h * 0xff51_afd7_ed55_8ccdn);
  h ^= h >> 29n;
  h = U64(h * 0xc4ce_b9fe_1a85_ec53n);
  return U64(h ^ (h >> 32n));
}

/** A stable per-tile dice roll. `salt` separates one kind of prop from another. */
export function propRoll(x: number, y: number, seed: bigint, salt: bigint, chancePercent: number): boolean {
  if (chancePercent === 0) return false;
  if (chancePercent >= 100) return true;
  return propHash(x, y, seed, salt) % 100n < BigInt(chancePercent);
}

/** Which side of a non-road tile faces a road, or `null` when it faces none. */
export function roadSide(grid: PropGrid, x: number, y: number): TileDir | null {
  const cell = cellAt(grid, x, y);
  if (cell === null || cell.road || cell.water) return null;
  return NEIGHBOURS.find((d) => cellAt(grid, x + d.x, y + d.y)?.road === true) ?? null;
}

/**
 * Which side a shop's furniture faces, or `null` if the tile has no shop.
 *
 * `built` must come from the render-side building index, NOT from the grid's building layer: that field is written
 * only for service buildings and for what the player places by hand, while R/C/I grown by the simulation leaves it
 * empty. Reading the grid found 15 tiles in a whole city.
 */
export function kerbsideSide(grid: PropGrid, x: number, y: number, built: boolean): TileDir | null {
  if (!built) return null;
  return roadSide(grid, x, y);
}

export type Rgb = readonly [number, number, number];

/**
 * The only body colours a parked car comes in.
 *
 * A fixed palette, not a free hash: the mesh is cached per colour, so one tint per car meant one MESH per car and the
 * distinct-mesh count went from 44 to 139. Four keeps a street from looking like a car park of clones while costing
 * four batches.
 */
export const PARKED_CAR_TINTS: readonly Rgb[] = [
  [0.62, 0.63, 0.66],
  [0.24, 0.27, 0.34],
  [0.45, 0.19, 0.18],
  [0.2, 0.32, 0.28],
];

/** Which of the four a car on this tile wears. */
export function parkedCarTint(x: number, y: number, seed: bigint): Rgb {
  const h = propHash(x, y, seed, PROP_SALT.carTint);
  return PARKED_CAR_TINTS[Number(h % BigInt(PARKED_CAR_TINTS.length))]!;
}

/** Rotation about Z that turns the mesh's `+X` towards `dir`, radians; the scene turns it into a quaternion. */
export function facing(dir: TileDir): number {
  return Math.atan2(dir.y, dir.x);
}

/** What a spawned prop is, so the toggle knows which predicate keeps it visible. */
export type PropRole =
  /** Lamp post and its wire: alive while the tile is a kerb. */
  | 'Streetlight'
  /** Kerbside car: alive while the tile is a kerb. */
  | 'ParkedCar'
  /** Bin, sign or awning: alive while the tile is zoned land facing a road. */
  | 'Kerbside';

/** Whether a prop of `role` should be on screen for the tile as it stands now. */
export function wantsShowing(role: PropRole, grid: PropGrid, x: number, y: number, built: boolean, cfg: StreetlightConfig = PROPS_CONFIG.streetlight): boolean {
  if (role === 'Streetlight') return wantsStreetlight(grid, x, y, cfg);
  if (role === 'ParkedCar') return kerbSide(grid, x, y) !== null;
  return kerbsideSide(grid, x, y, built) !== null;
}

/** A `MapLayersReply` read as a placement grid. */
export function propGrid(map: MapLayersReply): PropGrid {
  return { width: map.width, height: map.height, layers: { water: map.layers.water, roadKind: map.layers.roadKind } };
}
