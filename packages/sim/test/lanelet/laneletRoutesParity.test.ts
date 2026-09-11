// Stage 1c gate, which closes the stage 1 program gate: on the Rust test city the TS lanelets,
// conflict matrices and `find_route` (tiles and sidecar) on 200 seeded lane pairs equal what Rust
// computes (fixture from examples/dump_lanelet_routes.rs; the grid comes from road-routes.json).
import { describe, expect, it } from 'vitest';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { findRoute } from '../../src/transport/lanelet/pathfinding';
import fixture from '../fixtures/lanelet-routes.json';
import { loadTestCity } from '../testCity';

/** A TS row of 32-bit words as the Rust row of 64-bit words, each 16 hex digits. */
function u64Words(row: Uint32Array, n: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < Math.ceil(n / 64); k++) {
    const hi = row[2 * k + 1] ?? 0;
    const lo = row[2 * k] ?? 0;
    out.push(hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
  }
  return out;
}

function firstMismatch<T>(actual: readonly T[], expected: readonly T[]): number {
  const len = Math.max(actual.length, expected.length);
  for (let i = 0; i < len; i++) {
    if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) return i;
  }
  return -1;
}

describe('lanelet parity with Rust on the test city', () => {
  const w = loadTestCity();

  it('sameCityAndPathfindingConfig', () => {
    expect(w.graphVersion).toBe(fixture.graphVersion);
    expect(w.laneGraph.lanes.length).toBe(fixture.laneCount);
    expect(w.pathfindingConfig.laneChangePenalty).toBe(fixture.laneChangePenalty);
    expect(w.pathfindingConfig.turnPenalty).toBe(fixture.turnPenalty);
    expect(w.pathfindingConfig.costScale).toBe(fixture.costScale);
  });

  it('laneletsMatchRust', () => {
    const actual = w.laneletGraph.lanelets.map((l) => ({
      intersection: l.intersection,
      entry: l.entryLane,
      exit: l.exitLane,
      maneuver: l.maneuver,
      path: l.internalPath.flatMap((p) => [p.x, p.y]),
    }));
    const i = firstMismatch(actual, fixture.lanelets);
    expect(i, `lanelet ${i}: ts ${JSON.stringify(actual[i])} vs rust ${JSON.stringify(fixture.lanelets[i])}`).toBe(-1);
    expect(actual.length).toBeGreaterThan(100);
  });

  it('conflictMatricesMatchRust', () => {
    expect(w.laneletConflicts.byIntersection.size).toBe(fixture.matrices.length);
    for (const expected of fixture.matrices) {
      const m = w.laneletConflicts.byIntersection.get(expected.intersection);
      expect(m, `matrix of intersection ${expected.intersection}`).toBeDefined();
      const actual = {
        intersection: expected.intersection,
        crosswalkBase: m!.crosswalkBase(),
        sides: w.laneletConflicts.crosswalkSides.get(expected.intersection),
        rows: Array.from({ length: m!.len() }, (_, r) => u64Words(m!.row(r), m!.len())),
      };
      expect(actual).toEqual(expected);
    }
  });

  it('findRouteMatchesRustOnTestCity', () => {
    const traffic = new TrafficOccupancy();
    let throughLanelets = 0;
    let routed = 0;
    fixture.routes.forEach((route, i) => {
      const ctx = { grid: w.grid, traffic, cfg: w.pathfindingConfig, jitterSeed: BigInt(route.seed) };
      const { tiles, sidecar } = findRoute(w.laneGraph, w.laneletGraph, ctx, route.start, route.goal);
      const actual = { tiles: tiles.flatMap((p) => [p.x, p.y]), sidecar: sidecar.flat() };
      expect(actual, `pair ${i}: lane ${route.start} -> ${route.goal}, seed ${route.seed}`).toEqual({
        tiles: route.tiles,
        sidecar: route.sidecar,
      });
      if (route.tiles.length > 2) routed++;
      if (route.sidecar.length > 0) throughLanelets++;
    });
    expect(routed, 'the fixture must exercise real routes').toBeGreaterThan(100);
    expect(throughLanelets, 'and routes through intersections').toBeGreaterThan(50);
  });
});
