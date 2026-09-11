// Port of crates/simcity_sim/src/game/transport/lane_graph.rs: one node per lane tile. Adjacency
// is derived on the fly by the lanelet planner.
import type { RoadDir, RoadKind, TilePos } from '../commands';
import { tileKey, type MapGrid } from '../map/grid';
import type { World } from '../world';

export interface Lane {
  readonly id: number;
  readonly pos: TilePos;
  /** Lane index within the carriageway cross-section. */
  readonly laneIdx: number;
  /** `None` for intersection cluster tiles. */
  readonly dir: RoadDir;
  readonly kind: RoadKind;
}

const laneKey = (pos: TilePos, laneIdx: number) => `${tileKey(pos)}:${laneIdx}`;

export class LaneGraph {
  /** Graph version this was built for; `null` = never. An empty build still counts as built. */
  builtFor: number | null = null;
  /** Grid size at build time, so a resize without a version bump still rebuilds. */
  builtDims: readonly [number, number] | null = null;
  lanes: Lane[] = [];
  /** `laneKey(pos, laneIdx)` -> lane id. */
  tileLaneToId = new Map<string, number>();
  /** `tileKey(pos)` -> lane id. */
  posToId = new Map<number, number>();

  isBuiltFor(version: number, grid: MapGrid): boolean {
    return (
      this.builtFor === version &&
      this.builtDims !== null &&
      this.builtDims[0] === grid.width &&
      this.builtDims[1] === grid.height
    );
  }

  getLane(id: number): Lane | undefined {
    return this.lanes[id];
  }

  getLaneId(pos: TilePos, laneIdx: number): number | undefined {
    return this.tileLaneToId.get(laneKey(pos, laneIdx));
  }
}

export function buildLaneGraphInner(grid: MapGrid, version: number): LaneGraph {
  const graph = new LaneGraph();
  graph.builtFor = version;
  graph.builtDims = [grid.width, grid.height];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      if (grid.roadKind[i] === 0) continue;
      const road = grid.cellAt(i).road;
      const pos = { x, y };
      const id = graph.lanes.length;
      graph.lanes.push({ id, pos, laneIdx: road.lane, dir: road.dir, kind: road.kind });
      graph.tileLaneToId.set(laneKey(pos, road.lane), id);
      graph.posToId.set(tileKey(pos), id);
    }
  }
  return graph;
}

/** `build_lane_graph` (FixedUpdate / GraphUpdate): early-returns when built for the current version. */
export function buildLaneGraph(w: World): void {
  if (w.laneGraph.isBuiltFor(w.graphVersion, w.grid)) return;
  w.laneGraph = buildLaneGraphInner(w.grid, w.graphVersion);
}
