// Port of crates/simcity_sim/src/game/traffic/stuck.rs and the motion timer of indices.rs: how long a
// vehicle has gone without progress, and the recovery that re-routes a stuck car before, as the last
// resort, removing it. Service vehicles and buses are never removed; their own recovery arrives with
// the services stage.
import type { TilePos } from '../commands';
import { findRoadPathCached } from '../transport/pathfinding';
import type { World } from '../world';
import {
  MAX_UNSTUCK_PER_TICK,
  STUCK_DESPAWN_SECS,
  STUCK_REROUTE_SECS,
  SWAP_DEADLOCK_DESPAWN_SECS,
  VEHICLE_FROZEN_SECS,
  VEHICLE_MOTION_SPEED_EPS,
  WAITING_EXEMPT_CAP_SECS,
  WEDGED_REROUTE_RETRY_SECS,
} from './constants';
import { applyRoute, drawJitterSeed, replanRouteWithLanelets, roadPathCtx, routeDirectionOk, type PlannedRoute } from './reroute';
import { TRIP_PURPOSES, VEHICLE_ROLES, despawnVehicle, vehicleRef } from './vehicles';

const f32 = Math.fround;

/** `VehicleMotionStats` (observability): the longest streaks and how many vehicles are frozen. */
export interface VehicleMotionStats {
  maxStoppedSecs: number;
  maxMovingSecs: number;
  frozenCount: number;
  /** Current tile of the vehicle stopped longest, `null` when none. */
  worstTile: TilePos | null;
}

export function emptyMotionStats(): VehicleMotionStats {
  return { maxStoppedSecs: 0, maxMovingSecs: 0, frozenCount: 0, worstTile: null };
}

/** `init_stuck_timers`: a vehicle without a stuck timer gets one at its current tile and progress. */
export function initStuckTimers(w: World): void {
  const v = w.vehicles;
  for (const slot of v.order) {
    if (v.hasStuckTimer[slot] === 1) continue;
    const tile = w.pathPool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
    if (tile === undefined) continue;
    v.hasStuckTimer[slot] = 1;
    v.stuckSecs[slot] = 0;
    v.stuckLastTileX[slot] = tile.x;
    v.stuckLastTileY[slot] = tile.y;
    v.stuckLastProgress[slot] = v.progress[slot]!;
  }
}

/**
 * `track_vehicle_motion` (after moveVehicles): `stoppedSecs` runs until the vehicle is more than 0.6 of
 * a tile from where it last made progress, so creeping in place against a refused gate does not reset
 * it; `movingSecs` is the plain speed streak. A vehicle without a route is idle, not stuck.
 */
export function trackVehicleMotion(w: World, dtNs: number): void {
  const dt = f32(dtNs / 1e9);
  const v = w.vehicles;
  const radius = f32(w.mapConfig.tileSize * 0.6);
  const radiusSq = f32(radius * radius);
  const stats = emptyMotionStats();
  for (const slot of v.order) {
    if (v.parked[slot] === 1) continue;
    const handle = v.pathHandle[slot]!;
    if (w.pathPool.len(handle) <= 1) {
      v.stoppedSecs[slot] = 0;
      v.movingSecs[slot] = 0;
      v.anchorX[slot] = v.x[slot]!;
      v.anchorY[slot] = v.y[slot]!;
      continue;
    }
    const dx = f32(v.x[slot]! - v.anchorX[slot]!);
    const dy = f32(v.y[slot]! - v.anchorY[slot]!);
    if (f32(f32(dx * dx) + f32(dy * dy)) > radiusSq) {
      v.anchorX[slot] = v.x[slot]!;
      v.anchorY[slot] = v.y[slot]!;
      v.stoppedSecs[slot] = 0;
    } else {
      v.stoppedSecs[slot] = f32(v.stoppedSecs[slot]! + dt);
    }
    v.movingSecs[slot] = Math.abs(v.speed[slot]!) > VEHICLE_MOTION_SPEED_EPS ? f32(v.movingSecs[slot]! + dt) : 0;
    if (v.stoppedSecs[slot]! > stats.maxStoppedSecs) {
      stats.maxStoppedSecs = v.stoppedSecs[slot]!;
      stats.worstTile = w.pathPool.getTile(handle, v.pathCursor[slot]!) ?? null;
    }
    stats.maxMovingSecs = Math.max(stats.maxMovingSecs, v.movingSecs[slot]!);
    if (v.stoppedSecs[slot]! >= VEHICLE_FROZEN_SECS) stats.frozenCount += 1;
  }
  w.motionStats = stats;
}

