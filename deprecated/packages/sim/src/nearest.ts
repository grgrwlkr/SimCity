// Stage 3½e: the nearest buildings to a tile through buckets of the map. A city of a million plans a day for every citizen
// and a job for every worker; sorting every building by distance for each of them was quadratic. A search walks rings of
// buckets out from the tile and stops once no farther ring can hold a nearer building, so it gives exactly what the sort
// gave: nearest by Manhattan distance to the anchor, the lower id first among equals.
import type { Building } from './buildings/building';
import type { TilePos } from './commands';

const BUCKET_TILES = 16;

export class NearestBuildings {
  private readonly bucketsW: number;
  private readonly bucketsH: number;
  private readonly buckets: Building[][];

  constructor(buildings: readonly Building[], mapWidth: number, mapHeight: number) {
    this.bucketsW = Math.max(Math.ceil(mapWidth / BUCKET_TILES), 1);
    this.bucketsH = Math.max(Math.ceil(mapHeight / BUCKET_TILES), 1);
    this.buckets = Array.from({ length: this.bucketsW * this.bucketsH }, () => []);
    for (const b of buildings) this.buckets[this.bucketOf(b.anchor)]!.push(b);
  }

  private bucketOf(pos: TilePos): number {
    const x = Math.min(Math.max(Math.floor(pos.x / BUCKET_TILES), 0), this.bucketsW - 1);
    const y = Math.min(Math.max(Math.floor(pos.y / BUCKET_TILES), 0), this.bucketsH - 1);
    return y * this.bucketsW + x;
  }

  /** Takes `b` out of the searches, as a workplace that filled up. */
  remove(b: Building): void {
    const bucket = this.buckets[this.bucketOf(b.anchor)]!;
    const at = bucket.indexOf(b);
    if (at >= 0) bucket.splice(at, 1);
  }

  /** The `k` nearest buildings `accept` takes, nearest first, the lower id first among equals. */
  nearest(near: TilePos, k: number, accept: (b: Building) => boolean): Building[] {
    const found: Building[] = [];
    const distances: number[] = [];
    if (k <= 0) return found;
    const bx = Math.min(Math.max(Math.floor(near.x / BUCKET_TILES), 0), this.bucketsW - 1);
    const by = Math.min(Math.max(Math.floor(near.y / BUCKET_TILES), 0), this.bucketsH - 1);
    // Rings past the edge of the bucket grid, for a tile off the map.
    const rings = Math.max(this.bucketsW, this.bucketsH) + Math.ceil(Math.max(Math.abs(near.x), Math.abs(near.y)) / BUCKET_TILES);
    for (let r = 0; r <= rings; r++) {
      // No anchor in a bucket r rings out is nearer than this on the axis it is r buckets away along.
      const bound = r === 0 ? 0 : (r - 1) * BUCKET_TILES + 1;
      if (found.length === k && bound > distances[k - 1]!) break;
      for (let y = by - r; y <= by + r; y++) {
        if (y < 0 || y >= this.bucketsH) continue;
        const edge = y === by - r || y === by + r;
        for (let x = bx - r; x <= bx + r; x += edge || r === 0 ? 1 : 2 * r) {
          if (x < 0 || x >= this.bucketsW) continue;
          for (const b of this.buckets[y * this.bucketsW + x]!) {
            const d = Math.abs(b.anchor.x - near.x) + Math.abs(b.anchor.y - near.y);
            if (found.length === k && (d > distances[k - 1]! || (d === distances[k - 1]! && b.id > found[k - 1]!.id))) continue;
            if (!accept(b)) continue;
            let i = found.length;
            while (i > 0 && (distances[i - 1]! > d || (distances[i - 1] === d && found[i - 1]!.id > b.id))) i -= 1;
            found.splice(i, 0, b);
            distances.splice(i, 0, d);
            if (found.length > k) {
              found.pop();
              distances.pop();
            }
          }
        }
      }
    }
    return found;
  }
}
