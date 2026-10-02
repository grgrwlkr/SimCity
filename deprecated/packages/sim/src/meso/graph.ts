// Stage 3½: the meso graph. A link is a carriageway of one direction between boxes — the lane tiles a car moves along
// forward or across by a lane change, as the road graph allows — as many lanes wide as the carriageway. Links join
// through a box, by the road graph's moves inside it, at a bend without a box and at the turn of a dead end. Meso
// traffic queues on links and the district travel times run over them; Rust had no such layer.
import { ROAD_KINDS, type TilePos } from '../commands';
import { roadSpeedLimit } from '../map/roads';
import type { World } from '../world';

export const NO_LINK = -1;

export interface MesoSuccessor {
  readonly link: number;
  /** Box tiles crossed on the way in; 0 at a bend or a dead end. */
  readonly boxTiles: number;
  /** The intersection cluster crossed, -1 without a box. */
  readonly cluster: number;
}

export class MesoGraph {
  /** Graph version this was built for; `null` = never. */
  builtFor: number | null = null;
  width = 0;
  height = 0;
  linkCount = 0;
  /** `ROAD_DIRS` index of the travel direction. */
  dir = new Uint8Array(0);
  lanes = new Uint8Array(0);
  /** Tiles along the direction of travel. */
  length = new Uint16Array(0);
  speedKmh = new Uint8Array(0);
  /** The middle of the first and of the last cross-section, in tile coordinates. */
  startX = new Float32Array(0);
  startY = new Float32Array(0);
  endX = new Float32Array(0);
  endY = new Float32Array(0);
  /** Per tile: its link, -1 off the lanes. */
  tileLink = new Int32Array(0);
  /** Per tile: its position along its link, 0 at the link's start. */
  tileOffset = new Uint16Array(0);
  /** The successors of link `l` are at `succStart[l]..succStart[l + 1]`, ascending by link. */
  succStart = new Int32Array(1);
  succLink = new Int32Array(0);
  succBoxTiles = new Uint16Array(0);
  succCluster = new Int32Array(0);

  isBuiltFor(version: number, width: number, height: number): boolean {
    return this.builtFor === version && this.width === width && this.height === height;
  }

  linkAt(pos: TilePos): number {
    if (pos.x < 0 || pos.y < 0 || pos.x >= this.width || pos.y >= this.height) return NO_LINK;
    return this.tileLink[pos.y * this.width + pos.x] ?? NO_LINK;
  }

  offsetAt(pos: TilePos): number {
    return this.linkAt(pos) === NO_LINK ? 0 : this.tileOffset[pos.y * this.width + pos.x]!;
  }

  successors(link: number): MesoSuccessor[] {
    const out: MesoSuccessor[] = [];
    for (let k = this.succStart[link]!; k < this.succStart[link + 1]!; k++) {
      out.push({ link: this.succLink[k]!, boxTiles: this.succBoxTiles[k]!, cluster: this.succCluster[k]! });
    }
    return out;
  }
}

// `ROAD_DIRS` indices.
const WEST = 1;
const EAST = 2;
const NORTH = 3;
const SOUTH = 4;

/** Position along the direction of travel: grows as a car moves on. */
function along(x: number, y: number, dir: number): number {
  return dir === EAST ? x : dir === WEST ? -x : dir === NORTH ? y : -y;
}

const horizontal = (dir: number) => dir === EAST || dir === WEST;

