// A generated city for `?scenario=city`, built with the road and zone tools on a 128×128 map (north up).
// Farmland lies south of the southern arterial; between it and a winding river is an industrial belt
// of large lots. Across the river, bridged only by the three north–south arterials, the city proper:
// a dense downtown grid around a six-lane boulevard, shops along the boulevard, long residential blocks
// whose streets jog where districts meet, a park with a pond, and dead-end streets into the suburbs.
// The nine arterial crossings are lit.
import type { GameCommand, RoadKind, TilePos, ZoneDensity, ZoneKind } from '../commands';
import { detectIntersections } from '../intersections/index';
import { applyGameCommandsToGrid } from '../map/apply';
import { roadSegmentCommands } from '../map/roadTool';
import type { World } from '../world';

export interface CityPlan {
  /** Residential lots beside a lane. */
  readonly homes: readonly TilePos[];
  /** Commercial and industrial lots beside a lane. */
  readonly workplaces: readonly TilePos[];
  /** A tile of every lit crossing. */
  readonly lights: readonly TilePos[];
}

export const CITY_SIZE = 128;

// Footprints, from the road tool: a horizontal road with centre c covers rows c-1..c (two lanes),
// c-2..c+1 (four), c-3..c+2 (six); a vertical one covers columns c..c+1 (two) or c-1..c+2 (four).
// Every street below starts and ends on the far lane of the road it meets, so each junction spans the
// whole road, and no two parallel roads touch.

/** North–south arterials (four lanes) and east–west ones; the middle east–west one is the boulevard. */
const ARTERIALS_X = [20, 62, 104] as const;
const ARTERIALS_Y = [16, 62, 106] as const;
const BOULEVARD_Y = 62;

type Line = readonly [centre: number, from: number, to: number];

/** East–west streets: collectors across the city, the downtown one, the industrial service road. */
const STREETS_Y: readonly Line[] = [
  [25, 3, 124],
  [44, 19, 106],
  [51, 19, 85],
  [71, 19, 106],
  [77, 39, 85],
  [82, 19, 106],
  [94, 19, 106],
];

/** North–south streets: downtown, residential west and east, north residential (jogged), industrial. */
const STREETS_X: readonly Line[] = [
  ...[39, 46, 53, 70, 77, 84].map((x) => [x, 43, 82] as const),
  ...[26, 32].map((x) => [x, 43, 107] as const),
  ...[91, 97].map((x) => [x, 59, 107] as const),
  ...[42, 49, 56, 69, 76, 83].map((x) => [x, 81, 107] as const),
  ...[36, 50, 78, 92, 118].map((x) => [x, 14, 30] as const),
];

/** Dead-end streets into the suburbs: north of the northern arterial, west and east of the ring. */
const SPURS_NORTH = [28, 36, 44, 52, 72, 80, 88, 96] as const;
const SPURS_SIDE = [48, 56, 67, 77, 88, 100] as const;

const PARK = { minX: 86, maxX: 102, minY: 45, maxY: 58 } as const;
const POND = { x: 94, y: 51, radiusSq: 10 } as const;
/** The river's middle row; it winds a row either way, over 34..38 at rest. */
const RIVER_Y = 36;

function riverShift(x: number): number {
  const t = x % 16;
  return t < 4 ? 0 : t < 8 ? 1 : t < 12 ? 0 : -1;
}

function zoneAt(x: number, y: number): readonly [ZoneKind, ZoneDensity] | undefined {
  if (y <= 13) return undefined; // farmland
  if (x >= PARK.minX && x <= PARK.maxX && y >= PARK.minY && y <= PARK.maxY) return undefined;
  if (y <= 32) return ['Industrial', 'Medium'];
  if (y <= 39) return undefined; // river banks
  if (x >= 39 && x <= 85 && y >= 43 && y <= 82) return ['Commercial', 'High']; // downtown
  if (y >= 55 && y <= 68) return ['Commercial', 'Medium']; // shops along the boulevard
  if (y >= 108 || x <= 18 || x >= 107) return ['Residential', 'Low']; // suburbs
  return ['Residential', 'Medium'];
}