/**
 * `update_stuck_timers`: the timer runs while the vehicle neither changes tile nor moves 0.02 of one.
 * Waiting at a stop line resets it, but only while the motion timer says a light cycle could still
 * serve the wait; a waiter refused past that cap is stuck like any other.
 */
export function updateStuckTimers(w: World, dtNs: number): void {
  const dt = f32(dtNs / 1e9);
  const v = w.vehicles;
  for (const slot of v.order) {
    if (v.parked[slot] === 1 || v.hasStuckTimer[slot] !== 1) continue;
    const tile = w.pathPool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
    if (tile === undefined) {
      v.stuckSecs[slot] = 0;
      continue;
    }
    const progressed =
      tile.x !== v.stuckLastTileX[slot] ||
      tile.y !== v.stuckLastTileY[slot] ||
      Math.abs(f32(v.progress[slot]! - v.stuckLastProgress[slot]!)) > f32(0.02);
    const kind = v.trafficState[slot]!.kind;
    const waiting = kind === 'Stopped' || kind === 'WaitingForGreen';
    const legitimateWait = waiting && v.stoppedSecs[slot]! < WAITING_EXEMPT_CAP_SECS;
    v.stuckSecs[slot] = progressed || legitimateWait ? 0 : f32(v.stuckSecs[slot]! + dt);
    // Moving again: a reroute that freed the car is behind it.
    if (progressed) v.stuckRerouted[slot] = 0;
    v.stuckLastTileX[slot] = tile.x;
    v.stuckLastTileY[slot] = tile.y;
    v.stuckLastProgress[slot] = v.progress[slot]!;
  }
}

const sameTiles = (a: readonly TilePos[], b: readonly TilePos[]) =>
  a.length === b.length && a.every((tile, i) => tile.x === b[i]!.x && tile.y === b[i]!.y);

function finishAndDespawn(w: World, slot: number): void {
  const v = w.vehicles;
  if (v.passengerCitizen[slot] !== -1) {
    w.events.tripFinished.push({ citizen: v.passengerCitizen[slot]!, purpose: TRIP_PURPOSES[v.passengerPurpose[slot]!]! });
  }
  despawnVehicle(w, vehicleRef(v, slot));
}

/**
 * `resolve_stuck_vehicles` (TrafficStep::Recovery, last): a car stuck past `STUCK_REROUTE_SECS`, or
 * wedged on the motion timer (retried once every `WEDGED_REROUTE_RETRY_SECS`), is re-routed when the
 * lanelet planner or road A* offers a different route. Otherwise it waits another 12 s, and only past
 * the despawn horizon with no escape is a trip car removed. A swap deadlock the breaker could not
 * break removes the car after a short grace.
 */
