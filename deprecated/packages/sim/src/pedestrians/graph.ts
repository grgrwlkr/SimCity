// Port of crates/simcity_sim/src/game/pedestrians/graph.rs and config.rs. A walker walks the lane tile beside a kerb and
// crosses a road through a box; Rust walked the tile beside the road. So the walkable tiles here are the boxes and the kerb
// lanes, except along a six-lane road, which carries no pavement: there only the lane tile beside a box is a corner to
// cross from. The walker's path search reads this graph (`walkers.ts`).
import { ROAD_KINDS } from '../commands';
import type { TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import type { World } from '../world';

const SIX_LANE = ROAD_KINDS.indexOf('SixLane');

/** Pedestrian knobs the walkers read; the walking speed lives in `CitizenConfig.walkKmh`. */
export interface PedestrianConfig {
  /** A walker held this long at an uncontrolled crossing looks for another way, game seconds. */
  waitRerouteSecs: number;
  /** Past this many other ways a walker crosses without waiting. */
  waitRerouteMaxAttempts: number;
  /** Uncontrolled crossing: added to the time a walker takes to cross a tile. */
  uncontrolledSafetyMarginSecs: number;
  /** Uncontrolled crossing: a car this near the box holds a walker whatever its speed, tiles. */
  uncontrolledMinGapTiles: number;
}

/**
 * The shipped knobs (rust-final:assets/config/pedestrians.ron). Rust waited `wait_reroute_hours: 6.0` on a clock of a
 * second an hour, six real seconds; on the real-time clock six game hours at a kerb would be absurd, so the wait is a
 * game minute.
 */
export const defaultPedestrianConfig = (): PedestrianConfig => ({
  waitRerouteSecs: 60,
  waitRerouteMaxAttempts: 3,
  uncontrolledSafetyMarginSecs: 0.5,
  uncontrolledMinGapTiles: 0.35,
});

/** `PedestrianGraph.walk` values. */
export const WALK_NONE = 0;
export const WALK_PAVEMENT = 1;
export const WALK_CORNER = 2;
export const WALK_BOX = 3;

export class PedestrianGraph {
  /** The graph version it was built for; `null` = never. */
  builtFor: number | null = null;
  width = 0;
  height = 0;
  /** Per tile: `WALK_NONE`, `WALK_PAVEMENT`, `WALK_CORNER` or `WALK_BOX`. */
  walk = new Uint8Array(0);

  isBuiltFor(version: number, width: number, height: number): boolean {
    return this.builtFor === version && this.width === width && this.height === height;
  }

  isWalkable(pos: TilePos): boolean {
    if (pos.x < 0 || pos.y < 0 || pos.x >= this.width || pos.y >= this.height) return false;
    return this.walk[pos.y * this.width + pos.x] !== WALK_NONE;
  }
}

const isBoxAt = (grid: MapGrid, i: number) => grid.roadKind[i] !== 0 && grid.roadDir[i] === 0 && grid.water[i] === 0;

export function buildPedestrianGraph(w: World): PedestrianGraph {
  const grid = w.grid;
  const [width, height] = [grid.width, grid.height];
  const g = new PedestrianGraph();
  g.builtFor = w.graphVersion;
  g.width = width;
  g.height = height;
  g.walk = new Uint8Array(width * height);
  const road = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && grid.roadKind[y * width + x] !== 0;
  const box = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && isBoxAt(grid, y * width + x);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      if (grid.roadKind[i] === 0 || grid.water[i] !== 0) continue;
      if (grid.roadDir[i] === 0) {
        g.walk[i] = WALK_BOX;
        continue;
      }
      const kerb = !road(x, y + 1) || !road(x, y - 1) || !road(x + 1, y) || !road(x - 1, y);
      if (!kerb) continue;
      if (grid.roadKind[i] !== SIX_LANE) g.walk[i] = WALK_PAVEMENT;
      else if (box(x - 1, y) || box(x + 1, y) || box(x, y - 1) || box(x, y + 1)) g.walk[i] = WALK_CORNER;
    }
  }
  return g;
}

/** `GraphUpdate`, after the meso graph: rebuilt when the roads changed. Walkers also call it before a path search. */
export function rebuildPedestrianGraph(w: World): void {
  if (w.pedestrianGraph.isBuiltFor(w.graphVersion, w.grid.width, w.grid.height)) return;
  w.pedestrianGraph = buildPedestrianGraph(w);
}
