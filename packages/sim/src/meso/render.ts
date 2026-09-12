// Stage 3½d: where the cars of citizens are drawn. A meso car keeps the lane of its manoeuvre along a link — the kerb lane
// before a right turn, the one by the centre line before a left turn or a U-turn, its own lane straight on — and stands at
// its share of the way, a car's room behind the car ahead in that lane. Through a box it moves from the end of the link it
// left to the start of the next along an L for a turn and a U for a U-turn, as micro traffic keeps its trajectories. A
// parked car stands on its tile. The renderer interpolates between frames by the id and generation of each car.
import { tileFToWorld } from '../map/coords';
import { CAR_PARKED } from '../parking';
import type { World } from '../world';
import { BOX_KMH } from './districts';
import type { MesoGraph } from './graph';
import { CAR_SPACE_METERS, type MesoTraffic } from './traffic';

const f32 = Math.fround;
const PI = f32(Math.PI);
const HALF_PI = f32(Math.PI / 2);

// By `ROAD_DIRS` index: None, West, East, North (y + 1), South.
const WEST = 1;
const EAST = 2;
const NORTH = 3;
/** Heading as micro vehicles have it: east 0, north π/2. */
const HEADINGS = [0, PI, 0, HALF_PI, -HALF_PI] as const;
/** The direction to the right of each, for right-hand traffic. */
const RIGHT_OF = [0, NORTH, 4, EAST, WEST] as const;
/** The sign of the kerb side on the axis across the travel direction. */
const KERB_SIDE = [0, 1, -1, 1, -1] as const;
const DELTA_X = [0, -1, 1, 0, 0] as const;
const DELTA_Y = [0, 0, 0, 1, -1] as const;

type Dir = 0 | 1 | 2 | 3 | 4;
const horizontal = (dir: number) => dir === EAST || dir === WEST;

/** `id` is a meso car slot for a driving car and a citizen slot for a parked one; world coordinates. */
export type CitizenCarVisitor = (parked: boolean, id: number, generation: number, x: number, y: number, heading: number) => void;

/** The lane a car takes on `link` before leaving for `next` (-1 at its goal): 0 is the kerb lane. */
function laneOf(g: MesoGraph, car: number, link: number, next: number): number {
  const lanes = g.lanes[link]!;
  if (lanes <= 1 || next < 0) return 0;
  const [from, to] = [g.dir[link]! as Dir, g.dir[next]!];
  if (to === from) return car % lanes;
  return to === RIGHT_OF[from] ? 0 : lanes - 1;
}

/** Tile coordinates of `along` tiles into `link`, in `lane`. */
function linkPoint(g: MesoGraph, link: number, along: number, lane: number): readonly [x: number, y: number] {
  const dir = g.dir[link]! as Dir;
  const lanes = g.lanes[link]!;
  const length = g.length[link]!;
  const across = KERB_SIDE[dir] * ((lanes - 1) / 2 - lane);
  const fraction = length > 1 ? along / (length - 1) : 0;
  if (horizontal(dir)) {
    return [g.startX[link]! + (dir === EAST ? along : -along), g.startY[link]! + (g.endY[link]! - g.startY[link]!) * fraction + across];
  }
  return [g.startX[link]! + (g.endX[link]! - g.startX[link]!) * fraction + across, g.startY[link]! + (dir === NORTH ? along : -along)];
}

/** The next link of a car's route after the one it is on, -1 at its goal. */
function nextLink(g: MesoGraph, m: MesoTraffic, car: number): number {
  const route = m.routes[car]!;
  const cursor = m.routeCursor[car]!;
  return cursor < route.length ? g.succLink[route[cursor]!]! : -1;
}

/** The point `share` of the way along a path of axis-aligned segments, and the heading of its segment there. */
function alongPath(points: ReadonlyArray<readonly [number, number]>, share: number): readonly [x: number, y: number, heading: number] {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.abs(points[i]![0] - points[i - 1]![0]) + Math.abs(points[i]![1] - points[i - 1]![1]);
  let left = share * total;
  let heading = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const length = Math.abs(bx - ax) + Math.abs(by - ay);
    if (length === 0) continue;
    heading = bx > ax ? 0 : bx < ax ? PI : by > ay ? HALF_PI : -HALF_PI;
    if (left <= length || i === points.length - 1) {
      const t = Math.min(left / length, 1);
      return [ax + (bx - ax) * t, ay + (by - ay) * t, heading];
    }
    left -= length;
  }
  const [x, y] = points.at(-1)!;
  return [x, y, heading];
}