export function resolveStuckVehicles(w: World, dtNs: number): void {
  const dt = f32(dtNs / 1e9);
  const v = w.vehicles;
  const pool = w.pathPool;
  const tripRole = VEHICLE_ROLES.indexOf('trip');
  const ctx = roadPathCtx(w);
  const retryTicks = dtNs > 0 ? Math.round((WEDGED_REROUTE_RETRY_SECS * 1e9) / dtNs) : 0;
  let handled = 0;
  for (const slot of [...v.order]) {
    if (handled >= MAX_UNSTUCK_PER_TICK) break;
    if (v.parked[slot] === 1 || v.hasStuckTimer[slot] !== 1) continue;
    const removable = v.role[slot] === tripRole;
    const stoppedSecs = v.stoppedSecs[slot]!;
    const wedged = stoppedSecs >= STUCK_REROUTE_SECS;
    const sinceWedged = f32(stoppedSecs - STUCK_REROUTE_SECS);
    const wedgedRetryDue = wedged && f32(((sinceWedged % WEDGED_REROUTE_RETRY_SECS) + WEDGED_REROUTE_RETRY_SECS) % WEDGED_REROUTE_RETRY_SECS) < dt;
    const motionDespawn = stoppedSecs >= STUCK_DESPAWN_SECS;
    const recoveryDue = wedgedRetryDue || (motionDespawn && removable);
    const handle = v.pathHandle[slot]!;
    const len = pool.len(handle);
    const cursor = v.pathCursor[slot]!;
    if (cursor >= len) {
      v.stuckSecs[slot] = 0;
      continue;
    }
    if (v.swapDeadlocked[slot] === 1 && removable && v.stuckSecs[slot]! >= SWAP_DEADLOCK_DESPAWN_SECS) {
      finishAndDespawn(w, slot);
      handled += 1;
      continue;
    }
    if (v.stuckSecs[slot]! < STUCK_REROUTE_SECS && !recoveryDue) continue;

    const current = pool.getTile(handle, cursor);
    if (current === undefined) continue;
    // One search per vehicle per retry window: Rust searched again every tick for a car no route
    // could free, two whole-city searches that took most of a busy tick.
    if (w.tick < v.stuckRetryTick[slot]!) {
      // A fresh route gets its whole window before anything else is tried.
      if (v.stuckRerouted[slot] !== 1) holdOrRemove(w, slot, cursor, wedged, motionDespawn, removable);
      continue;
    }
    // The last reroute did not free it. Rust re-planned such a car every tick: a new tie-break seed
    // "found" a different route each time, and the reroute pinned it in place. A trip car is removed.
    if (v.stuckRerouted[slot] === 1 && motionDespawn && removable) {
      finishAndDespawn(w, slot);
      handled += 1;
      continue;
    }
    v.stuckRerouted[slot] = 0;
    w.routeProducerStats.stuckReplanAttempts += 1;
    handled += 1;
    const goal = pool.getTile(handle, Math.max(len - 1, 0)) ?? current;
    const lanelet = replanRouteWithLanelets(w, drawJitterSeed(w), current, goal, w.grid.get(current)?.road.dir ?? 'None');
    let road = findRoadPathCached(ctx, current, goal);
    // The region corridor hides detours such as a dead-end spur's U-turn; the full search only in the
    // throttled wedged window.
    if (road.length === 0 && wedgedRetryDue && ctx.regions !== null) road = findRoadPathCached({ ...ctx, regions: null }, current, goal);
    if (!routeDirectionOk(road, w.grid)) {
      w.routeProducerStats.guardRefusals += 1;
      road = [];
    }
    const rest = pool.remainingFrom(handle, cursor) ?? [];
    const roadChanged = road.length > 0 && !sameTiles(road, rest);
    const laneletChanged = lanelet !== undefined && !sameTiles(lanelet.tiles, rest);
    if (!roadChanged && !laneletChanged) {
      v.stuckRetryTick[slot] = w.tick + retryTicks;
      holdOrRemove(w, slot, cursor, wedged, motionDespawn, removable);
      continue;
    }
    if (lanelet !== undefined) w.routeProducerStats.stuckLanelet += 1;
    else w.routeProducerStats.stuckRoadFallback += 1;
    const planned: PlannedRoute =
      lanelet !== undefined
        ? { tiles: lanelet.tiles, sidecar: lanelet.sidecar.map((e) => [e[0], e[1], e[2]] as const), builtFor: w.laneletGraph.version, producer: 'Lanelet' }
        : { tiles: road, sidecar: [], builtFor: 0, producer: 'RoadFallback' };
    applyRoute(w, slot, planned);
    v.speed[slot] = Math.min(v.speed[slot]!, f32(v.maxSpeed[slot]! * 0.5));
    v.stuckSecs[slot] = 0;
    v.stuckLastTileX[slot] = current.x;
    v.stuckLastTileY[slot] = current.y;
    v.stuckLastProgress[slot] = v.progress[slot]!;
    v.stuckRetryTick[slot] = w.tick + retryTicks;
    v.stuckRerouted[slot] = 1;
  }
}

/**
 * No other route: a car that has moved along its route holds the timer below the reroute threshold and
 * tries again later; a wedged one is left to reach the despawn horizon, where a trip car is removed.
 */
function holdOrRemove(w: World, slot: number, cursor: number, wedged: boolean, motionDespawn: boolean, removable: boolean): void {
  const v = w.vehicles;
  if (cursor > 0 && !wedged) {
    v.stuckSecs[slot] = f32(STUCK_REROUTE_SECS * 0.8);
    return;
  }
  if ((v.stuckSecs[slot]! >= STUCK_DESPAWN_SECS || motionDespawn) && removable) finishAndDespawn(w, slot);
}
