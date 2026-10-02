// Port of the router-independent oncoming oracle (crates/simcity_data/src/game/route_oncoming_pins.rs):
// judges a bare route against the map. On a box tile the correct direction is reconstructed from the
// road continuing that column (vertical step) or row (horizontal step), so an edge-hugging U-turn is
// caught while a legal П through the centre passes.
import type { RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { dirOpposite } from '../map/roads';
import { boxAxisDir } from './roadGraph';

function dirBetween(a: TilePos, b: TilePos): RoadDir {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 1 && dy === 0) return 'East';
  if (dx === -1 && dy === 0) return 'West';
  if (dx === 0 && dy === 1) return 'North';
  if (dx === 0 && dy === -1) return 'South';
  return 'None';
}

const isVertical = (dir: RoadDir) => dir === 'North' || dir === 'South';

/** The first step that drives against its carriageway, on a real lane or inside a box; non-adjacent steps are skipped. */
export function firstOncoming(route: readonly TilePos[], grid: MapGrid): readonly [TilePos, TilePos] | undefined {
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const step = dirBetween(a, b);
    if (step === 'None') continue;
    const vertical = isVertical(step);
    for (const at of [a, b]) {
      const cell = grid.get(at);
      if (cell === undefined || cell.water || cell.road.kind === 'None') continue;
      if (cell.road.dir !== 'None') {
        if (isVertical(cell.road.dir) === vertical && step === dirOpposite(cell.road.dir)) return [a, b];
      } else {
        const lane = boxAxisDir(grid, at, vertical);
        if (lane !== undefined && step === dirOpposite(lane)) return [a, b];
      }
    }
  }
  return undefined;
}
