// Port of crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs: A* over road lane-tiles and
// lanelets. Intersections are crossed only through lanelet ENTER/EXIT edges, so a route reaches the
// legal feeder lane upstream by construction.
import type { RoadDir, TilePos } from '../../commands';
import { tileKey, type MapGrid } from '../../map/grid';
import { dirDelta, dirLeft, dirOpposite, dirRight, roadCellIsSome } from '../../map/roads';
import type { LaneGraph } from '../laneGraph';
import {
  U32_MAX,
  baseTileCost,
  f32ToU32,
  heuristicTiles,
  laneEdgeCost,
  laneJitter,
  satAddU32,
  satMulU32,
  type LaneCostCtx,
} from '../lanePathfinding';
import { OpenSet } from '../openSet';
import type { LaneletGraph } from './graph';

export type CombinedNode =
  | { readonly kind: 'Road'; readonly id: number }
  | { readonly kind: 'Lanelet'; readonly id: number };

export const roadNode = (id: number): CombinedNode => ({ kind: 'Road', id });
export const laneletNode = (id: number): CombinedNode => ({ kind: 'Lanelet', id });

/** `(route tile index where the lanelet's internal path begins, intersection id, lanelet id)`. */
export type SidecarEntry = readonly [offset: number, intersection: number, lanelet: number];

export interface Route {
  readonly tiles: TilePos[];
  readonly sidecar: SidecarEntry[];
}

/** Dense packing of combined nodes: road lanes in `[0, roadLen)`, lanelets after them. */
export class NodeSpace {
  readonly roadLen: number;

  constructor(lg: LaneGraph) {
    this.roadLen = lg.lanes.length;
  }

  len(llg: LaneletGraph): number {
    return this.roadLen + llg.lanelets.length;
  }

  pack(node: CombinedNode): number {
    return node.kind === 'Road' ? node.id : this.roadLen + node.id;
  }

  unpack(idx: number): CombinedNode {
    return idx < this.roadLen ? roadNode(idx) : laneletNode(idx - this.roadLen);
  }
}

/**
 * Every successor of packed node `idx` with its integer cost, in a fixed order. Road: forward into a
 * same-direction lane, lateral lane changes (+laneChangePenalty), one ENTER edge per lanelet from
 * this lane (+turnPenalty + internal path). Lanelet: one EXIT edge to its exit lane, cost 1.
 */
export function forEachSucc(
  space: NodeSpace,
  idx: number,
  lg: LaneGraph,
  llg: LaneletGraph,
  ctx: LaneCostCtx,
  f: (succ: number, cost: number) => void,
): void {
  if (idx >= space.roadLen) {
    const ll = llg.get(idx - space.roadLen);
    if (ll !== undefined) f(ll.exitLane, 1);
    return;
  }
  const lane = lg.getLane(idx);
  if (lane === undefined) return;

  // Never a soft penalty: a lane entered against its own direction is not expanded at all.
  const d = dirDelta(lane.dir);
  const fwdId = lg.posToId.get(tileKey({ x: lane.pos.x + d.x, y: lane.pos.y + d.y }));
  if (fwdId !== undefined) {
    const next = lg.getLane(fwdId);
    if (next !== undefined && next.dir === lane.dir && next.dir !== dirOpposite(lane.dir)) {
      f(fwdId, laneEdgeCost(ctx, lg, fwdId));
    }
  }

  for (const side of [dirLeft(lane.dir), dirRight(lane.dir)]) {
    if (side === 'None') continue;
    const sd = dirDelta(side);
    const sideId = lg.posToId.get(tileKey({ x: lane.pos.x + sd.x, y: lane.pos.y + sd.y }));
    if (sideId === undefined) continue;
    const sideLane = lg.getLane(sideId);
    if (sideLane !== undefined && sideLane.dir === lane.dir && sideLane.dir !== dirOpposite(lane.dir)) {
      f(sideId, satAddU32(laneEdgeCost(ctx, lg, sideId), f32ToU32(Math.fround(ctx.cfg.laneChangePenalty))));
    }
  }

  for (const llid of llg.laneletsFrom(idx)) {
    const ll = llg.get(llid);
    if (ll === undefined) continue;
    const internal = satMulU32(ll.internalPath.length, baseTileCost(lane.kind, ctx.cfg));
    const cost = satAddU32(
      satAddU32(f32ToU32(Math.fround(ctx.cfg.turnPenalty)), internal),
      laneJitter(ctx.jitterSeed, llid),
    );
    f(space.roadLen + llid, cost);
  }
}

/** A lanelet stands at the last tile of its internal path; under-counting the EXIT step keeps it admissible. */
function combinedHeuristic(space: NodeSpace, idx: number, lg: LaneGraph, llg: LaneletGraph, goal: TilePos): number {
  const pos =
    idx < space.roadLen ? lg.getLane(idx)?.pos : llg.get(idx - space.roadLen)?.internalPath.at(-1);
  return pos === undefined ? U32_MAX : heuristicTiles(pos, goal);
}

