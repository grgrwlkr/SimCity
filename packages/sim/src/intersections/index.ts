// Port of crates/simcity_sim/src/game/intersections/index.rs: intersections are flood-filled
// clusters of `dir == None` road tiles. Traffic lights are stored by a stable key so they survive
// graph rebuilds; placing and running them arrives with the traffic stage.
import type { TilePos } from '../commands';
import { tileKey, type MapGrid } from '../map/grid';
import type { World } from '../world';

const MASK64 = (1n << 64n) - 1n;

export interface IntersectionKey {
  readonly aabbMin: TilePos;
  readonly aabbMax: TilePos;
  readonly tileCount: number;
  /** Wrapping `hash * 31 + coord` over the tiles sorted by (y, x). */
  readonly tilesHash: bigint;
}

export interface IntersectionCluster {
  /** Stable only within one `GraphVersion` build. */
  readonly id: number;
  readonly key: IntersectionKey;
  /** Sorted by (y, x). */
  readonly tiles: readonly TilePos[];
  readonly aabbMin: TilePos;
  readonly aabbMax: TilePos;
  /** Representative tile for visuals, not for driving logic. */
  readonly centroidTile: TilePos;
}

export function intersectionKeyString(key: IntersectionKey): string {
  const { aabbMin: a, aabbMax: b } = key;
  return `${a.x},${a.y}|${b.x},${b.y}|${key.tileCount}|${key.tilesHash}`;
}

export class IntersectionIndex {
  /** Graph version this index was built for. */
  version = 0;
  clusters: IntersectionCluster[] = [];
  /** `tileKey` of an intersection tile -> owning cluster id. */
  tileToIntersection = new Map<number, number>();
  /** User-placed controllers, by `intersectionKeyString`, so they survive rebuilds. */
  trafficLightKeys = new Set<string>();
  /** Ids with a light for the current version. */
  trafficLights = new Set<number>();
  lightsDirty = false;

  intersectionIdAt(pos: TilePos): number | undefined {
    return this.tileToIntersection.get(tileKey(pos));
  }

  clusterById(id: number): IntersectionCluster | undefined {
    return this.clusters[id];
  }

  hasTrafficLightAt(pos: TilePos): boolean {
    const id = this.intersectionIdAt(pos);
    return id !== undefined && this.trafficLights.has(id);
  }

  /** `reset_intersections` on entering the main menu. */
  reset(): void {
    this.version = 0;
    this.clusters = [];
    this.tileToIntersection = new Map();
    this.trafficLightKeys = new Set();
    this.trafficLights = new Set();
    this.lightsDirty = true;
  }
}

export function buildIntersectionClusters(grid: MapGrid): {
  clusters: IntersectionCluster[];
  tileToIntersection: Map<number, number>;
} {
  const clusters: IntersectionCluster[] = [];
  const tileToIntersection = new Map<number, number>();
  const visited = new Uint8Array(grid.len());
  const isBoxTile = (i: number) => grid.roadKind[i] !== 0 && grid.roadDir[i] === 0;

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const start = y * grid.width + x;
      if (!isBoxTile(start) || visited[start] === 1) continue;

      const tiles: TilePos[] = [];
      const stack: TilePos[] = [{ x, y }];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (stack.length > 0) {
        const current = stack.pop()!;
        const i = grid.idx(current);
        if (i === undefined || visited[i] === 1 || !isBoxTile(i)) continue;
        visited[i] = 1;
        tiles.push(current);
        minX = Math.min(minX, current.x);
        maxX = Math.max(maxX, current.x);
        minY = Math.min(minY, current.y);
        maxY = Math.max(maxY, current.y);
        stack.push(
          { x: current.x - 1, y: current.y },
          { x: current.x + 1, y: current.y },
          { x: current.x, y: current.y - 1 },
          { x: current.x, y: current.y + 1 },
        );
      }

      tiles.sort((a, b) => a.y - b.y || a.x - b.x);
      let hash = 0n;
      for (const tile of tiles) {
        hash = (hash * 31n + BigInt.asUintN(64, BigInt(tile.x))) & MASK64;
        hash = (hash * 31n + BigInt.asUintN(64, BigInt(tile.y))) & MASK64;
      }

      const id = clusters.length;
      let sumX = 0;
      let sumY = 0;
      for (const tile of tiles) {
        sumX += tile.x;
        sumY += tile.y;
      }
      const aabbMin = { x: minX, y: minY };
      const aabbMax = { x: maxX, y: maxY };
      clusters.push({
        id,
        key: { aabbMin, aabbMax, tileCount: tiles.length, tilesHash: hash },
        tiles,
        aabbMin,
        aabbMax,
        centroidTile: {
          x: Math.max(Math.trunc(sumX / tiles.length), 0),
          y: Math.max(Math.trunc(sumY / tiles.length), 0),
        },
      });
      for (const tile of tiles) tileToIntersection.set(tileKey(tile), id);
    }
  }
  return { clusters, tileToIntersection };
}

/** `detect_intersections` (Update / GraphUpdate): rebuild on a new graph version, re-map lights onto new ids. */
export function detectIntersections(w: World): void {
  const index = w.intersections;
  if (index.version === w.graphVersion) return;
  index.version = w.graphVersion;

  const { clusters, tileToIntersection } = buildIntersectionClusters(w.grid);
  index.clusters = clusters;
  index.tileToIntersection = tileToIntersection;

  const nextKeys = new Set<string>();
  const nextIds = new Set<number>();
  for (const cluster of clusters) {
    const key = intersectionKeyString(cluster.key);
    if (index.trafficLightKeys.has(key)) {
      nextKeys.add(key);
      nextIds.add(cluster.id);
    }
  }
  index.trafficLightKeys = nextKeys;
  index.trafficLights = nextIds;
  index.lightsDirty = true;
}
