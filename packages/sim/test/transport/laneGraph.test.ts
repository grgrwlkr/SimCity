// Ported from crates/simcity_sim/src/game/transport/tests.rs (lane graph version guard).
import { describe, expect, it } from 'vitest';
import { bumpVersion } from '../../src/map/dirty';
import { tileKey } from '../../src/map/grid';
import { buildLaneGraph } from '../../src/transport/laneGraph';
import { createWorld } from '../../src/world';
import { setRoad } from './helpers';

const SENTINEL = tileKey({ x: 99, y: 99 });

describe('lane graph', () => {
  it('laneGraphSkipsRebuildForUnchangedGraphVersion', () => {
    const w = createWorld({ mapWidth: 2, mapHeight: 1 });
    setRoad(w.grid, { x: 0, y: 0 }, { dir: 'East' });
    w.graphVersion = 3;

    buildLaneGraph(w);
    expect(w.laneGraph.isBuiltFor(3, w.grid)).toBe(true);

    w.laneGraph.posToId.set(SENTINEL, 777);
    buildLaneGraph(w);
    expect(w.laneGraph.posToId.has(SENTINEL), 'unchanged GraphVersion must not trigger a rebuild').toBe(true);

    w.graphVersion = bumpVersion(w.graphVersion);
    buildLaneGraph(w);
    expect(w.laneGraph.posToId.has(SENTINEL), 'a GraphVersion bump must rebuild (sentinel wiped)').toBe(false);
    expect(w.laneGraph.isBuiltFor(4, w.grid)).toBe(true);
  });

  /** A roadless map builds an empty lane graph that still counts as built, or it rebuilds every tick. */
  it('laneGraphEmptyBuildCountsAsBuilt', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.graphVersion = 3;

    buildLaneGraph(w);
    expect(w.laneGraph.lanes, 'roadless map builds an empty graph').toEqual([]);
    expect(w.laneGraph.isBuiltFor(3, w.grid), 'empty build still counts as built').toBe(true);

    w.laneGraph.posToId.set(SENTINEL, 777);
    buildLaneGraph(w);
    expect(w.laneGraph.posToId.has(SENTINEL), 'an empty-but-valid graph must not be rebuilt every tick').toBe(true);
  });
});
