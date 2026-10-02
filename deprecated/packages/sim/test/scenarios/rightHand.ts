// Right-hand traffic as a grid invariant, shared by the scenario tests.
import type { RoadDir } from '../../src/commands';
import type { MapGrid } from '../../src/map/grid';
import { dirDelta, dirLeft, dirOpposite, dirRight } from '../../src/map/roads';

/** Lane tiles that break right-hand traffic: an oncoming lane to the driver's right, or none to the left. */
export function rightHandOffenders(grid: MapGrid): string[] {
  const offenders: string[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const road = grid.get({ x, y })!.road;
      if (road.dir === 'None' || road.kind === 'None') continue;
      const dir = road.dir;
      // Sideways across lanes of the same direction: does the road reach an oncoming lane?
      const reachesOncoming = (side: RoadDir) => {
        const d = dirDelta(side);
        for (let p = { x: x + d.x, y: y + d.y }; ; p = { x: p.x + d.x, y: p.y + d.y }) {
          const next = grid.get(p)?.road;
          if (next === undefined || next.kind === 'None' || next.dir === 'None') return false;
          if (next.dir === dirOpposite(dir)) return true;
          if (next.dir !== dir) return false;
        }
      };
      if (reachesOncoming(dirRight(dir))) offenders.push(`(${x},${y}) ${dir}: oncoming lane on the right`);
      if (!reachesOncoming(dirLeft(dir))) offenders.push(`(${x},${y}) ${dir}: no oncoming lane on the left`);
    }
  }
  return offenders;
}
