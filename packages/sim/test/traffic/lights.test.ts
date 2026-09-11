// Ported from crates/simcity_sim/src/game/intersections/lights.rs (tests_protected_left, tests_persist).
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import {
  IntersectionIndex,
  buildIntersectionClusters,
  intersectionKeyString,
} from '../../src/intersections/index';
import { MapGrid, tileKey } from '../../src/map/grid';
import { roadCellNone } from '../../src/map/roads';
import { nextLightPhase, type LightPhase } from '../../src/traffic/lights';

describe('traffic light cycle', () => {
  it('lightCycleActuatesProtectedLeftOnlyOnDemand', () => {
    const seq: LightPhase[] = ['NorthSouthGreen'];
    for (let i = 0; i < 6; i++) seq.push(nextLightPhase(seq[seq.length - 1]!, false, false));
    expect(seq).toEqual([
      'NorthSouthGreen',
      'NorthSouthYellow',
      'AllRedToEastWest',
      'EastWestGreen',
      'EastWestYellow',
      'AllRedToNorthSouth',
      'NorthSouthGreen',
    ]);
    expect(nextLightPhase('AllRedToNorthSouth', true, false)).toBe('NorthSouthLeftProtected');
    expect(nextLightPhase('NorthSouthLeftProtected', true, false)).toBe('NorthSouthGreen');
    expect(nextLightPhase('AllRedToEastWest', false, true)).toBe('EastWestLeftProtected');
    expect(nextLightPhase('AllRedToNorthSouth', false, false)).toBe('NorthSouthGreen');
    expect(nextLightPhase('AllRedToEastWest', false, false)).toBe('EastWestGreen');
  });
});

describe('traffic light persistence', () => {
  function gridWithIntersection(): MapGrid {
    const grid = new MapGrid(3, 3);
    const road = (dir: 'None' | 'North' | 'South' | 'East' | 'West') => ({ ...roadCellNone(), kind: 'TwoLane' as const, dir });
    const put = (pos: TilePos, dir: Parameters<typeof road>[0]) => grid.set(pos, { ...grid.get(pos)!, road: road(dir) });
    put({ x: 1, y: 1 }, 'None');
    put({ x: 1, y: 0 }, 'South');
    put({ x: 1, y: 2 }, 'North');
    put({ x: 0, y: 1 }, 'East');
    put({ x: 2, y: 1 }, 'West');
    return grid;
  }

  /** Mirror of `snapshot_traffic_lights` in persistence.rs: first tile of each lit cluster, by (y, x). */
  function snapshotLights(index: IntersectionIndex): TilePos[] {
    return [...index.trafficLights]
      .flatMap((id) => {
        const first = index.clusterById(id)?.tiles[0];
        return first === undefined ? [] : [first];
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  it('userLightSurvivesSnapshotAndRestore', () => {
    const grid = gridWithIntersection();
    const { clusters, tileToIntersection } = buildIntersectionClusters(grid);
    const center = { x: 1, y: 1 };
    const id = tileToIntersection.get(tileKey(center));
    expect(id, 'center tile must map to an intersection').toBeDefined();

    const index = new IntersectionIndex();
    index.clusters = clusters;
    index.tileToIntersection = tileToIntersection;
    index.trafficLightKeys.add(intersectionKeyString(clusters[id!]!.key));
    index.trafficLights.add(id!);

    const saved = snapshotLights(index);
    expect(saved.length, 'expected exactly one light tile').toBe(1);
    expect(tileToIntersection.has(tileKey(saved[0]!)), 'representative tile is an intersection tile').toBe(true);

    const rebuilt = buildIntersectionClusters(grid);
    const restored = new IntersectionIndex();
    restored.clusters = rebuilt.clusters;
    restored.tileToIntersection = rebuilt.tileToIntersection;
    for (const pos of saved) {
      const rid = rebuilt.tileToIntersection.get(tileKey(pos));
      const cluster = rid === undefined ? undefined : restored.clusters[rid];
      if (cluster !== undefined) restored.trafficLightKeys.add(intersectionKeyString(cluster.key));
    }
    restored.trafficLights = new Set(
      restored.clusters.filter((c) => restored.trafficLightKeys.has(intersectionKeyString(c.key))).map((c) => c.id),
    );

    expect(restored.hasTrafficLightAt(center), 'center tile must have a traffic light after restore').toBe(true);
    expect(restored.trafficLightKeys.size, 'exactly one light key must survive restore').toBe(1);
  });
});
