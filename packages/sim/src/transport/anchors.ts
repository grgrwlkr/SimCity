// Port of `adjacent_road_towards` and `adjacent_road_towards_footprint`
// (crates/simcity_sim/src/game/transport/mod.rs): the road tile a trip starts or ends on.
import type { TilePos } from '../commands';
import type { MapGrid } from '../map/grid';

/** Best first: a lane matching the desired direction, then a perpendicular one, then oncoming. */
const CORRECT_LANE = 0;
const NON_OPPOSITE = 1;
const ONCOMING = 2;
const NOT_A_LANE = 3;

// `ROAD_DIRS` indices: None, West, East, North, South; and the opposite of each.
const WEST = 1;
const EAST = 2;
const NORTH = 3;
const SOUTH = 4;
const OPPOSITE = [0, EAST, WEST, SOUTH, NORTH] as const;

function desiredDir(from: TilePos, to: TilePos): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? EAST : WEST;
  return dy >= 0 ? NORTH : SOUTH;
}

/** The rank of the tile at (`x`, `y`) for a trip wanting `want`, read off the layers without a cell object. */
function roadAnchorRank(grid: MapGrid, x: number, y: number, want: number): number {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return NOT_A_LANE;
  const i = y * grid.width + x;
  if (grid.water[i] !== 0 || grid.roadKind[i] === 0) return NOT_A_LANE;
  // Not a box tile (Rust ranked them with perpendicular lanes): a route ending inside a box has no exit
  // lane, so the arbiter never takes the car and it waits at the box forever.
  const dir = grid.roadDir[i]!;
  if (dir === 0) return NOT_A_LANE;
  // The wrong-way carriageway of a one-way road is not drivable (`roadFlow` is 0 for two-way, 1 + the direction one way).
  const flow = grid.roadFlow[i]!;
  if (flow !== 0 && dir !== flow - 1) return NOT_A_LANE;
  if (dir === want) return CORRECT_LANE;
  return dir !== OPPOSITE[want] ? NON_OPPOSITE : ONCOMING;
}

/** A road tile at or 4-adjacent to `pos` for a trip towards `target`; the oncoming lane only as a last resort. */
export function adjacentRoadTowards(grid: MapGrid, pos: TilePos, target: TilePos): TilePos | undefined {
  const want = desiredDir(pos, target);
  // The candidates in order: the tile, then west, east, south, north of it; the first of the best rank wins.
  let best = -1;
  let bestRank = NOT_A_LANE;
  for (let c = 0; c < 5; c++) {
    const x = pos.x + (c === 1 ? -1 : c === 2 ? 1 : 0);
    const y = pos.y + (c === 3 ? -1 : c === 4 ? 1 : 0);
    const rank = roadAnchorRank(grid, x, y, want);
    if (rank < bestRank) {
      best = c;
      bestRank = rank;
    }
  }
  if (best < 0) return undefined;
  return { x: pos.x + (best === 1 ? -1 : best === 2 ? 1 : 0), y: pos.y + (best === 3 ? -1 : best === 4 ? 1 : 0) };
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
  let [bestX, bestY, bestRank, bestDist] = [0, 0, NOT_A_LANE, Infinity];
  for (let y = anchor.y - 1; y <= anchor.y + long; y++) {
    for (let x = anchor.x - 1; x <= anchor.x + wide; x++) {
      const insideX = x >= anchor.x && x < anchor.x + wide;
      const insideY = y >= anchor.y && y < anchor.y + long;
      // Edge neighbours only: beside a footprint row or column, never a corner or inside.
      if (insideX === insideY) continue;
      const rank = roadAnchorRank(grid, x, y, want);
      if (rank === NOT_A_LANE) continue;
      const dist = Math.abs(target.x - x) + Math.abs(target.y - y);
      if (rank < bestRank || (rank === bestRank && dist < bestDist)) [bestX, bestY, bestRank, bestDist] = [x, y, rank, dist];
    }
  }
  return bestRank === NOT_A_LANE ? undefined : { x: bestX, y: bestY };
}

/**
 * The tile of a `width` × `length` footprint a trip leaves from or parks on: the one beside its entrance road towards
 * `target`, or the anchor when no road touches the footprint.
 */
export function footprintEntrance(grid: MapGrid, anchor: TilePos, width: number, length: number, target: TilePos): TilePos {
  const road = adjacentRoadTowardsFootprint(grid, anchor, width, length, target);
  if (road === undefined) return anchor;
  // An edge neighbour clamped into the footprint is the tile it touches.
  return {
    x: Math.min(Math.max(road.x, anchor.x), anchor.x + Math.max(width, 1) - 1),
    y: Math.min(Math.max(road.y, anchor.y), anchor.y + Math.max(length, 1) - 1),
  };
}
