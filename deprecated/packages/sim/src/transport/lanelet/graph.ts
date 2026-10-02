// Port of crates/simcity_sim/src/game/transport/lanelet/graph.rs.
import type { TilePos } from '../../commands';
import type { MapGrid } from '../../map/grid';
import type { ManeuverKind } from '../../traffic/maneuver';

export const LANELET_ID_INVALID = 0xffff_ffff;

const EMPTY: readonly number[] = [];

/** A directed path from one approach lane through an intersection cluster to an exit lane. */
export interface Lanelet {
  readonly id: number;
  readonly intersection: number;
  readonly entryLane: number;
  readonly exitLane: number;
  readonly maneuver: ManeuverKind;
  /** 4-adjacent cluster tiles from entry to the tile feeding the exit lane. */
  readonly internalPath: readonly TilePos[];
}

export class LaneletGraph {
  /** Index == lanelet id. */
  lanelets: Lanelet[] = [];
  byIntersection = new Map<number, number[]>();
  byEntryLane = new Map<number, number[]>();
  version = 0;
  /** Graph version this was built for; `null` = never. An empty build still counts as built. */
  builtFor: number | null = null;
  builtDims: readonly [number, number] | null = null;

  isBuiltFor(version: number, grid: MapGrid): boolean {
    return (
      this.builtFor === version &&
      this.builtDims !== null &&
      this.builtDims[0] === grid.width &&
      this.builtDims[1] === grid.height
    );
  }

  get(id: number): Lanelet | undefined {
    return this.lanelets[id];
  }

  ofIntersection(id: number): readonly number[] {
    return this.byIntersection.get(id) ?? EMPTY;
  }

  /** Lanelets whose entry lane is `laneId`, ascending by exit lane. */
  laneletsFrom(laneId: number): readonly number[] {
    return this.byEntryLane.get(laneId) ?? EMPTY;
  }
}