export function buildMesoGraph(w: World): MesoGraph {
  const grid = w.grid;
  const width = grid.width;
  const len = grid.len();
  const edges = w.roadGraph.edges;
  const g = new MesoGraph();
  g.builtFor = w.graphVersion;
  g.width = width;
  g.height = grid.height;

  const usable = new Uint8Array(len);
  for (const i of w.roadGraph.roadIndices) usable[i] = 1;
  const isLane = (i: number) => i >= 0 && usable[i] === 1 && grid.roadDir[i] !== 0;
  const isBox = (i: number) => i >= 0 && usable[i] === 1 && grid.roadDir[i] === 0;
  // Road graph move bits: 0 west, 1 east, 2 south (y − 1), 3 north (y + 1).
  const neighbour = (i: number, move: number) => {
    const x = i % width;
    if (move === 0) return x > 0 ? i - 1 : -1;
    if (move === 1) return x + 1 < width ? i + 1 : -1;
    if (move === 2) return i >= width ? i - width : -1;
    return i + width < len ? i + width : -1;
  };
  const movable = (i: number, move: number) => ((edges[i] ?? 0) & (1 << move)) !== 0;

  // Carriageways: lane tiles of one direction joined by the forward moves and lane changes the road graph allows.
  const parent = new Int32Array(len).fill(-1);
  const find = (i: number) => {
    let r = i;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]!]!;
      r = parent[r]!;
    }
    return r;
  };
  for (let i = 0; i < len; i++) if (isLane(i)) parent[i] = i;
  for (let i = 0; i < len; i++) {
    if (!isLane(i)) continue;
    for (let move = 0; move < 4; move++) {
      if (!movable(i, move)) continue;
      const j = neighbour(i, move);
      if (!isLane(j) || grid.roadDir[j] !== grid.roadDir[i]) continue;
      const [a, b] = [find(i), find(j)];
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }

  // Links in the order of their first tile.
  const rootLink = new Int32Array(len).fill(NO_LINK);
  g.tileLink = new Int32Array(len).fill(NO_LINK);
  g.tileOffset = new Uint16Array(len);
  const dirs: number[] = [];
  const kinds: number[] = [];
  const minAlong: number[] = [];
  const maxAlong: number[] = [];
  const tiles: number[] = [];
  for (let i = 0; i < len; i++) {
    if (!isLane(i)) continue;
    const root = find(i);
    let link = rootLink[root]!;
    if (link === NO_LINK) {
      link = dirs.length;
      rootLink[root] = link;
      dirs.push(grid.roadDir[i]!);
      kinds.push(grid.roadKind[i]!);
      minAlong.push(Infinity);
      maxAlong.push(-Infinity);
      tiles.push(0);
    }
    g.tileLink[i] = link;
    const a = along(i % width, Math.floor(i / width), dirs[link]!);
    minAlong[link] = Math.min(minAlong[link]!, a);
    maxAlong[link] = Math.max(maxAlong[link]!, a);
    tiles[link]! += 1;
  }

  const n = dirs.length;
  g.linkCount = n;
  g.dir = Uint8Array.from(dirs);
  g.lanes = new Uint8Array(n);
  g.length = new Uint16Array(n);
  g.speedKmh = new Uint8Array(n);
  g.startX = new Float32Array(n);
  g.startY = new Float32Array(n);
  g.endX = new Float32Array(n);
  g.endY = new Float32Array(n);
  const [startSum, startCount, endSum, endCount] = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < len; i++) {
    const link = g.tileLink[i]!;
    if (link === NO_LINK) continue;
    const [x, y] = [i % width, Math.floor(i / width)];
    const a = along(x, y, dirs[link]!);
    g.tileOffset[i] = a - minAlong[link]!;
    const across = horizontal(dirs[link]!) ? y : x;
    if (a === minAlong[link]) {
      startSum[link]! += across;
      startCount[link]! += 1;
    }
    if (a === maxAlong[link]) {
      endSum[link]! += across;
      endCount[link]! += 1;
    }
  }
  for (let link = 0; link < n; link++) {
    const dir = dirs[link]!;
    const length = maxAlong[link]! - minAlong[link]! + 1;
    g.length[link] = length;
    g.lanes[link] = Math.max(Math.round(tiles[link]! / length), 1);
    g.speedKmh[link] = roadSpeedLimit(ROAD_KINDS[kinds[link]!]!);
    const sign = dir === WEST || dir === SOUTH ? -1 : 1;
    const [first, last] = [sign * minAlong[link]!, sign * maxAlong[link]!];
    const [acrossStart, acrossEnd] = [startSum[link]! / startCount[link]!, endSum[link]! / endCount[link]!];
    if (horizontal(dir)) {
      [g.startX[link], g.startY[link], g.endX[link], g.endY[link]] = [first, acrossStart, last, acrossEnd];
    } else {
      [g.startX[link], g.startY[link], g.endX[link], g.endY[link]] = [acrossStart, first, acrossEnd, last];
    }
  }

  // Joins: a lane move into another link, or the moves through a box and out of it.
  const joins = new Map<number, { boxTiles: number; cluster: number }>();
  const join = (from: number, to: number, boxTiles: number, cluster: number) => {
    if (from === to) return;
    const key = from * n + to;
    const known = joins.get(key);
    if (known === undefined || boxTiles < known.boxTiles) joins.set(key, { boxTiles, cluster });
  };
  const exitsOf = new Map<number, Array<readonly [link: number, boxTiles: number]>>();
  const boxExits = (entry: number) => {
    const cached = exitsOf.get(entry);
    if (cached !== undefined) return cached;
    const depth = new Map<number, number>([[entry, 1]]);
    const queue = [entry];
    const best = new Map<number, number>();
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      for (let move = 0; move < 4; move++) {
        if (!movable(c, move)) continue;
        const e = neighbour(c, move);
        if (isBox(e) && !depth.has(e)) {
          depth.set(e, depth.get(c)! + 1);
          queue.push(e);
        } else if (isLane(e)) {
          const link = g.tileLink[e]!;
          const crossed = depth.get(c)!;
          if (crossed < (best.get(link) ?? Infinity)) best.set(link, crossed);
        }
      }
    }
    const exits = [...best].sort(([a], [b]) => a - b);
    exitsOf.set(entry, exits);
    return exits;
  };
  for (let i = 0; i < len; i++) {
    const link = g.tileLink[i]!;
    if (link === NO_LINK) continue;
    for (let move = 0; move < 4; move++) {
      if (!movable(i, move)) continue;
      const j = neighbour(i, move);
      if (isLane(j)) {
        join(link, g.tileLink[j]!, 0, -1);
      } else if (isBox(j)) {
        const cluster = w.intersections.intersectionIdAt({ x: j % width, y: Math.floor(j / width) }) ?? -1;
        for (const [to, boxTiles] of boxExits(j)) join(link, to, boxTiles, cluster);
      }
    }
  }
  const sorted = [...joins].sort(([a], [b]) => a - b);
  g.succStart = new Int32Array(n + 1);
  g.succLink = new Int32Array(sorted.length);
  g.succBoxTiles = new Uint16Array(sorted.length);
  g.succCluster = new Int32Array(sorted.length);
  sorted.forEach(([key, { boxTiles, cluster }], k) => {
    g.succStart[Math.floor(key / n) + 1]! += 1;
    g.succLink[k] = key % n;
    g.succBoxTiles[k] = boxTiles;
    g.succCluster[k] = cluster;
  });
  for (let link = 0; link < n; link++) g.succStart[link + 1]! += g.succStart[link]!;
  return g;
}

/** `GraphUpdate`, after the lanelet graph: rebuilt when the road graph changed. */
export function rebuildMesoGraph(w: World): void {
  if (w.meso.isBuiltFor(w.graphVersion, w.grid.width, w.grid.height)) return;
  w.meso = buildMesoGraph(w);
}
