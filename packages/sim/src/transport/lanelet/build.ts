// Port of crates/simcity_sim/src/game/transport/lanelet/build.rs: lanelets (legal entry-lane ->
// exit-lane maneuvers through an intersection box), their rectangular in-box paths and the
// per-intersection conflict matrices with pedestrian crosswalk rows.
import type { RoadCell, RoadDir, TilePos } from '../../commands';
import type { IntersectionCluster, IntersectionIndex } from '../../intersections/index';
import { tileKey, type MapGrid } from '../../map/grid';
import { dirDelta, dirOpposite, isLeftmostForDir, isRightmostForDir, roadCellIsSome } from '../../map/roads';
import type { TrafficConfig } from '../../traffic/config';
import { maneuverKind, type ManeuverKind } from '../../traffic/maneuver';
import type { World } from '../../world';
import type { LaneGraph } from '../laneGraph';
import { ConflictMatrix } from './conflict';
import { LaneletGraph, type Lanelet } from './graph';

/** Side and neighbour scan order of the Rust build. */
const SIDES: readonly RoadDir[] = ['West', 'East', 'South', 'North'];
/** `bfs_within` neighbour order: W, E, S, N. */
const BFS_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const EMPTY_ROW = new Uint32Array(0);

const samePos = (a: TilePos, b: TilePos) => a.x === b.x && a.y === b.y;

/** The tiles of an intersection box with O(1) membership (Rust: `HashSet<TilePos>`). */
export class TileSet {
  readonly tiles: readonly TilePos[];
  private readonly keys = new Set<number>();

  constructor(tiles: Iterable<TilePos>) {
    const unique: TilePos[] = [];
    for (const tile of tiles) {
      const key = tileKey(tile);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      unique.push(tile);
    }
    this.tiles = unique;
  }

  has(pos: TilePos): boolean {
    return this.keys.has(tileKey(pos));
  }
}

export class LaneletConflictMatrices {
  byIntersection = new Map<number, ConflictMatrix>();
  /** Crosswalk sides per intersection in emission order: index `i` is row `crosswalkBase() + i`. */
  crosswalkSides = new Map<number, RoadDir[]>();
  version = 0;

  /** Conflict row of local lanelet `localIdx`; empty (never overlaps) when absent. */
  rowFor(id: number, localIdx: number): Uint32Array {
    return this.byIntersection.get(id)?.row(localIdx) ?? EMPTY_ROW;
  }
}

/**
 * Lane discipline (ПДД 8.5): turn-only lanes feed their turn (LeftTurnOnly also the U-turn); a
 * Regular lane turns across the oncoming flow and U-turns only from the centerline lane, turns
 * near-side only from the curb lane, and goes straight from any lane.
 */
export function laneAllowsManeuver(maneuver: ManeuverKind, cell: RoadCell, driveOnRight: boolean): boolean {
  switch (cell.laneType) {
    case 'LeftTurnOnly':
      return maneuver === 'LeftTurn' || maneuver === 'UTurn';
    case 'RightTurnOnly':
      return maneuver === 'RightTurn';
    case 'StraightOnly':
      return maneuver === 'Straight';
    case 'Regular': {
      const nearCenterline = isLeftmostForDir(cell);
      const nearCurb = isRightmostForDir(cell);
      const crossingTurnOk = driveOnRight ? nearCenterline : nearCurb;
      const nearTurnOk = driveOnRight ? nearCurb : nearCenterline;
      if (maneuver === 'Straight') return true;
      if (maneuver === 'LeftTurn' || maneuver === 'UTurn') return crossingTurnOk;
      if (maneuver === 'RightTurn') return nearTurnOk;
      return false;
    }
  }
}

/**
 * In-box path from `entryTile` to the tile feeding the exit lane (`exitTile - exitDir`), so the
 * route lands on the same-direction exit lane. Straights take the shortest in-box path; turns take
 * the rectangular ПДД trajectory (Г for turns, П around the box center for U-turns) and fall back to
 * the shortest in-box path. `undefined` when the entry or the feeder is outside the box, or `Other`.
 * `_centroid` is kept for parity with the Rust signature; the pivot is the box's float center.
 */
