// Stage 3½b: how long a car takes between districts of 16×16 tiles, over the meso graph at the speed limits. A district
// is entered and left on every link through it, at the link's tile nearest the district's centre. The rows are built a
// few a tick; after the roads change the old times serve until their rows are rebuilt.
import type { TilePos } from '../commands';
import type { World } from '../world';
import type { MesoGraph } from './graph';

export const DISTRICT_TILES = 16;
export const MATRIX_ROWS_PER_TICK = 4;
/** Seconds of a pair with no way between them. */
export const NO_TIME = 0xffff;
/** Speed across the box of an intersection, km/h. */
export const BOX_KMH = 30;

export class DistrictTimes {
  /** The graph version the rows are built for; -1 before any. */
  graphVersion = -1;
  districtsW = 0;
  districtsH = 0;
  count = 0;
  /** The next row the update looks at. */
  cursor = 0;
  /** Whole seconds from district `i` to `j` at `i * count + j`, at most 65 534. */
  matrix = new Uint16Array(0);
  /** The graph version each row was built for, -1 never. */
  rowBuiltFor = new Float64Array(0);
  /** Per district, flattened pairs of a link through it and the offset of its tile nearest the centre. */
  entries: Int32Array[] = [];
  /** Seconds a link takes a tile, for the graph version the rows are built for. */
  secondsPerTile = new Float64Array(0);

  districtAt(pos: TilePos): number | undefined {
    const [dx, dy] = [Math.floor(pos.x / DISTRICT_TILES), Math.floor(pos.y / DISTRICT_TILES)];
    return pos.x < 0 || pos.y < 0 || dx >= this.districtsW || dy >= this.districtsH ? undefined : dy * this.districtsW + dx;
  }

  seconds(from: number, to: number): number {
    return this.matrix[from * this.count + to] ?? NO_TIME;
  }

  rowReady(district: number): boolean {
    return (this.rowBuiltFor[district] ?? -1) >= 0;
  }

  rowsBuilt(): number {
    let built = 0;
    for (const version of this.rowBuiltFor) if (version === this.graphVersion) built += 1;
    return built;
  }

  /** Seconds by car from the district of `from` to that of `to`; `undefined` without a way or before the row exists. */
  between(from: TilePos, to: TilePos): number | undefined {
    const [a, b] = [this.districtAt(from), this.districtAt(to)];
    if (a === undefined || b === undefined || !this.rowReady(a)) return undefined;
    const seconds = this.seconds(a, b);
    return seconds === NO_TIME ? undefined : seconds;
  }
}

/** A binary min-heap of links by a time. */
class LinkHeap {
  private readonly keys: number[] = [];
  private readonly links: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, link: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.links.push(link);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.keys[i] = this.keys[parent]!;
      this.links[i] = this.links[parent]!;
      i = parent;
    }
    this.keys[i] = key;
    this.links[i] = link;
  }

  pop(): readonly [key: number, link: number] {
    const top = [this.keys[0]!, this.links[0]!] as const;
    const key = this.keys.pop()!;
    const link = this.links.pop()!;
    const size = this.keys.length;
    if (size > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= size) break;
        const child = left + 1 < size && this.keys[left + 1]! < this.keys[left]! ? left + 1 : left;
        if (this.keys[child]! >= key) break;
        this.keys[i] = this.keys[child]!;
        this.links[i] = this.links[child]!;
        i = child;
      }
      this.keys[i] = key;
      this.links[i] = link;
    }
    return top;
  }
}

function districtEntries(g: MesoGraph, districtsW: number, count: number): Int32Array[] {
  const nearest = new Map<number, readonly [distance: number, offset: number]>();
  for (let i = 0; i < g.tileLink.length; i++) {
    const link = g.tileLink[i]!;
    if (link < 0) continue;
    const [x, y] = [i % g.width, Math.floor(i / g.width)];
    const [dx, dy] = [Math.floor(x / DISTRICT_TILES), Math.floor(y / DISTRICT_TILES)];
    const district = dy * districtsW + dx;
    const centre = DISTRICT_TILES / 2;
    const distance = Math.abs(x - (dx * DISTRICT_TILES + centre)) + Math.abs(y - (dy * DISTRICT_TILES + centre));
    const key = district * g.linkCount + link;
    const known = nearest.get(key);
    if (known === undefined || distance < known[0] || (distance === known[0] && g.tileOffset[i]! < known[1])) nearest.set(key, [distance, g.tileOffset[i]!]);
  }
  const lists: number[][] = Array.from({ length: count }, () => []);
  for (const [key, [, offset]] of [...nearest].sort(([a], [b]) => a - b)) lists[Math.floor(key / g.linkCount)]!.push(key % g.linkCount, offset);
  return lists.map((list) => Int32Array.from(list));
}

