// Port of crates/simcity_sim/src/game/traffic/swap_break.rs: two same-direction vehicles off an
// intersection whose routes want each other's tile never move again; one of them defers its lane
// change by a tile, or is flagged for removal when neither can.
import type { TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { dirDelta, dirLeft, dirRight, roadCellIsSome } from '../map/roads';
import type { World } from '../world';
import type { PathPool } from './pathPool';
import { drawJitterSeed, replanRouteWithLanelets, routeDirectionOk } from './reroute';
import { isIntersectionTile } from './state';
import { clearLaneletPlanOnReroute, refSlot, resolveVehicle, vehicleRef } from './vehicles';

interface IntentRec {
  readonly seq: number;
  readonly handle: number;
  readonly cursor: number;
  readonly cur: TilePos;
  readonly next: TilePos;
}

const sameTile = (a: TilePos, b: TilePos) => a.x === b.x && a.y === b.y;
const add = (a: TilePos, d: TilePos) => ({ x: a.x + d.x, y: a.y + d.y });

/** `[cur, L, R0, ..]` -> `[cur, S, R0, ..]` when L is a lateral hop and R0 = L + forward. */
function deferredRoute(grid: MapGrid, pool: PathPool, rec: IntentRec): TilePos[] | undefined {
  const cell = grid.get(rec.cur);
  if (cell === undefined) return undefined;
  const dir = cell.road.dir;
  if (dir === 'None') return undefined;
  const fwd = dirDelta(dir);
  const isLateral = sameTile(rec.next, add(rec.cur, dirDelta(dirLeft(dir)))) || sameTile(rec.next, add(rec.cur, dirDelta(dirRight(dir))));
  if (!isLateral) return undefined;
  const s = add(rec.cur, fwd);
  const r0 = pool.getTile(rec.handle, rec.cursor + 2);
  if (r0 === undefined || !sameTile(r0, add(rec.next, fwd))) return undefined;
  const sCell = grid.get(s);
  if (sCell === undefined || sCell.water || !roadCellIsSome(sCell.road) || sCell.road.dir !== dir || isIntersectionTile(grid, s)) {
    return undefined;
  }
  const r0Cell = grid.get(r0);
  if (r0Cell === undefined || r0Cell.water || !roadCellIsSome(r0Cell.road)) return undefined;
  const remaining = pool.remainingFrom(rec.handle, rec.cursor);
  if (remaining === undefined || remaining.length < 3) return undefined;
  return [rec.cur, s, ...remaining.slice(2)];
}

/** `break_tile_swaps` (TrafficStep::Movement, after the arbiter, before moveVehicles). */
export function breakTileSwaps(w: World): void {
  const v = w.vehicles;
  const pool = w.pathPool;
  const intent = new Map<number, IntentRec>();
  for (const slot of v.order) {
    if (v.parked[slot] === 1 || v.isReversing[slot] === 1) continue;
    const handle = v.pathHandle[slot]!;
    const cursor = v.pathCursor[slot]!;
    const cur = pool.getTile(handle, cursor);
    const next = pool.getTile(handle, cursor + 1);
    if (cur === undefined || next === undefined || sameTile(next, cur)) continue;
    intent.set(vehicleRef(v, slot), { seq: v.seq[slot]!, handle, cursor, cur, next });
  }
  const clearFlags = (keep: ReadonlySet<number>) => {
    for (const slot of v.order) {
      if (v.swapDeadlocked[slot] === 1 && !keep.has(vehicleRef(v, slot))) v.swapDeadlocked[slot] = 0;
    }
  };
  if (intent.size < 2) {
    clearFlags(new Set());
    return;
  }

  // Decisions follow the sequence number; the reference only separates never-numbered test vehicles.
  const orderKey = (ref: number): readonly [number, number] => [intent.get(ref)?.seq ?? 0, ref];
  const before = (a: number, b: number) => {
    const [sa, ra] = orderKey(a);
    const [sb, rb] = orderKey(b);
    return sa !== sb ? sa < sb : ra < rb;
  };
  const refs = [...intent.keys()].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));

  const seenPairs = new Set<string>();
  const victimsSeen = new Set<number>();
  const actions: Array<readonly [victim: number, route: TilePos[] | undefined]> = [];
  for (const e of refs) {
    const recE = intent.get(e)!;
    if (isIntersectionTile(w.grid, recE.cur) || isIntersectionTile(w.grid, recE.next)) continue;
    const nextIdx = w.grid.idx(recE.next);
    if (nextIdx === undefined) continue;
    const occupants = w.spatialIndex.tileEntries(nextIdx);
    if (occupants === undefined) continue;
    let partner: number | undefined;
    for (const entry of occupants) {
      const f = entry.vehicle;
      if (f === e) continue;
      const recF = intent.get(f);
      if (recF !== undefined && sameTile(recF.next, recE.cur) && (partner === undefined || !before(partner, f))) {
        partner = partner !== undefined && before(partner, f) ? partner : f;
      }
    }
    if (partner === undefined) continue;
    const f = partner;
    const key = e < f ? `${e}|${f}` : `${f}|${e}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    const de = deferredRoute(w.grid, pool, recE);
    const df = deferredRoute(w.grid, pool, intent.get(f)!);
    let victim: number;
    let route: TilePos[] | undefined;
    if (de !== undefined && df !== undefined) [victim, route] = before(f, e) ? [e, de] : [f, df];
    else if (de !== undefined) [victim, route] = [e, de];
    else if (df !== undefined) [victim, route] = [f, df];
    else [victim, route] = [before(f, e) ? e : f, undefined];
    if (!victimsSeen.has(victim)) {
      victimsSeen.add(victim);
      actions.push([victim, route]);
    }
  }

  clearFlags(new Set(actions.filter(([, route]) => route === undefined).map(([victim]) => victim)));
  if (actions.length === 0) return;
  actions.sort(([a], [b]) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));

  for (const [victim, newRoute] of actions) {
    const slot = resolveVehicle(v, victim);
    if (slot === undefined || v.parked[slot] === 1) continue;
    if (newRoute === undefined) {
      v.swapDeadlocked[slot] = 1;
      continue;
    }
    const speed = v.speed[slot]!;
    const cur = newRoute[0]!;
    const goal = newRoute[newRoute.length - 1] ?? cur;
    const travelDir = w.grid.get(cur)?.road.dir ?? 'None';
    const jitterSeed = drawJitterSeed(w);
    const lanelet = replanRouteWithLanelets(w, jitterSeed, cur, goal, travelDir);
    if (lanelet === undefined && !routeDirectionOk(newRoute, w.grid)) {
      w.routeProducerStats.guardRefusals += 1;
      continue;
    }
    pool.release(v.pathHandle[slot]!);
    const plan = v.laneletPlan[refSlot(v, victim)]!;
    if (lanelet !== undefined) {
      v.pathHandle[slot] = pool.intern(lanelet.tiles);
      plan.entries = lanelet.sidecar.map((e) => [e[0], e[1], e[2]] as const);
      plan.builtFor = w.laneletGraph.version;
    } else {
      w.routeProducerStats.swapBreakHandbuilt += 1;
      v.pathHandle[slot] = pool.intern(newRoute);
      clearLaneletPlanOnReroute(plan);
    }
    v.pathCursor[slot] = 0;
    v.progress[slot] = 0;
    v.speed[slot] = speed;
  }
}