export function buildInternalPath(
  cluster: TileSet,
  _centroid: TilePos,
  entryTile: TilePos,
  entryDir: RoadDir,
  exitTile: TilePos,
  exitDir: RoadDir,
  maneuver: ManeuverKind,
): TilePos[] | undefined {
  if (!cluster.has(entryTile)) return undefined;
  const xd = dirDelta(exitDir);
  const goal = { x: exitTile.x - xd.x, y: exitTile.y - xd.y };
  if (!cluster.has(goal)) return undefined;
  switch (maneuver) {
    case 'Straight':
      return bfsWithin(cluster, entryTile, goal);
    case 'RightTurn':
    case 'LeftTurn':
    case 'UTurn':
      return manhattanTurnPath(cluster, entryTile, entryDir, goal, maneuver) ?? bfsWithin(cluster, entryTile, goal);
    case 'Other':
      return undefined;
  }
}

/** Г for left/right turns (entry axis to the goal's cross coordinate, then the exit axis); П for U-turns. */
function manhattanTurnPath(
  cluster: TileSet,
  entry: TilePos,
  entryDir: RoadDir,
  goal: TilePos,
  maneuver: ManeuverKind,
): TilePos[] | undefined {
  if (samePos(entry, goal)) return [entry];
  const ed = dirDelta(entryDir);
  if (ed.x === 0 && ed.y === 0) return undefined;
  const vertical = ed.x === 0;

  const path: TilePos[] = [entry];
  let cur = entry;
  const stepTo = (dx: number, dy: number): boolean => {
    const next = { x: cur.x + dx, y: cur.y + dy };
    if (!cluster.has(next)) return false;
    path.push(next);
    cur = next;
    return true;
  };
  /** `n` steps along the entry axis (`alongEntry`) or across it, in the sign of `n`. */
  const walk = (n: number, alongEntry: boolean): boolean => {
    const s = Math.sign(n);
    const [dx, dy] = alongEntry === vertical ? [0, s] : [s, 0];
    for (let i = 0; i < Math.abs(n); i++) {
      if (!stepTo(dx, dy)) return false;
    }
    return true;
  };
  const entryForward = vertical ? ed.y : ed.x;

  if (maneuver === 'LeftTurn' || maneuver === 'RightTurn') {
    const leg1 = vertical ? goal.y - entry.y : goal.x - entry.x;
    const leg2 = vertical ? goal.x - entry.x : goal.y - entry.y;
    if (leg1 !== 0 && Math.sign(leg1) !== Math.sign(entryForward)) return undefined;
    if (!walk(leg1, true) || !walk(leg2, false)) return undefined;
  } else if (maneuver === 'UTurn') {
    const [cx, cy] = boxCenterPoint(cluster);
    const passed = (p: TilePos): boolean => {
      if (vertical) return ed.y > 0 ? p.y + 0.5 > cy : p.y + 0.5 < cy;
      return ed.x > 0 ? p.x + 0.5 > cx : p.x + 0.5 < cx;
    };
    while (!passed(cur)) {
      if (!stepTo(ed.x, ed.y)) return undefined;
    }
    if (!walk(vertical ? goal.x - cur.x : goal.y - cur.y, false)) return undefined;
    const back = vertical ? goal.y - cur.y : goal.x - cur.x;
    if (back !== 0 && Math.sign(back) === Math.sign(entryForward)) return undefined;
    if (!walk(back, true)) return undefined;
  } else {
    return undefined;
  }

  return samePos(cur, goal) ? path : undefined;
}

/** Mean of the tile centers: for an N×N box the vertex where the central tiles meet. */
function boxCenterPoint(cluster: TileSet): readonly [number, number] {
  const n = Math.max(cluster.tiles.length, 1);
  let sx = 0;
  let sy = 0;
  for (const tile of cluster.tiles) {
    sx += tile.x + 0.5;
    sy += tile.y + 0.5;
  }
  return [sx / n, sy / n];
}

