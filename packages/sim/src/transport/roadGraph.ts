// Port of crates/simcity_sim/src/game/transport/road_graph.rs: a per-tile 4-bit mask of the road
// neighbours a vehicle may legally move to, strict about lane direction (right-hand traffic).
import type { RoadCell, RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { dirDelta, dirLeft, dirOpposite, dirRight, isLeftmostForDir, isRightmostForDir, roadLanes } from '../map/roads';
import type { World } from '../world';

export const EDGE_W = 1 << 0;
export const EDGE_E = 1 << 1;
export const EDGE_S = 1 << 2;
export const EDGE_N = 1 << 3;

const BOX_SCAN_LIMIT = 64;

export class RoadGraph {
  version = 0;
  width = 0;
  height = 0;
  /** Per tile: mask of W, E, S, N neighbours it connects to. */
  edges = new Uint8Array(0);
  /** Road tile indices, one-way wrong-way halves excluded. */
  roadIndices: number[] = [];

  isBuiltFor(version: number): boolean {
    return this.version === version && this.edges.length > 0;
  }
}

const isVertical = (dir: RoadDir) => dir === 'North' || dir === 'South';

/** A one-way road's tile pointing against the flow: not usable by routing. */
export function isWrongWayOnOneWay(road: RoadCell): boolean {
  return road.flow.kind === 'OneWay' && road.dir !== 'None' && road.dir !== road.flow.dir;
}

/**
 * Direction of the real road continuing `at`'s column (`vertical`) or row, scanning out of the
 * intersection box to the nearest real lane tile on each side. `undefined` when no road continues
 * that axis or the two sides disagree. Shared with the oncoming oracle.
 */
export function boxAxisDir(grid: MapGrid, at: TilePos, vertical: boolean): RoadDir | undefined {
  let found: RoadDir | undefined;
  for (const sign of [1, -1]) {
    for (let k = 1; k <= BOX_SCAN_LIMIT; k++) {
      const p = vertical ? { x: at.x, y: at.y + sign * k } : { x: at.x + sign * k, y: at.y };
      const cell = grid.get(p);
      if (cell === undefined || cell.water || cell.road.kind === 'None') break;
      if (cell.road.dir !== 'None') {
        if (isVertical(cell.road.dir) === vertical) {
          if (found === undefined) found = cell.road.dir;
          else if (found !== cell.road.dir) return undefined;
        }
        break;
      }
    }
  }
  return found;
}

/** Both lanes on the same carriageway of the same road (no turn crosses into oncoming lanes). */
function lanesOnSameRoadSide(cur: RoadCell, next: RoadCell): boolean {
  const curLanes = roadLanes(cur.kind);
  if (cur.kind !== next.kind || curLanes !== roadLanes(next.kind)) return false;
  if (curLanes <= 2) return true;
  const half = Math.floor(curLanes / 2);
  return cur.lane < half === next.lane < half;
}

export function rebuildRoadGraphInner(grid: MapGrid, graphVersion: number, graph: RoadGraph): void {
  if (graph.isBuiltFor(graphVersion) && graph.width === grid.width && graph.height === grid.height) return;

  const w = grid.width;
  const h = grid.height;
  const len = w * h;
  graph.version = graphVersion;
  graph.width = w;
  graph.height = h;
  graph.edges = new Uint8Array(len);
  graph.roadIndices = [];

  const roadAt = (idx: number): RoadCell | null =>
    grid.water[idx] === 0 && grid.roadKind[idx] !== 0 ? grid.cellAt(idx).road : null;

  for (let idx = 0; idx < len; idx++) {
    const cur = roadAt(idx);
    if (cur === null || isWrongWayOnOneWay(cur)) continue;
    graph.roadIndices.push(idx);

    const x = idx % w;
    const y = Math.floor(idx / w);
    let mask = 0;

    const consider = (bit: number, nidx: number, moveDir: RoadDir): void => {
      const next = roadAt(nidx);
      if (next === null || isWrongWayOnOneWay(next)) return;

      // A step touching a box tile must not oppose the direction of the road continuing that
      // box tile's column (vertical step) or row (horizontal step).
      const stepVertical = isVertical(moveDir);
      const endpoints: ReadonlyArray<readonly [RoadCell, TilePos]> = [
        [cur, { x, y }],
        [next, { x: nidx % w, y: Math.floor(nidx / w) }],
      ];
      for (const [cell, pos] of endpoints) {
        if (cell.dir === 'None') {
          const lane = boxAxisDir(grid, pos, stepVertical);
          if (lane !== undefined && moveDir === dirOpposite(lane)) return;
        }
      }

      // Turn-lane restrictions apply when entering an intersection tile from a lane tile.
      if (cur.dir !== 'None' && next.dir === 'None') {
        if (cur.laneType === 'LeftTurnOnly' && moveDir !== dirLeft(cur.dir)) return;
        if (cur.laneType === 'RightTurnOnly' && moveDir !== dirRight(cur.dir)) return;
        if (cur.laneType === 'StraightOnly' && moveDir !== cur.dir) return;
      }

      // Leaving a cluster: only onto a lane that points the way we move.
      if (cur.dir === 'None' && next.dir !== 'None') {
        if (next.dir !== moveDir) return;
        mask |= 1 << bit;
        return;
      }

      // Entering a cluster: never in reverse.
      if (cur.dir !== 'None' && next.dir === 'None') {
        if (moveDir === dirOpposite(cur.dir)) return;
        mask |= 1 << bit;
        return;
      }

      // Inside a cluster.
      if (cur.dir === 'None' || next.dir === 'None') {
        mask |= 1 << bit;
        return;
      }

      // Straight into a lane tile of the same direction.
      if (moveDir === cur.dir && next.dir === cur.dir) {
        mask |= 1 << bit;
        return;
      }

      const left = dirLeft(cur.dir);
      const right = dirRight(cur.dir);

      // Lane change: perpendicular move, same direction, same carriageway.
      if (next.dir === cur.dir && (moveDir === left || moveDir === right) && lanesOnSameRoadSide(cur, next)) {
        mask |= 1 << bit;
        return;
      }

      // Left turn from the leftmost lane into the leftmost lane of the new direction.
      if (
        moveDir === left &&
        next.dir === left &&
        isLeftmostForDir(cur) &&
        isLeftmostForDir(next) &&
        lanesOnSameRoadSide(cur, next)
      ) {
        mask |= 1 << bit;
        return;
      }
      // Right turn from the rightmost lane into the rightmost lane of the new direction.
      if (
        moveDir === right &&
        next.dir === right &&
        isRightmostForDir(cur) &&
        isRightmostForDir(next) &&
        lanesOnSameRoadSide(cur, next)
      ) {
        mask |= 1 << bit;
      }
    };

    if (x > 0) consider(0, idx - 1, 'West');
    if (x + 1 < w) consider(1, idx + 1, 'East');
    if (y > 0) consider(2, idx - w, 'South');
    if (y + 1 < h) consider(3, idx + w, 'North');

    // Dead-end U-turn on two-way roads: when the tile straight ahead is not road, cross to the
    // adjacent opposite-direction lane of the same kind.
    if (cur.dir !== 'None' && cur.flow.kind !== 'OneWay') {
      const fwd = dirDelta(cur.dir);
      const fx = x + fwd.x;
      const fy = y + fwd.y;
      const forwardIsRoad = fx >= 0 && fy >= 0 && fx < w && fy < h && roadAt(fy * w + fx) !== null;
      if (!forwardIsRoad) {
        for (const perp of [dirLeft(cur.dir), dirRight(cur.dir)]) {
          const d = dirDelta(perp);
          const nx = x + d.x;
          const ny = y + d.y;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const opp = roadAt(ny * w + nx);
          if (opp === null) continue;
          if (opp.kind === cur.kind && opp.dir === dirOpposite(cur.dir)) {
            const bit = perp === 'West' ? 0 : perp === 'East' ? 1 : perp === 'South' ? 2 : 3;
            mask |= 1 << bit;
          }
        }
      }
    }

    graph.edges[idx] = mask;
  }
}

/** `rebuild_road_graph` (FixedUpdate / GraphUpdate). */
export function rebuildRoadGraph(w: World): void {
  rebuildRoadGraphInner(w.grid, w.graphVersion, w.roadGraph);
}
