// Port of crates/simcity_sim/src/game/transport/turn_lanes.rs: derived turn-lane marks. Turn-only
// dedication is reserved for must-turn approaches (no straight exit) with at least two lanes; where a
// straight exit exists every lane stays Regular and turns stay legal positionally (ПДД 8.5).
import type { RoadDir } from '../commands';
import { buildIntersectionClusters } from '../intersections/index';
import { tileKey, type MapGrid } from '../map/grid';
import { dirDelta, dirLeft, dirOpposite, dirRight, isLeftmostForDir, isRightmostForDir } from '../map/roads';
import type { World } from '../world';
import { isWrongWayOnOneWay } from './roadGraph';

const NEIGHBOUR_DIRS: readonly RoadDir[] = ['West', 'East', 'South', 'North'];

export function autogenTurnLanesInner(grid: MapGrid): void {
  // Reset old markings: roads may have changed.
  for (let i = 0; i < grid.len(); i++) {
    if (grid.water[i] === 0 && grid.roadKind[i] !== 0 && grid.roadDir[i] !== 0) grid.laneType[i] = 0;
  }

  const { clusters, tileToIntersection } = buildIntersectionClusters(grid);
  const exitDirsById = new Map<number, Set<RoadDir>>();
  const approaches = new Map<string, { id: number; dir: RoadDir; tiles: Map<number, { x: number; y: number }> }>();

  for (const cluster of clusters) {
    for (const t of cluster.tiles) {
      for (const neighbour of NEIGHBOUR_DIRS) {
        const d = dirDelta(neighbour);
        const npos = { x: t.x + d.x, y: t.y + d.y };
        const ncell = grid.get(npos);
        if (ncell === undefined || ncell.water || ncell.road.kind === 'None' || ncell.road.dir === 'None') continue;
        if (isWrongWayOnOneWay(ncell.road)) continue;

        const dir = ncell.road.dir;
        const fwd = dirDelta(dir);
        const back = dirDelta(dirOpposite(dir));
        if (tileToIntersection.get(tileKey({ x: npos.x + fwd.x, y: npos.y + fwd.y })) === cluster.id) {
          const key = `${cluster.id}|${dir}`;
          let entry = approaches.get(key);
          if (entry === undefined) {
            entry = { id: cluster.id, dir, tiles: new Map() };
            approaches.set(key, entry);
          }
          entry.tiles.set(tileKey(npos), npos);
        } else if (tileToIntersection.get(tileKey({ x: npos.x + back.x, y: npos.y + back.y })) === cluster.id) {
          let exits = exitDirsById.get(cluster.id);
          if (exits === undefined) {
            exits = new Set();
            exitDirsById.set(cluster.id, exits);
          }
          exits.add(dir);
        }
      }
    }
  }

  for (const { id, dir: entryDir, tiles } of approaches.values()) {
    const exitDirs = exitDirsById.get(id);
    if (exitDirs === undefined || tiles.size <= 1) continue;
    const hasStraight = exitDirs.has(entryDir);
    const hasLeft = exitDirs.has(dirLeft(entryDir));
    const hasRight = exitDirs.has(dirRight(entryDir));

    for (const pos of tiles.values()) {
      const cell = grid.get(pos);
      if (cell === undefined || cell.water || cell.road.kind === 'None' || cell.road.dir !== entryDir) continue;
      let next: 'Regular' | 'LeftTurnOnly' | 'RightTurnOnly' = 'Regular';
      if (!hasStraight) {
        if (isLeftmostForDir(cell.road) && hasLeft) next = 'LeftTurnOnly';
        else if (isRightmostForDir(cell.road) && hasRight) next = 'RightTurnOnly';
      }
      if (cell.road.laneType !== next) grid.set(pos, { ...cell, road: { ...cell.road, laneType: next } });
    }
  }
}

/** `autogen_turn_lanes` (FixedUpdate / GraphUpdate): once per graph version, before the road graph. */
export function autogenTurnLanes(w: World): void {
  if (w.turnLaneAutogenVersion === w.graphVersion) return;
  w.turnLaneAutogenVersion = w.graphVersion;
  autogenTurnLanesInner(w.grid);
}
