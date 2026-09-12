// Stage 3½d: where the cars of citizens are drawn. A meso car stands at its share of the way along its link, never nearer
// than a car's room to the car ahead, the queue spread across the link's lanes; a parked car stands on its tile. The
// renderer interpolates between frames by the id and generation handed over with each car.
import { tileFToWorld } from '../map/coords';
import { CAR_PARKED } from '../parking';
import type { World } from '../world';
import { CAR_SPACE_METERS } from './traffic';

const f32 = Math.fround;
const PI = f32(Math.PI);
const HALF_PI = f32(Math.PI / 2);
/** Heading by `ROAD_DIRS` index, as micro vehicles have it: east 0, north π/2. */
const HEADINGS = [0, PI, 0, HALF_PI, -HALF_PI] as const;
const [WEST, EAST, NORTH] = [1, 2, 3];

/** `id` is a meso car slot for a driving car and a citizen slot for a parked one; world coordinates. */
export type CitizenCarVisitor = (parked: boolean, id: number, generation: number, x: number, y: number, heading: number) => void;

/** Every car of a citizen: the driving ones queue by queue, then the parked ones in citizen order. */
export function forEachCitizenCar(w: World, visit: CitizenCarVisitor): void {
  const m = w.mesoTraffic;
  const g = w.meso;
  const cfg = w.mapConfig;
  const room = CAR_SPACE_METERS / w.trafficConfig.tileMeters;

  if (m.linksFor !== null && m.linksFor === g.builtFor) {
    for (let link = 0; link < m.head.length; link++) {
      const dir = g.dir[link]!;
      const lanes = g.lanes[link]!;
      const length = g.length[link]!;
      const [startX, startY, endX, endY] = [g.startX[link]!, g.startY[link]!, g.endX[link]!, g.endY[link]!];
      let place = 0;
      for (let car = m.head[link]!; car >= 0; car = m.next[car]!, place++) {
        const last = m.routeCursor[car]! >= m.routes[car]!.length ? m.goalOffset[car]! : length - 1;
        const from = m.fromOffset[car]!;
        const span = m.readySec[car]! - m.enterSec[car]!;
        const share = span > 0 ? Math.min(Math.max((m.nowSec - m.enterSec[car]!) / span, 0), 1) : 1;
        const along = Math.max(Math.min(from + (last - from) * share, last - Math.floor(place / lanes) * room), 0);
        const across = (place % lanes) - (lanes - 1) / 2;
        const fraction = length > 1 ? along / (length - 1) : 0;
        let x: number;
        let y: number;
        if (dir === EAST || dir === WEST) {
          x = dir === EAST ? startX + along : startX - along;
          y = startY + (endY - startY) * fraction + across;
        } else {
          y = dir === NORTH ? startY + along : startY - along;
          x = startX + (endX - startX) * fraction + across;
        }
        const at = tileFToWorld(cfg, x, y);
        visit(false, car, m.generation[car]!, at.x, at.y, HEADINGS[dir as 0 | 1 | 2 | 3 | 4]);
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