/** Shortest 4-adjacent in-box path, both ends included; neighbours W, E, S, N, ties by insertion. */
function bfsWithin(cluster: TileSet, from: TilePos, to: TilePos): TilePos[] | undefined {
  if (samePos(from, to)) return [from];
  const prev = new Map<number, TilePos>();
  const seen = new Set<number>([tileKey(from)]);
  const queue: TilePos[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const [dx, dy] of BFS_STEPS) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      const key = tileKey(next);
      if (!cluster.has(next) || seen.has(key)) continue;
      seen.add(key);
      prev.set(key, cur);
      if (samePos(next, to)) {
        const path = [to];
        let step = to;
        for (let p = prev.get(tileKey(step)); p !== undefined; p = prev.get(tileKey(step))) {
          path.push(p);
          step = p;
          if (samePos(p, from)) break;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return undefined;
}

export interface Crosswalk {
  /** Local index within the cluster, in emission order. */
  readonly id: number;
  /** The cluster side the crosswalk faces. */
  readonly side: RoadDir;
  /** Boundary cells facing that side, sorted by (x, y). */
  readonly cells: TilePos[];
}

/** One crosswalk per cluster side with an adjacent road tile (any flow direction), sides W, E, S, N. */
export function crosswalkCells(cluster: IntersectionCluster, grid: MapGrid): Crosswalk[] {
  const inCluster = new TileSet(cluster.tiles);
  const out: Crosswalk[] = [];
  for (const side of SIDES) {
    const d = dirDelta(side);
    const cells: TilePos[] = [];
    for (const tile of cluster.tiles) {
      const n = { x: tile.x + d.x, y: tile.y + d.y };
      if (inCluster.has(n)) continue;
      const cell = grid.get(n);
      if (cell === undefined || cell.water || !roadCellIsSome(cell.road) || cell.road.dir === 'None') continue;
      cells.push(tile);
    }
    if (cells.length === 0) continue;
    cells.sort((a, b) => a.x - b.x || a.y - b.y);
    out.push({ id: out.length, side, cells });
  }
  return out;
}

interface ApproachTile {
  readonly pos: TilePos;
  /** Approach: the first cluster tile the lane points into. */
  readonly first: TilePos;
  readonly dir: RoadDir;
  readonly cell: RoadCell;
}

function dedupByPos<T extends { readonly pos: TilePos }>(tiles: T[]): T[] {
  tiles.sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y);
  return tiles.filter((tile, i) => i === 0 || !samePos(tiles[i - 1]!.pos, tile.pos));
}

/** `build_lanelet_graph` without the version guard: builds a fresh graph and matrices. */
export function buildLaneletGraphInner(
  grid: MapGrid,
  intersections: IntersectionIndex,
  lanes: LaneGraph,
  graphVersion: number,
  cfg: TrafficConfig,
): { graph: LaneletGraph; matrices: LaneletConflictMatrices } {
  const graph = new LaneletGraph();
  const matrices = new LaneletConflictMatrices();

  for (const cluster of intersections.clusters) {
    const clusterTiles = new TileSet(cluster.tiles);

    let entries: ApproachTile[] = [];
    let exits: ApproachTile[] = [];
    for (const tile of cluster.tiles) {
      for (const side of SIDES) {
        const d = dirDelta(side);
        const pos = { x: tile.x + d.x, y: tile.y + d.y };
        const cell = grid.get(pos);
        if (cell === undefined || cell.water || !roadCellIsSome(cell.road) || cell.road.dir === 'None') continue;
        const road = cell.road;
        if (road.flow.kind === 'OneWay' && road.dir !== road.flow.dir) continue;
        if (clusterTiles.has(pos)) continue;

        const ld = dirDelta(road.dir);
        const fwd = { x: pos.x + ld.x, y: pos.y + ld.y };
        const back = { x: pos.x - ld.x, y: pos.y - ld.y };
        if (clusterTiles.has(fwd)) entries.push({ pos, first: fwd, dir: road.dir, cell: road });
        else if (clusterTiles.has(back)) exits.push({ pos, first: back, dir: road.dir, cell: road });
      }
    }
    entries = dedupByPos(entries);
    exits = dedupByPos(exits);

    const pending: Array<Omit<Lanelet, 'id'>> = [];
    for (const entry of entries) {
      const entryLane = lanes.posToId.get(tileKey(entry.pos));
      if (entryLane === undefined) continue;
      for (const exit of exits) {
        const exitLane = lanes.posToId.get(tileKey(exit.pos));
        if (exitLane === undefined || entryLane === exitLane) continue;

        const maneuver = maneuverKind(cfg, entry.dir, exit.dir);
        // A straight keeps its lane through the box whenever the same-index exit exists.
        if (maneuver === 'Straight' && exit.cell.kind === entry.cell.kind && exit.cell.lane !== entry.cell.lane) {
          const hasSameLaneExit = exits.some(
            (o) => o.dir === entry.dir && o.cell.kind === entry.cell.kind && o.cell.lane === entry.cell.lane,
          );
          if (hasSameLaneExit) continue;
        }
        if (!laneAllowsManeuver(maneuver, entry.cell, cfg.driveOnRight)) continue;

        const internalPath = buildInternalPath(
          clusterTiles,
          cluster.centroidTile,
          entry.first,
          entry.dir,
          exit.pos,
          exit.dir,
          maneuver,
        );
        if (internalPath === undefined) continue;
        pending.push({ intersection: cluster.id, entryLane, exitLane, maneuver, internalPath });
      }
    }

    pending.sort((a, b) => a.entryLane - b.entryLane || a.exitLane - b.exitLane);
    const ids: number[] = [];
    for (const lanelet of pending) {
      const id = graph.lanelets.length;
      ids.push(id);
      const fromLane = graph.byEntryLane.get(lanelet.entryLane);
      if (fromLane === undefined) graph.byEntryLane.set(lanelet.entryLane, [id]);
      else fromLane.push(id);
      graph.lanelets.push({ id, ...lanelet });
    }
    graph.byIntersection.set(cluster.id, ids);

    const crosswalks = crosswalkCells(cluster, grid);
    const matrix = ConflictMatrix.fromPathsWithCrosswalks(
      pending.map((l) => l.internalPath),
      crosswalks.map((c) => c.cells),
    );
    // ПДД 13.12: a left or U turn yields to the oncoming straight and right turn even when the
    // compact trajectories share no tile.
    pending.forEach((a, i) => {
      if (a.maneuver !== 'LeftTurn' && a.maneuver !== 'UTurn') return;
      const dirA = lanes.getLane(a.entryLane)?.dir;
      if (dirA === undefined) return;
      pending.forEach((b, j) => {
        if (b.maneuver !== 'Straight' && b.maneuver !== 'RightTurn') return;
        const dirB = lanes.getLane(b.entryLane)?.dir;
        if (dirB !== undefined && dirB === dirOpposite(dirA)) matrix.addConflictPair(i, j);
      });
    });
    matrices.byIntersection.set(cluster.id, matrix);
    matrices.crosswalkSides.set(
      cluster.id,
      crosswalks.map((c) => c.side),
    );
  }

  graph.version = graphVersion;
  graph.builtFor = graphVersion;
  graph.builtDims = [grid.width, grid.height];
  matrices.version = graphVersion;
  return { graph, matrices };
}

/** `build_lanelet_graph` (FixedUpdate / GraphUpdate): early-returns when built for the current version. */
export function buildLaneletGraph(w: World): void {
  if (w.laneletGraph.isBuiltFor(w.graphVersion, w.grid)) return;
  const { graph, matrices } = buildLaneletGraphInner(
    w.grid,
    w.intersections,
    w.laneGraph,
    w.graphVersion,
    w.trafficConfig,
  );
  w.laneletGraph = graph;
  w.laneletConflicts = matrices;
}
