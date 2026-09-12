// Port of crates/simcity_sim/src/game/traffic/movement/drive.rs and the IDM helpers of traffic.rs:
// longitudinal dynamics (IDM, f32), virtual leaders at stop lines and blocked tiles, the deferred
// box-entry reservation, the hard overlap clamp, arrival and parking.
import { ROAD_KINDS, type TilePos } from '../commands';
import { tileToWorld, type MapConfig } from '../map/coords';
import type { MapGrid } from '../map/grid';
import { capacityPerLaneTile, dirLeft, dirRight, roadSpeedLimit } from '../map/roads';
import { powIntF32, sqrtF32 } from '../math';
import type { World } from '../world';
import type { TrafficConfig } from './config';
import {
  DRIVER_PROFILE_FACTOR_MAX,
  DRIVER_PROFILE_FACTOR_MIN,
  DRIVER_PROFILE_MEDIUM_FACTOR,
  LEADER_LOOKAHEAD_TILES,
  RIGHT_ON_RED_TURN_MAX_KMH,
  SERVICE_VEHICLE_SPEED_LIMIT_FACTOR,
  STOP_LINE_MARGIN_TILES,
  STOP_LINE_OFFSET,
  TILE_CENTER_TO_EDGE_TILES,
  VEHICLE_LENGTH_TILES,
} from './constants';
import { dirBetweenAdjacent } from '../transport/lanelet/pathfinding';
import { approachingLanelets, waitPointPos } from './reservations';
import { computeExitDirection, isIntersectionTile } from './state';
import { FREE_FLOW, TRIP_PURPOSES, VEHICLE_ROLES, despawnVehicle, setTrafficState, vehicleRef } from './vehicles';

const f32 = Math.fround;
const HALF_PI = f32(Math.PI / 2);
const PI = f32(Math.PI);

export interface IdmParamsWorld {
  /** Max acceleration, world units / s². */
  readonly a: number;
  /** Comfortable deceleration. */
  readonly b: number;
  /** Hard braking clamp. */
  readonly bMax: number;
  /** Desired headway, s. */
  readonly tHeadway: number;
  /** Minimum gap, world units. */
  readonly s0: number;
  readonly delta: number;
}

function worldPerMeter(map: MapConfig, cfg: TrafficConfig): number {
  return f32(Math.max(map.tileSize, f32(0.1)) / Math.max(cfg.tileMeters, f32(0.1)));
}

export function kmhToWorldSpeed(map: MapConfig, cfg: TrafficConfig, kmh: number): number {
  return f32(f32(Math.max(kmh, 0) / f32(3.6)) * worldPerMeter(map, cfg));
}

function roadSpeedLimitWorld(map: MapConfig, cfg: TrafficConfig, tile: TilePos, grid: MapGrid): number {
  const i = grid.idx(tile);
  if (i === undefined || grid.water[i] !== 0 || grid.roadKind[i] === 0) return 0;
  return kmhToWorldSpeed(map, cfg, roadSpeedLimit(ROAD_KINDS[grid.roadKind[i]!]!));
}

export function idmParamsWorld(map: MapConfig, cfg: TrafficConfig): IdmParamsWorld {
  const wpm = worldPerMeter(map, cfg);
  const a = f32(Math.max(cfg.idmMaxAccelMps2, 0) * wpm);
  const b = f32(Math.max(cfg.idmComfortableDecelMps2, 0) * wpm);
  const bMax = f32(Math.max(cfg.idmMaxDecelMps2, 0) * wpm);
  const bFloor = Math.max(b, f32(0.1));
  return {
    a: Math.max(a, f32(0.1)),
    b: bFloor,
    bMax: Math.max(Math.max(bMax, f32(0.1)), bFloor),
    tHeadway: Math.max(cfg.idmDesiredHeadwaySecs, 0),
    s0: f32(Math.max(cfg.idmMinGapM, 0) * wpm),
    delta: Math.max(cfg.idmDelta, 1),
  };
}