/** A* over the combined graph; the node path from start road lane to goal road lane, or `undefined`. */
export function findCombinedPath(
  lg: LaneGraph,
  llg: LaneletGraph,
  ctx: LaneCostCtx,
  start: number,
  goal: number,
): CombinedNode[] | undefined {
  if (start === goal) return [roadNode(start)];
  const goalPos = lg.getLane(goal)?.pos;
  if (goalPos === undefined) return undefined;

  const space = new NodeSpace(lg);
  const n = space.len(llg);
  const cameFrom = new Int32Array(n).fill(-1);
  const bestG = new Uint32Array(n).fill(U32_MAX);
  const open = new OpenSet();

  bestG[start] = 0;
  open.push(combinedHeuristic(space, start, lg, llg, goalPos), 0, start);
  while (open.size > 0) {
    const [g, idx] = open.pop();
    if (g !== bestG[idx]) continue;
    if (idx === goal) {
      const path = [space.unpack(goal)];
      for (let cur = goal; cur !== start; ) {
        const prev = cameFrom[cur]!;
        if (prev < 0) break;
        path.push(space.unpack(prev));
        cur = prev;
      }
      return path.reverse();
    }
    forEachSucc(space, idx, lg, llg, ctx, (succ, step) => {
      const ng = satAddU32(g, step);
      if (ng < bestG[succ]!) {
        bestG[succ] = ng;
        cameFrom[succ] = idx;
        open.push(satAddU32(ng, combinedHeuristic(space, succ, lg, llg, goalPos)), ng, succ);
      }
    });
  }
  return undefined;
}

/** Node path -> tile route plus the lanelet sidecar; a repeated seam tile is dropped. */
export function flatten(nodes: readonly CombinedNode[], lg: LaneGraph, llg: LaneletGraph): Route {
  const tiles: TilePos[] = [];
  const sidecar: SidecarEntry[] = [];
  const push = (p: TilePos) => {
    const last = tiles[tiles.length - 1];
    if (last === undefined || last.x !== p.x || last.y !== p.y) tiles.push(p);
  };
  for (const node of nodes) {
    if (node.kind === 'Road') {
      const lane = lg.getLane(node.id);
      if (lane !== undefined) push(lane.pos);
    } else {
      const ll = llg.get(node.id);
      if (ll === undefined) continue;
      sidecar.push([tiles.length, ll.intersection, ll.id]);
      for (const tile of ll.internalPath) push(tile);
    }
  }
  return { tiles, sidecar };
}

/** Cardinal step from `a` to its 4-adjacent neighbour `b`; `None` otherwise. */
export function dirBetweenAdjacent(a: TilePos, b: TilePos): RoadDir {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 1 && dy === 0) return 'East';
  if (dx === -1 && dy === 0) return 'West';
  if (dx === 0 && dy === 1) return 'North';
  if (dx === 0 && dy === -1) return 'South';
  return 'None';
}

/**
 * First pair that leaves `a` against `a`'s lane direction or enters `b` against `b`'s. Box tiles
 * (`dir == None`) are exempt; the `b` check closes the box-exit-onto-oncoming blind spot.
 */
export function firstOncomingPair(route: readonly TilePos[], grid: MapGrid): readonly [TilePos, TilePos] | undefined {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const step = dirBetweenAdjacent(a, b);
    if (step === 'None') continue;
    const ca = grid.get(a);
    if (ca !== undefined && ca.road.dir !== 'None' && step === dirOpposite(ca.road.dir)) return [a, b];
    const cb = grid.get(b);
    if (cb !== undefined && roadCellIsSome(cb.road) && cb.road.dir !== 'None' && step === dirOpposite(cb.road.dir)) {
      return [a, b];
    }
  }
  return undefined;
}

export function routeIsDirectionCorrect(route: readonly TilePos[], grid: MapGrid): boolean {
  return firstOncomingPair(route, grid) === undefined;
}

/**
 * The spawn-time routing seam: combined A*, flattened. An empty route tells the caller to fall back
 * to road-A*; a route with an oncoming step is dropped (Rust release behaviour; debug asserts).
 */
export function findRoute(lg: LaneGraph, llg: LaneletGraph, ctx: LaneCostCtx, start: number, goal: number): Route {
  const nodes = findCombinedPath(lg, llg, ctx, start, goal);
  if (nodes === undefined) return { tiles: [], sidecar: [] };
  const route = flatten(nodes, lg, llg);
  return routeIsDirectionCorrect(route.tiles, ctx.grid) ? route : { tiles: [], sidecar: [] };
}
