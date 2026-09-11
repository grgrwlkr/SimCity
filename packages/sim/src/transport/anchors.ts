// Port of `adjacent_road_towards` and `adjacent_road_towards_footprint`
// (crates/simcity_sim/src/game/transport/mod.rs): the road tile a trip starts or ends on.
import type { RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { dirOpposite } from '../map/roads';
import { isWrongWayOnOneWay } from './roadGraph';

/** Best first: a lane matching the desired direction, then perpendicular or box tiles, then oncoming. */
const CORRECT_LANE = 0;
const NON_OPPOSITE = 1;
const ONCOMING = 2;

function desiredDir(from: TilePos, to: TilePos): RoadDir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'East' : 'West';
  return dy >= 0 ? 'North' : 'South';
}

function roadAnchorRank(grid: MapGrid, pos: TilePos, want: RoadDir): number | undefined {
  const cell = grid.get(pos);
  if (cell === undefined || cell.water || cell.road.kind === 'None') return undefined;
  // The wrong-way carriageway of a one-way road is not drivable.
  if (isWrongWayOnOneWay(cell.road)) return undefined;
  if (cell.road.dir === want) return CORRECT_LANE;
  return cell.road.dir !== dirOpposite(want) ? NON_OPPOSITE : ONCOMING;
}

/** A road tile at or 4-adjacent to `pos` for a trip towards `target`; the oncoming lane only as a last resort. */
export function adjacentRoadTowards(grid: MapGrid, pos: TilePos, target: TilePos): TilePos | undefined {
  const want = desiredDir(pos, target);
  let bestCorrect: TilePos | undefined;
  let bestNonOpposite: TilePos | undefined;
  let bestAny: TilePos | undefined;
  const candidates: TilePos[] = [
    pos,
    { x: pos.x - 1, y: pos.y },
    { x: pos.x + 1, y: pos.y },
    { x: pos.x, y: pos.y - 1 },
    { x: pos.x, y: pos.y + 1 },
  ];
  for (const candidate of candidates) {
    const rank = roadAnchorRank(grid, candidate, want);
    if (rank === undefined) continue;
    if (rank === CORRECT_LANE) bestCorrect ??= candidate;
    if (rank <= NON_OPPOSITE) bestNonOpposite ??= candidate;
    bestAny ??= candidate;
  }
  return bestCorrect ?? bestNonOpposite ?? bestAny;
}

/**
 * The entrance of a `width` × `length` footprint: the anchor's own road if it has one, otherwise
 * the best-ranked road tile along the footprint's edge, the nearest to `target` among equals.
 */
export function adjacentRoadTowardsFootprint(
  grid: MapGrid,
  anchor: TilePos,
  width: number,
  length: number,
  target: TilePos,
): TilePos | undefined {
  const own = adjacentRoadTowards(grid, anchor, target);
  if (own !== undefined) return own;

  const want = desiredDir(anchor, target);
  const wide = Math.max(width, 1);
  const long = Math.max(length, 1);
  let best: { rank: number; dist: number; pos: TilePos } | undefined;
  for (let y = anchor.y - 1; y <= anchor.y + long; y++) {
    for (let x = anchor.x - 1; x <= anchor.x + wide; x++) {
      const insideX = x >= anchor.x && x < anchor.x + wide;
      const insideY = y >= anchor.y && y < anchor.y + long;
      // Edge neighbours only: beside a footprint row or column, never a corner or inside.
      if (insideX === insideY) continue;
      const pos = { x, y };
      const rank = roadAnchorRank(grid, pos, want);
      if (rank === undefined) continue;
      const dist = Math.abs(target.x - x) + Math.abs(target.y - y);
      if (best === undefined || rank < best.rank || (rank === best.rank && dist < best.dist)) {
        best = { rank, dist, pos };
      }
    }
  }
  return best?.pos;
}