/** IDM acceleration for speed `v` towards `v0` behind an optional `(gap_world, leader_speed)`. */
export function idmAccelWorld(v: number, v0: number, leader: readonly [number, number] | undefined, p: IdmParamsWorld): number {
  const speed = Math.max(v, 0);
  const desired = Math.max(v0, f32(0.1));
  const freeTerm = powIntF32(f32(speed / desired), Math.round(p.delta));
  let interaction = 0;
  if (leader !== undefined) {
    const s = Math.max(leader[0], f32(0.1));
    const limit = f32(desired * 2);
    const dv = Math.min(Math.max(f32(speed - leader[1]), -limit), limit);
    const sqrtAb = sqrtF32(Math.max(f32(p.a * p.b), f32(0.1)));
    let sStar = f32(p.s0 + f32(speed * p.tHeadway));
    sStar = f32(sStar + f32(f32(speed * dv) / f32(2 * sqrtAb)));
    sStar = Math.max(sStar, p.s0);
    const ratio = f32(sStar / s);
    interaction = f32(ratio * ratio);
  }
  const acc = f32(p.a * f32(f32(1 - freeTerm) - interaction));
  return Math.min(Math.max(acc, -p.bMax), p.a);
}

/**
 * Whether road capacity blocks the step onto the next tile: never into a box tile (reservations
 * govern those), never out of one (clear-the-box priority), otherwise when the tile is full.
 */
export function capacityBlocksStep(currentIsIntersection: boolean, nextIsIntersection: boolean, occ: number, cap: number): boolean {
  if (nextIsIntersection || currentIsIntersection) return false;
  return occ >= cap;
}

/** `cleanup_right_on_red_markers` (after moveVehicles): the marker lives only on the approach and in the box. */
export function cleanupRightOnRedMarkers(w: World): void {
  const v = w.vehicles;
  for (const slot of v.order) {
    if (v.parked[slot] === 1 || v.rightTurnOnRed[slot] === -1) continue;
    const cur = w.pathPool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
    if (cur === undefined) {
      v.rightTurnOnRed[slot] = -1;
      continue;
    }
    const id = v.rightTurnOnRed[slot]!;
    const next = w.pathPool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]! + 1);
    const inOrApproaching = w.intersections.intersectionIdAt(cur) === id || (next !== undefined && w.intersections.intersectionIdAt(next) === id);
    if (!inOrApproaching) v.rightTurnOnRed[slot] = -1;
  }
}

const minLeader = (current: readonly [number, number] | undefined, candidate: readonly [number, number]) =>
  current !== undefined && current[0] <= candidate[0] ? current : candidate;

/** Discrete heading of a tile step for the renderer (the sim itself never needs the angle). */
function stepHeading(from: TilePos, to: TilePos): number | undefined {
  if (to.x > from.x) return 0;
  if (to.x < from.x) return PI;
  if (to.y > from.y) return HALF_PI;
  if (to.y < from.y) return -HALF_PI;
  return undefined;
}

/** Takes the conflict-tile hold of `localIdx` for `ref`; an intersection without a matrix admits. */
function admitToBox(w: World, id: number, ref: number, localIdx: number): boolean {
  const matrix = w.laneletConflicts.byIntersection.get(id);
  return matrix === undefined || w.reservations.ledgerMut(id).tryAdmit(ref, localIdx, matrix, approachingLanelets(w.reservations, id, ref));
}

/** The wait point of a turn that could only take its wait prefix right now, as a route position of its center. */
function anticipatedWaitPoint(w: World, id: number, ref: number, localIdx: number, slot: number): number | undefined {
  const matrix = w.laneletConflicts.byIntersection.get(id);
  const ledger = w.reservations.ledger(id);
  if (matrix === undefined || ledger === undefined || matrix.waitLen(localIdx) === 0) return undefined;
  if (ledger.admission(ref, localIdx, matrix, approachingLanelets(w.reservations, id, ref)) !== 'wait') return undefined;
  return waitPointPos(w, id, localIdx, slot);
}