/** Lays the city onto `w`'s blank 128×128 map; the lights are placed by the next frame's commands. */
export function buildCity(w: World): CityPlan {
  const grid = w.grid;
  if (grid.width < CITY_SIZE || grid.height < CITY_SIZE) throw new RangeError(`buildCity needs a ${CITY_SIZE}×${CITY_SIZE} map`);
  const setWater = (x: number, y: number) => {
    const cell = grid.get({ x, y });
    if (cell !== undefined) grid.set({ x, y }, { ...cell, water: true });
  };
  const bridge = (x: number) => ARTERIALS_X.some((c) => x >= c - 1 && x <= c + 2);
  for (let x = 0; x < CITY_SIZE; x++) {
    if (bridge(x)) continue;
    for (let y = RIVER_Y - 2; y <= RIVER_Y + 2; y++) setWater(x, y + riverShift(x));
  }
  for (let y = POND.y - 3; y <= POND.y + 3; y++) {
    for (let x = POND.x - 3; x <= POND.x + 3; x++) if ((x - POND.x) ** 2 + (y - POND.y) ** 2 <= POND.radiusSq) setWater(x, y);
  }

  // Narrow roads first: the tool refuses a narrower road over a wider one, so arterials go over the
  // streets they cross and the boulevard over the arterials, turning each crossing into a box.
  const roads: GameCommand[] = [];
  const lay = (a: TilePos, b: TilePos, kind: RoadKind) => roads.push(...roadSegmentCommands(a, b, kind, w.trafficConfig.driveOnRight, false));
  for (const [y, from, to] of STREETS_Y) lay({ x: from, y }, { x: to, y }, 'TwoLane');
  for (const [x, from, to] of STREETS_X) lay({ x, y: from }, { x, y: to }, 'TwoLane');
  for (const x of SPURS_NORTH) lay({ x, y: 104 }, { x, y: 120 }, 'TwoLane');
  for (const y of SPURS_SIDE) {
    lay({ x: 22, y }, { x: 6, y }, 'TwoLane');
    lay({ x: 103, y }, { x: 121, y }, 'TwoLane');
  }
  for (const x of ARTERIALS_X) lay({ x, y: 1 }, { x, y: 126 }, 'FourLane');
  for (const y of ARTERIALS_Y) if (y !== BOULEVARD_Y) lay({ x: 1, y }, { x: 126, y }, 'FourLane');
  lay({ x: 1, y: BOULEVARD_Y }, { x: 126, y: BOULEVARD_Y }, 'SixLane');

  const zones: GameCommand[] = [];
  for (let y = 0; y < CITY_SIZE; y++) {
    for (let x = 0; x < CITY_SIZE; x++) {
      const zone = zoneAt(x, y);
      if (zone !== undefined) zones.push({ kind: 'SetZone', pos: { x, y }, zone: zone[0], density: zone[1] });
    }
  }

  // A demonstration city costs the treasury nothing.
  const money = w.city.money;
  applyGameCommandsToGrid(w, roads);
  applyGameCommandsToGrid(w, zones);
  w.city.money = money;
  // The construction lines went through the ledger; the month starts over from the untouched treasury.
  w.budget.restart(money);
  detectIntersections(w);

  const lights: TilePos[] = [];
  for (const x of ARTERIALS_X) for (const y of ARTERIALS_Y) lights.push({ x, y });
  for (const pos of lights) w.commands.push({ kind: 'PlaceTrafficLight', pos });

  const isLane = (p: TilePos) => {
    const cell = grid.get(p);
    return cell !== undefined && !cell.water && cell.road.kind !== 'None' && cell.road.dir !== 'None';
  };
  const homes: TilePos[] = [];
  const workplaces: TilePos[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const zone = grid.get({ x, y })!.zone;
      if (zone === 'None') continue;
      const besideLane = isLane({ x: x - 1, y }) || isLane({ x: x + 1, y }) || isLane({ x, y: y - 1 }) || isLane({ x, y: y + 1 });
      if (!besideLane) continue;
      (zone === 'Residential' ? homes : workplaces).push({ x, y });
    }
  }
  return { homes, workplaces, lights };
}