function buildRow(g: MesoGraph, d: DistrictTimes, row: number, tileMeters: number): void {
  const n = g.linkCount;
  const perTile = d.secondsPerTile;
  const boxSeconds = tileMeters / (BOX_KMH / 3.6);
  const start = new Float64Array(n).fill(Infinity);
  const end = new Float64Array(n).fill(Infinity);
  const sourceOffset = new Int32Array(n).fill(-1);
  const heap = new LinkHeap();
  const sources = d.entries[row]!;
  for (let k = 0; k < sources.length; k += 2) {
    const [link, offset] = [sources[k]!, sources[k + 1]!];
    sourceOffset[link] = offset;
    const toEnd = (g.length[link]! - offset) * perTile[link]!;
    if (toEnd < end[link]!) {
      end[link] = toEnd;
      heap.push(toEnd, link);
    }
  }
  while (heap.size > 0) {
    const [time, link] = heap.pop();
    if (time > end[link]!) continue;
    for (let k = g.succStart[link]!; k < g.succStart[link + 1]!; k++) {
      const next = g.succLink[k]!;
      const entered = time + g.succBoxTiles[k]! * boxSeconds;
      if (entered >= start[next]!) continue;
      start[next] = entered;
      const left = entered + g.length[next]! * perTile[next]!;
      if (left < end[next]!) {
        end[next] = left;
        heap.push(left, next);
      }
    }
  }
  for (let to = 0; to < d.count; to++) {
    let best = to === row ? 0 : Infinity;
    const targets = d.entries[to]!;
    for (let k = 0; k < targets.length; k += 2) {
      const [link, offset] = [targets[k]!, targets[k + 1]!];
      best = Math.min(best, start[link]! + offset * perTile[link]!);
      // Further on along a link the trip starts on.
      if (sourceOffset[link]! >= 0 && offset >= sourceOffset[link]!) best = Math.min(best, (offset - sourceOffset[link]!) * perTile[link]!);
    }
    d.matrix[row * d.count + to] = Number.isFinite(best) ? Math.min(Math.round(best), NO_TIME - 1) : NO_TIME;
  }
}

/** `GraphUpdate`, after the meso graph: up to `MATRIX_ROWS_PER_TICK` rows built for the current graph a tick. */
export function updateDistrictTimes(w: World): void {
  const g = w.meso;
  const d = w.districtTimes;
  if (g.builtFor === null) return;
  if (d.graphVersion !== g.builtFor) {
    const districtsW = Math.floor((g.width + DISTRICT_TILES - 1) / DISTRICT_TILES);
    const districtsH = Math.floor((g.height + DISTRICT_TILES - 1) / DISTRICT_TILES);
    if (districtsW !== d.districtsW || districtsH !== d.districtsH) {
      d.districtsW = districtsW;
      d.districtsH = districtsH;
      d.count = districtsW * districtsH;
      d.matrix = new Uint16Array(d.count * d.count).fill(NO_TIME);
      d.rowBuiltFor = new Float64Array(d.count).fill(-1);
    }
    d.graphVersion = g.builtFor;
    d.cursor = 0;
    d.entries = districtEntries(g, districtsW, d.count);
    const tileMeters = w.trafficConfig.tileMeters;
    d.secondsPerTile = Float64Array.from(g.speedKmh, (kmh) => tileMeters / (Math.max(kmh, 1) / 3.6));
  }
  for (let budget = MATRIX_ROWS_PER_TICK; budget > 0 && d.cursor < d.count; d.cursor++) {
    if (d.rowBuiltFor[d.cursor] === d.graphVersion) continue;
    buildRow(g, d, d.cursor, w.trafficConfig.tileMeters);
    d.rowBuiltFor[d.cursor] = d.graphVersion;
    budget -= 1;
  }
}