/** `move_vehicles` (TrafficStep::Movement). Despawns are applied after the loop, as Bevy commands are. */
export function moveVehicles(w: World, dtNs: number): void {
  const dt = f32(dtNs / 1e9);
  const map = w.mapConfig;
  const cfg = w.trafficConfig;
  const grid = w.grid;
  const pool = w.pathPool;
  const spatial = w.spatialIndex;
  const idm = idmParamsWorld(map, cfg);
  const tileSize = f32(Math.max(map.tileSize, f32(0.1)));
  const v = w.vehicles;
  const serviceRole = VEHICLE_ROLES.indexOf('service');
  const tripRole = VEHICLE_ROLES.indexOf('trip');
  const despawns: number[] = [];
  // Pedestrians on each intersection's crossings: bit 0 walks N/S, bit 1 walks E/W.
  const pedAxisMask = new Map<number, number>();
  for (const p of w.pedestrianCrossings) {
    pedAxisMask.set(p.intersectionId, (pedAxisMask.get(p.intersectionId) ?? 0) | (p.axisNs ? 1 : 2));
  }

  for (const slot of [...v.order]) {
    if (v.parked[slot] === 1) continue;
    const ref = vehicleRef(v, slot);
    const handle = v.pathHandle[slot]!;
    const len = pool.len(handle);
    const isPersistent = v.role[slot] !== tripRole;

    if (len === 0 || v.pathCursor[slot]! >= len) {
      if (!isPersistent) {
        if (v.passengerCitizen[slot] !== -1) {
          w.events.tripFinished.push({ citizen: v.passengerCitizen[slot]!, purpose: TRIP_PURPOSES[v.passengerPurpose[slot]!]! });
        }
        despawns.push(ref);
      }
      continue;
    }

    const cursor = v.pathCursor[slot]!;
    const currentTile = pool.getTile(handle, cursor);
    if (currentTile === undefined) continue;
    const prevTile = cursor > 0 ? pool.getTile(handle, cursor - 1) : undefined;
    const nextTile = pool.getTile(handle, cursor + 1);
    const currentIsIntersection = isIntersectionTile(grid, currentTile);

    // Desired speed: box tiles take the limit of the adjacent approach and exit tiles.
    let speedLimit = currentIsIntersection ? 0 : roadSpeedLimitWorld(map, cfg, currentTile, grid);
    if (prevTile !== undefined && !isIntersectionTile(grid, prevTile)) {
      speedLimit = Math.max(speedLimit, roadSpeedLimitWorld(map, cfg, prevTile, grid));
    }
    if (nextTile !== undefined && !isIntersectionTile(grid, nextTile)) {
      speedLimit = Math.max(speedLimit, roadSpeedLimitWorld(map, cfg, nextTile, grid));
    }
    if (speedLimit <= 0) {
      speedLimit = v.maxSpeed[slot]!;
      if (prevTile !== undefined && !isIntersectionTile(grid, prevTile)) {
        const prevSpeed = roadSpeedLimitWorld(map, cfg, prevTile, grid);
        if (prevSpeed > 0) speedLimit = prevSpeed;
      }
      if (nextTile !== undefined && !isIntersectionTile(grid, nextTile)) {
        const nextSpeed = roadSpeedLimitWorld(map, cfg, nextTile, grid);
        if (nextSpeed > 0) speedLimit = Math.max(speedLimit, nextSpeed);
      }
    }
    const speedFactor = v.speedFactor[slot]!;
    const profileFactor =
      v.role[slot] === serviceRole
        ? SERVICE_VEHICLE_SPEED_LIMIT_FACTOR
        : Number.isFinite(speedFactor)
          ? Math.min(Math.max(speedFactor, DRIVER_PROFILE_FACTOR_MIN), DRIVER_PROFILE_FACTOR_MAX)
          : DRIVER_PROFILE_MEDIUM_FACTOR;
    let v0 = Math.max(Math.min(f32(speedLimit * profileFactor), v.maxSpeed[slot]!), 0);
    const ror = v.rightTurnOnRed[slot]!;
    if (ror !== -1) {
      const curId = w.intersections.intersectionIdAt(currentTile);
      const nextId = nextTile === undefined ? undefined : w.intersections.intersectionIdAt(nextTile);
      if (curId === ror || nextId === ror) v0 = Math.min(v0, kmhToWorldSpeed(map, cfg, RIGHT_ON_RED_TURN_MAX_KMH));
    }

    // Leaders: the same-tile one, the first vehicle on the next tile, virtual leaders below.
    let leader = spatial.leaderSameTile(ref);
    const progress0 = v.progress[slot]!;
    const nextIdx = nextTile === undefined ? undefined : grid.idx(nextTile);
    const nextLead = nextIdx === undefined ? undefined : spatial.tileMinProgressSpeed(nextIdx);
    if (nextLead !== undefined) {
      const gapTiles = f32(f32(1 - progress0) + nextLead[0]);
      const gapWorld = Math.max(f32(f32(Math.max(gapTiles, 0) * tileSize) - f32(VEHICLE_LENGTH_TILES * tileSize)), 0);
      leader = minLeader(leader, [gapWorld, nextLead[1]]);
    }
    // Nobody on this tile or the next: look further along the route for the car ahead, so a follower
    // brakes for a queue in time. The scan stops at the first vehicle and never looks into a box.
    let farLead: readonly [offset: number, progress: number, speed: number] | undefined;
    if (leader === undefined && nextLead === undefined && nextTile !== undefined && !isIntersectionTile(grid, nextTile)) {
      for (let k = 2; k <= LEADER_LOOKAHEAD_TILES; k++) {
        const ahead = pool.getTile(handle, cursor + k);
        if (ahead === undefined || isIntersectionTile(grid, ahead)) break;
        const aheadIdx = grid.idx(ahead);
        const first = aheadIdx === undefined ? undefined : spatial.tileMinProgressSpeed(aheadIdx);
        if (first !== undefined) {
          farLead = [k, first[0], first[1]];
          break;
        }
      }
    }
    if (farLead !== undefined) {
      const gapTiles = f32(f32(farLead[0] - progress0) + farLead[1]);
      const gapWorld = Math.max(f32(f32(gapTiles * tileSize) - f32(VEHICLE_LENGTH_TILES * tileSize)), 0);
      leader = minLeader(leader, [gapWorld, farLead[2]]);
    }
    const state = v.trafficState[slot]!;
    if (state.kind === 'Approaching') {
      // Shifted by s0 so the vehicle rests at the stop line, not s0 behind it.
      leader = minLeader(leader, [f32(f32(Math.max(state.distanceToStop, 0) * tileSize) + idm.s0), 0]);
    }

    let blockedNext = false;
    let blockedNextIsIntersection = false;
    let clampToBoxBoundary = false;
    /** The hold to take if this tick's move reaches the box boundary. */
    let pendingAdmit: { readonly id: number; readonly localIdx: number } | undefined;
    /** Route position where the center of a turn yielding inside the box stops. */
    let waitPoint: number | undefined;
    if (nextTile !== undefined) {
      const nextIsIntersection = isIntersectionTile(grid, nextTile);
      if (nextIsIntersection && !currentIsIntersection) {
        blockedNextIsIntersection = true;
        if (state.kind === 'WaitingForGreen') {
          blockedNext = true;
        } else {
          // Deferred-reservation entry gate: the conflict-tile hold is taken at the box boundary.
          const atBoundary = progress0 >= TILE_CENTER_TO_EDGE_TILES;
          const id = w.intersections.intersectionIdAt(nextTile);
          let ok = false;
          const res = id === undefined ? undefined : w.reservations.entryReservation(id, ref);
          if (id !== undefined && res !== undefined) {
            if (res.coarse) ok = true;
            else if (res.localIdx !== null) {
              if (atBoundary) {
                ok = admitToBox(w, id, ref, res.localIdx);
              } else {
                clampToBoxBoundary = true;
                pendingAdmit = { id, localIdx: res.localIdx };
                ok = true;
              }
              // A turn that will have to yield inside the box brakes for its wait point already.
              if (ok) waitPoint = anticipatedWaitPoint(w, id, ref, res.localIdx, slot);
            } else ok = true;
          }
          if (!ok) blockedNext = true;
          // Yield to pedestrians already crossing: any at an uncontrolled box; at a signalized one a
          // left turn always, a right turn when a pedestrian is on the roadway it turns onto.
          const mask = id === undefined ? 0 : (pedAxisMask.get(id) ?? 0);
          if (!blockedNext && id !== undefined && mask !== 0) {
            if (!w.intersections.trafficLights.has(id)) {
              blockedNext = true;
            } else {
              const entryDir = dirBetweenAdjacent(currentTile, nextTile);
              const exitDir = computeExitDirection(pool.remainingFrom(handle, cursor) ?? [], grid, nextTile);
              if (entryDir !== 'None' && exitDir !== 'None') {
                const right = cfg.driveOnRight ? dirRight(entryDir) : dirLeft(entryDir);
                const left = cfg.driveOnRight ? dirLeft(entryDir) : dirRight(entryDir);
                if (exitDir === left) {
                  blockedNext = true;
                } else if (exitDir === right) {
                  const conflictsNs = exitDir === 'East' || exitDir === 'West';
                  const conflictsEw = exitDir === 'North' || exitDir === 'South';
                  if ((conflictsNs && (mask & 1) !== 0) || (conflictsEw && (mask & 2) !== 0)) blockedNext = true;
                }
              }
            }
          }
        }
      }
      if (nextIdx !== undefined && nextIdx < w.trafficOccupancy.perTickVehicles.length && grid.roadKind[nextIdx] !== 0) {
        const cap = capacityPerLaneTile(ROAD_KINDS[grid.roadKind[nextIdx]!]!);
        const occ = w.trafficOccupancy.perTickVehicles[nextIdx]!;
        if (capacityBlocksStep(currentIsIntersection, nextIsIntersection, occ, cap)) blockedNext = true;
      }
    }

    if (currentIsIntersection) {
      const id = w.intersections.intersectionIdAt(currentTile);
      const hold = id === undefined ? undefined : w.reservations.ledger(id)?.holdOf(ref);
      if (id !== undefined && hold !== undefined && !hold.committed) waitPoint = waitPointPos(w, id, hold.localIdx, slot);
    }
    if (waitPoint !== undefined) {
      const gapTiles = Math.max(f32(f32(waitPoint - STOP_LINE_MARGIN_TILES) - f32(cursor + progress0)), 0);
      leader = minLeader(leader, [f32(f32(gapTiles * tileSize) + idm.s0), 0]);
    }

    if (blockedNext) {
      const gapTiles = blockedNextIsIntersection
        ? Math.max(f32(f32(TILE_CENTER_TO_EDGE_TILES - progress0) - STOP_LINE_OFFSET), 0)
        : Math.max(f32(1 - progress0), 0);
      let gapWorld = f32(gapTiles * tileSize);
      if (blockedNextIsIntersection) gapWorld = f32(gapWorld + idm.s0);
      leader = minLeader(leader, [gapWorld, 0]);
    }

    // No reversing: Rust let a stuck car back up within its tile, which freed nothing and rocked the car
    // at the tile start. A stuck car waits; recovery re-routes or removes it.
    if (v0 > 0) {
      const accel = idmAccelWorld(v.speed[slot]!, v0, leader, idm);
      v.speed[slot] = Math.min(Math.max(f32(v.speed[slot]! + f32(accel * dt)), 0), v0);
    } else {
      v.speed[slot] = 0;
    }

    const desiredDprog = f32(f32(v.speed[slot]! * dt) / tileSize);
    const prevP = progress0;
    const denom = Math.max(dt, f32(1e-6));

    if (nextTile !== undefined && blockedNext) {
      const maxP = blockedNextIsIntersection ? Math.max(TILE_CENTER_TO_EDGE_TILES, prevP) : f32(1 - f32(0.001));
      const desiredP = f32(prevP + desiredDprog);
      const nextP = Math.min(desiredP, maxP);
      v.progress[slot] = nextP;
      if (nextP < desiredP) {
        const actual = Math.max(f32(nextP - prevP), 0);
        v.speed[slot] = f32(f32(actual * tileSize) / denom);
      }
    } else {
      let nextP = f32(prevP + desiredDprog);
      const minGapTiles = Math.max(f32(f32(idm.s0 + f32(VEHICLE_LENGTH_TILES * tileSize)) / tileSize), 0);
      let leaderCap: number | undefined;
      const leadP = spatial.leaderSameTileProgress(ref);
      if (leadP !== undefined) leaderCap = f32(leadP - minGapTiles);
      if (nextLead !== undefined) {
        const cap = f32(f32(1 + nextLead[0]) - minGapTiles);
        leaderCap = leaderCap === undefined ? cap : Math.min(leaderCap, cap);
      }
      if (farLead !== undefined) {
        const cap = f32(f32(farLead[0] + farLead[1]) - minGapTiles);
        leaderCap = leaderCap === undefined ? cap : Math.min(leaderCap, cap);
      }
      if (leaderCap !== undefined) {
        const maxP = Math.max(leaderCap, prevP);
        if (nextP > maxP) {
          nextP = maxP;
          const actual = Math.max(f32(nextP - prevP), 0);
          v.speed[slot] = f32(f32(actual * tileSize) / denom);
        }
      }
      v.progress[slot] = nextP;
    }

    // Boundary: a car reaching the box this tick takes its conflict-tile hold now and keeps its speed.
    // Only a refused hold stops it on the line (Rust took the hold a tick later, after stopping there).
    if (clampToBoxBoundary) {
      const boundaryCap = Math.max(TILE_CENTER_TO_EDGE_TILES, prevP);
      if (v.progress[slot]! > boundaryCap) {
        const admitted = pendingAdmit !== undefined && admitToBox(w, pendingAdmit.id, ref, pendingAdmit.localIdx);
        if (!admitted) {
          v.progress[slot] = boundaryCap;
          const allowed = f32(f32(f32(v.progress[slot]! - prevP) * tileSize) / denom);
          v.speed[slot] = Math.min(v.speed[slot]!, Math.max(0, allowed));
        }
      }
    }

    // A turn holding only its wait prefix stops inside the box, its front at the end of the prefix.
    const boxTile = currentIsIntersection ? currentTile : nextTile;
    const boxId = boxTile === undefined || !isIntersectionTile(grid, boxTile) ? undefined : w.intersections.intersectionIdAt(boxTile);
    const hold = boxId === undefined ? undefined : w.reservations.ledger(boxId)?.holdOf(ref);
    const limit = boxId === undefined || hold === undefined || hold.committed ? undefined : waitPointPos(w, boxId, hold.localIdx, slot);
    if (limit !== undefined) {
      const cap = Math.max(f32(limit - cursor), prevP);
      if (v.progress[slot]! > cap) {
        v.progress[slot] = cap;
        v.speed[slot] = Math.min(v.speed[slot]!, Math.max(0, f32(f32(f32(cap - prevP) * tileSize) / denom)));
      }
    }

    let lastTileForArrival = pool.getTile(handle, v.pathCursor[slot]!) ?? { x: 0, y: 0 };
    while (v.progress[slot]! >= 1 && v.pathCursor[slot]! < len) {
      v.progress[slot] = f32(v.progress[slot]! - 1);
      lastTileForArrival = pool.getTile(handle, v.pathCursor[slot]!) ?? lastTileForArrival;
      v.pathCursor[slot] = v.pathCursor[slot]! + 1;
    }

    if (v.pathCursor[slot]! >= len) {
      if (!isPersistent) {
        const hasPassenger = v.passengerCitizen[slot] !== -1;
        if (hasPassenger) {
          w.events.tripFinished.push({ citizen: v.passengerCitizen[slot]!, purpose: TRIP_PURPOSES[v.passengerPurpose[slot]!]! });
        }
        if (v.carOwner[slot] !== -1 && hasPassenger) {
          // An owned car parks where it arrived and waits for its citizen's next trip.
          pool.release(handle);
          v.pathHandle[slot] = pool.intern([lastTileForArrival]);
          v.pathCursor[slot] = 0;
          v.progress[slot] = 0;
          v.speed[slot] = 0;
          v.parked[slot] = 1;
          v.parkedOffset[slot] = 1;
          // Off the road, on the lot the trip was for: Rust left the car standing on its last lane tile.
          if (v.parkX[slot]! >= 0) {
            const lot = tileToWorld(map, { x: v.parkX[slot]!, y: v.parkY[slot]! });
            // Cars on one lot stand side by side, in a 3×3 pattern by slot.
            const k = slot % 9;
            const step = f32(map.tileSize * 0.3);
            v.x[slot] = f32(lot.x + f32(((k % 3) - 1) * step));
            v.y[slot] = f32(lot.y + f32((((k / 3) | 0) - 1) * step));
            v.prevX[slot] = v.x[slot]!;
            v.prevY[slot] = v.y[slot]!;
          }
          setTrafficState(v, slot, FREE_FLOW);
          v.passengerCitizen[slot] = -1;
          v.rightTurnOnRed[slot] = -1;
        } else {
          despawns.push(ref);
        }
      }
      continue;
    }

    const curr = pool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
    if (curr === undefined) continue;
    const next = pool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]! + 1) ?? curr;
    const a = tileToWorld(map, curr);
    const b = tileToWorld(map, next);
    const s = Math.min(Math.max(v.progress[slot]!, 0), 1);
    v.prevX[slot] = v.x[slot]!;
    v.prevY[slot] = v.y[slot]!;
    v.x[slot] = f32(a.x + f32(f32(b.x - a.x) * s));
    v.y[slot] = f32(a.y + f32(f32(b.y - a.y) * s));
    const heading = stepHeading(curr, next);
    if (heading !== undefined) v.heading[slot] = heading;
  }

  for (const ref of despawns) despawnVehicle(w, ref);
}
