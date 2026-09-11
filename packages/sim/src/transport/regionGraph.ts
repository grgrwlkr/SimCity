// Port of crates/simcity_sim/src/game/transport/region_graph.rs: coarse region connectivity that
// prunes low-level A* searches.
import type { TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import type { World } from '../world';

const divCeil = (a: number, b: number) => Math.floor((a + b - 1) / b);

export class RegionGraph {
  version = 0;
  regionSize = 0;
  regionsW = 0;
  regionsH = 0;
  /** Per region: mask of W, E, S, N neighbour regions reachable by road. */
  edges = new Uint8Array(0);

  isBuiltFor(version: number, regionSize: number, w: number, h: number): boolean {
    if (this.version !== version || this.regionSize !== regionSize || this.edges.length === 0) return false;
    return this.regionsW === divCeil(w, regionSize) && this.regionsH === divCeil(h, regionSize);
  }

  regionId(pos: TilePos): number | undefined {
    if (pos.x < 0 || pos.y < 0) return undefined;
    const rx = Math.floor(pos.x / this.regionSize);
    const ry = Math.floor(pos.y / this.regionSize);
    if (rx >= this.regionsW || ry >= this.regionsH) return undefined;
    return ry * this.regionsW + rx;
  }
}

export function rebuildRegionGraphInner(grid: MapGrid, graphVersion: number, regionSizeConfig: number, regions: RegionGraph): void {
  const w = grid.width;
  const h = grid.height;
  const regionSize = Math.max(regionSizeConfig, 1);
  if (regions.isBuiltFor(graphVersion, regionSize, w, h)) return;

  const regionsW = divCeil(w, regionSize);
  const regionsH = divCeil(h, regionSize);
  regions.version = graphVersion;
  regions.regionSize = regionSize;
  regions.regionsW = regionsW;
  regions.regionsH = regionsH;
  regions.edges = new Uint8Array(regionsW * regionsH);

  const isRoad = (x: number, y: number) => {
    const i = grid.idx({ x, y });
    return i !== undefined && grid.water[i] === 0 && grid.roadKind[i] !== 0;
  };
  const regionOf = (x: number, y: number) => Math.floor(y / regionSize) * regionsW + Math.floor(x / regionSize);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isRoad(x, y)) continue;
      const rid = regionOf(x, y);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !isRoad(nx, ny)) continue;
        const nrid = regionOf(nx, ny);
        if (nrid === rid) continue;
        const rx = rid % regionsW;
        const ry = Math.floor(rid / regionsW);
        const nrx = nrid % regionsW;
        const nry = Math.floor(nrid / regionsW);
        if (nrx + 1 === rx) {
          regions.edges[rid]! |= 1 << 0;
          regions.edges[nrid]! |= 1 << 1;
        } else if (nrx === rx + 1) {
          regions.edges[rid]! |= 1 << 1;
          regions.edges[nrid]! |= 1 << 0;
        } else if (nry + 1 === ry) {
          regions.edges[rid]! |= 1 << 2;
          regions.edges[nrid]! |= 1 << 3;
        } else if (nry === ry + 1) {
          regions.edges[rid]! |= 1 << 3;
          regions.edges[nrid]! |= 1 << 2;
        }
      }
    }
  }
}

/** `rebuild_region_graph` (FixedUpdate / GraphUpdate). */
export function rebuildRegionGraph(w: World): void {
  rebuildRegionGraphInner(w.grid, w.graphVersion, w.pathfindingConfig.regionSize, w.regionGraph);
}
