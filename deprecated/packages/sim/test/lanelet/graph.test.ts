// Ported from crates/simcity_sim/src/game/transport/lanelet/graph.rs (mod tests) and
// transport/tests.rs `lanelet_graph_empty_build_counts_as_built`.
import { describe, expect, it } from 'vitest';
import { MapGrid } from '../../src/map/grid';
import { buildLaneletGraph } from '../../src/transport/lanelet/build';
import { LaneletGraph } from '../../src/transport/lanelet/graph';
import { createWorld } from '../../src/world';

describe('lanelet graph', () => {
  it('emptyLaneletGraphReportsUnbuiltAndNoLanelets', () => {
    const g = new LaneletGraph();
    expect(g.isBuiltFor(1, new MapGrid(4, 4))).toBe(false);
    expect(g.get(0)).toBeUndefined();
    expect(g.ofIntersection(0)).toEqual([]);
  });

  it('laneletGraphEmptyBuildCountsAsBuilt', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.graphVersion = 3;
    buildLaneletGraph(w);
    expect(w.laneletGraph.lanelets).toEqual([]);
    expect(w.laneletGraph.isBuiltFor(3, w.grid), 'empty lanelet build still counts as built').toBe(true);

    w.laneletGraph.byEntryLane.set(42, []);
    buildLaneletGraph(w);
    expect(w.laneletGraph.byEntryLane.has(42), 'an empty-but-valid LaneletGraph must not be rebuilt every tick').toBe(
      true,
    );

    w.graphVersion += 1;
    buildLaneletGraph(w);
    expect(w.laneletGraph.byEntryLane.has(42), 'a graph version bump must rebuild the LaneletGraph').toBe(false);
    expect(w.laneletGraph.isBuiltFor(4, w.grid)).toBe(true);
  });
});
