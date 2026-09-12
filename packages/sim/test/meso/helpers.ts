// Worlds for the meso tests: roads laid with the road tool, as a player lays them, and every graph built.
import type { RoadKind, TilePos } from '../../src/commands';
import { detectIntersections } from '../../src/intersections/index';
import { applyGameCommandsToGrid } from '../../src/map/apply';
import { roadSegmentCommands } from '../../src/map/roadTool';
import { rebuildMesoGraph } from '../../src/meso/graph';
import { updateDistrictTimes } from '../../src/meso/districts';
import { rebuildRoadGraph } from '../../src/transport/roadGraph';
import { createWorld, type World } from '../../src/world';

export type RoadLine = readonly [from: TilePos, to: TilePos, kind: RoadKind];

export const t = (x: number, y: number): TilePos => ({ x, y });

/** Lays `roads` on `w`, then detects the boxes and rebuilds the road and meso graphs. */
export function layRoads(w: World, roads: readonly RoadLine[]): void {
  for (const [from, to, kind] of roads) applyGameCommandsToGrid(w, roadSegmentCommands(from, to, kind, w.trafficConfig.driveOnRight, false));
  detectIntersections(w);
  rebuildRoadGraph(w);
  rebuildMesoGraph(w);
}

export function roadWorld(width: number, height: number, roads: readonly RoadLine[]): World {
  const w = createWorld({ mapWidth: width, mapHeight: height });
  layRoads(w, roads);
  return w;
}

/** Runs the matrix update until every district's row is built for the current graph. */
export function buildAllRows(w: World): void {
  // At least once: before the first update there are no districts to count.
  let guard = 0;
  do updateDistrictTimes(w);
  while (w.districtTimes.rowsBuilt() < w.districtTimes.count && ++guard < 10_000);
}