/** Where a car crossing the box into `link` is: from the end of the link it left to the start of `link`. */
function boxPose(w: World, car: number, link: number, lane: number): readonly [x: number, y: number, heading: number] | undefined {
  const g = w.meso;
  const m = w.mesoTraffic;
  const prev = m.prevLink[car]!;
  const step = m.routes[car]![m.routeCursor[car]! - 1];
  if (prev < 0 || step === undefined || m.enterSec[car]! <= m.nowSec) return undefined;
  const boxTiles = g.succBoxTiles[step]!;
  const seconds = boxTiles * (w.trafficConfig.tileMeters / (BOX_KMH / 3.6));
  const share = seconds > 0 ? Math.min(Math.max(1 - (m.enterSec[car]! - m.nowSec) / seconds, 0), 1) : 1;
  const entry = linkPoint(g, prev, g.length[prev]! - 1, laneOf(g, car, prev, link));
  const exit = linkPoint(g, link, 0, lane);
  const [from, to] = [g.dir[prev]! as Dir, g.dir[link]! as Dir];
  const points: Array<readonly [number, number]> = [entry];
  if (to !== from && horizontal(to) === horizontal(from)) {
    // A U-turn: on into the box, across, and back out.
    const depth = Math.max(Math.ceil(boxTiles / 2), 1);
    const turn = [entry[0] + DELTA_X[from] * depth, entry[1] + DELTA_Y[from] * depth] as const;
    points.push(turn, horizontal(from) ? [turn[0], exit[1]] : [exit[0], turn[1]]);
  } else if (to !== from) {
    // A turn: straight on as far as the exit lane's line, then along it.
    points.push(horizontal(from) ? [exit[0], entry[1]] : [entry[0], exit[1]]);
  }
  points.push(exit);
  return alongPath(points, share);
}

/** Every car of a citizen: the driving ones queue by queue, then the parked ones in citizen order. */
export function forEachCitizenCar(w: World, visit: CitizenCarVisitor): void {
  const m = w.mesoTraffic;
  const g = w.meso;
  const cfg = w.mapConfig;
  const room = CAR_SPACE_METERS / w.trafficConfig.tileMeters;
  const ahead = new Int32Array(8);

  if (m.linksFor !== null && m.linksFor === g.builtFor) {
    for (let link = 0; link < m.head.length; link++) {
      const dir = g.dir[link]! as Dir;
      const length = g.length[link]!;
      ahead.fill(0);
      for (let car = m.head[link]!; car >= 0; car = m.next[car]!) {
        const lane = laneOf(g, car, link, nextLink(g, m, car));
        const inBox = boxPose(w, car, link, lane);
        const behind = ahead[lane]! * room;
        ahead[lane]! += 1;
        let x: number;
        let y: number;
        let heading: number = HEADINGS[dir];
        if (inBox !== undefined) {
          [x, y, heading] = inBox;
        } else {
          const last = m.routeCursor[car]! >= m.routes[car]!.length ? m.goalOffset[car]! : length - 1;
          const from = m.fromOffset[car]!;
          const span = m.readySec[car]! - m.enterSec[car]!;
          const share = span > 0 ? Math.min(Math.max((m.nowSec - m.enterSec[car]!) / span, 0), 1) : 1;
          const along = Math.max(Math.min(from + (last - from) * share, last - behind), 0);
          [x, y] = linkPoint(g, link, along, lane);
        }
        const at = tileFToWorld(cfg, x, y);
        visit(false, car, m.generation[car]!, at.x, at.y, heading);
      }
    }
  }

  const c = w.citizens;
  for (let slot = 0; slot < c.highWater; slot++) {
    if (c.alive[slot] !== 1 || c.carStatus[slot] !== CAR_PARKED) continue;
    const at = tileFToWorld(cfg, c.carX[slot]!, c.carY[slot]!);
    visit(true, slot, c.generation[slot]!, at.x, at.y, 0);
  }
}
