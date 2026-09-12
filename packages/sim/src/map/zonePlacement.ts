// Zone placement constraints: port of `can_zone_tile` (zone_placement.rs) and `is_within_zone_depth`
// (buildings/zone_depth.rs). Zones reach as deep as a building grows (GDD 10.2.2).
import type { TilePos } from '../commands';
import type { MapGrid } from './grid';

export const MAX_ZONE_DEPTH = 3;

/** Breadth-first search for a road within `maxDepth` steps, through land that is neither water nor a building. */
export function isWithinZoneDepth(tile: TilePos, grid: MapGrid, maxDepth: number): boolean {
  if (maxDepth === 0) return false;
  const start = grid.idx(tile);
  if (start !== undefined && grid.roadKind[start] !== 0) return true;

  const visited = new Set<string>([`${tile.x},${tile.y}`]);
  const queue: Array<readonly [TilePos, number]> = [[tile, 0]];
  for (let head = 0; head < queue.length; head++) {
    const [current, depth] = queue[head]!;
    if (depth >= maxDepth) continue;
    const neighbours: TilePos[] = [
      { x: current.x, y: current.y - 1 },
      { x: current.x + 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x - 1, y: current.y },
    ];
    for (const neighbour of neighbours) {
      const key = `${neighbour.x},${neighbour.y}`;
      if (visited.has(key)) continue;
      const i = grid.idx(neighbour);
      if (i === undefined) continue;
      if (grid.roadKind[i] !== 0) return true;
      if (grid.water[i] === 0 && grid.building[i] === 0) {
        visited.add(key);
        queue.push([neighbour, depth + 1]);
      }
    }
  }
  return false;
}

/** Whether every tile of a footprint lies within zone depth of some road. */
export function isFootprintWithinZoneDepth(anchor: TilePos, width: number, length: number, grid: MapGrid, maxDepth: number): boolean {
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < length; dy++) {
      if (!isWithinZoneDepth({ x: anchor.x + dx, y: anchor.y + dy }, grid, maxDepth)) return false;
    }
  }
  return true;
}

/** Land that is not road, water or building and lies within zone depth of a road. Existing zones may be overwritten. */
export function canZoneTile(grid: MapGrid, pos: TilePos): boolean {
  const i = grid.idx(pos);
  if (i === undefined) return false;
  if (grid.water[i] !== 0 || grid.roadKind[i] !== 0 || grid.building[i] !== 0) return false;
  return isWithinZoneDepth(pos, grid, MAX_ZONE_DEPTH);
}
