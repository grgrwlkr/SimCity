// Stage 3½e: a city without micro traffic builds none of its lane geometry. The metropolis drives by meso only, and the
// lane graph and lanelets of its 800 tiles took 120 MB with no car to use them.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../src/app';
import { detectIntersections } from '../src/intersections/index';
import { applyGameCommandsToGrid } from '../src/map/apply';
import { roadSegmentCommands } from '../src/map/roadTool';
import { requestState } from '../src/state';
import { createWorld } from '../src/world';

function crossroads(microTraffic: boolean) {
  const w = createWorld({ mapWidth: 64, mapHeight: 32, microTraffic });
  requestState(w, 'InGame');
  frame(w, 0);
  for (const [from, to] of [
    [{ x: 1, y: 10 }, { x: 62, y: 10 }],
    [{ x: 30, y: 1 }, { x: 30, y: 30 }],
  ] as const) {
    applyGameCommandsToGrid(w, roadSegmentCommands(from, to, 'TwoLane', w.trafficConfig.driveOnRight, false));
  }
  detectIntersections(w);
  step(w, 3);
  return w;
}

describe('micro traffic', () => {
  it('aCityWithoutMicroTrafficBuildsNoLanelets', () => {
    const micro = crossroads(true);
    expect([micro.laneGraph.lanes.length > 0, micro.laneletGraph.lanelets.length > 0], 'a city with micro traffic builds them').toEqual([true, true]);

    const w = crossroads(false);
    expect([w.laneGraph.lanes.length, w.laneletGraph.lanelets.length], 'no lanes, no lanelets').toEqual([0, 0]);
    expect(w.meso.linkCount, 'the meso links are there').toBe(micro.meso.linkCount);
    expect(w.districtTimes.rowsBuilt(), 'and the district times').toBeGreaterThan(0);
    expect([...w.systemErrors.keys()]).toEqual([]);
  });
});
