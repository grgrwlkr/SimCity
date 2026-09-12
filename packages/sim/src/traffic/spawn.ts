// Port of crates/simcity_sim/src/game/traffic/spawn.rs: trip requests become vehicles. A car trip drives
// the citizen's own parked car when there is one, from the road beside where it is parked; the route
// is planned lanelet-first. Requests the tick cannot serve wait in a backlog instead of being lost.
import type { TripRequested } from '../events';
import { tileToWorld } from '../map/coords';
import { randomBool, rangeF32 } from '../rng';
import { adjacentRoadTowards } from '../transport/anchors';
import type { World } from '../world';
import {
  DRIVER_MAX_SPEED_KMH_MAX,
  DRIVER_MAX_SPEED_KMH_MIN,
  DRIVER_PROFILE_FACTOR_MAX,
  DRIVER_PROFILE_FACTOR_MIN,
  DRIVER_PROFILE_MEDIUM_FACTOR,
  DRIVER_PROFILE_MEDIUM_SHARE,
  SPAWN_THROTTLE_AVG_CONG,
} from './constants';
import { idmParamsWorld, kmhToWorldSpeed } from './drive';
import { applyRoute, planTilesLaneletFirst } from './reroute';
import { FREE_FLOW, TRIP_PURPOSES, refSlot, setTrafficState, spawnVehicle } from './vehicles';

const f32 = Math.fround;
const F32_EPSILON = f32(1.1920929e-7);

/** A driver's speed factor: the medium profile for `DRIVER_PROFILE_MEDIUM_SHARE` of drivers, otherwise any other in the band. */
export function sampleDriverSpeedFactor(w: World): number {
  if (randomBool(w.simRng, DRIVER_PROFILE_MEDIUM_SHARE)) return DRIVER_PROFILE_MEDIUM_FACTOR;
  for (;;) {
    const factor = rangeF32(w.simRng, DRIVER_PROFILE_FACTOR_MIN, DRIVER_PROFILE_FACTOR_MAX);
    if (Math.abs(f32(factor - DRIVER_PROFILE_MEDIUM_FACTOR)) > F32_EPSILON) return factor;
  }
}

/** A driver's own top speed, 90–130 km/h in world units, so even fast roads show different drivers. */
export function sampleDriverMaxSpeed(w: World): number {
  return kmhToWorldSpeed(w.mapConfig, w.trafficConfig, rangeF32(w.simRng, DRIVER_MAX_SPEED_KMH_MIN, DRIVER_MAX_SPEED_KMH_MAX));
}

/**
 * `spawn_trip_vehicles` (TrafficStep::Flow, after the traffic states): the backlog first, then this
 * tick's requests. While the network is jammed, the plan budget is spent or the vehicle cap is
 * reached, the remaining car trips wait for a later tick (up to the vehicle cap of them); a trip with
 * no road beside its ends or no legal route is dropped. Walks belong to pedestrians.
 */
export function spawnTripVehicles(w: World): void {
  const cfg = w.trafficConfig;
  const v = w.vehicles;
  const idm = idmParamsWorld(w.mapConfig, cfg);
  // The city as a whole: Rust also stopped on its single most congested tile, so one stuck car froze
  // every trip in town.
  const jammed = w.trafficIndex.avgCongestion >= SPAWN_THROTTLE_AVG_CONG;
  let active = 0;
  for (const slot of v.order) if (v.parked[slot] !== 1) active += 1;
  let planned = 0;

  const trips: TripRequested[] = [...w.tripBacklog, ...w.events.tripRequested].filter((trip) => trip.mode === 'Car');
  w.tripBacklog.length = 0;
  for (let i = 0; i < trips.length; i++) {
    if (jammed || planned >= cfg.maxRoutePlansPerTick || active >= cfg.maxActiveVehicles) {
      w.tripBacklog.push(...trips.slice(i, i + Math.max(cfg.maxActiveVehicles, 0)));
      break;
    }
    const trip = trips[i]!;
    const start = adjacentRoadTowards(w.grid, trip.carParkedAt ?? trip.from, trip.to);
    const goal = adjacentRoadTowards(w.grid, trip.to, trip.from);
    if (start === undefined || goal === undefined) continue;
    const route = planTilesLaneletFirst(w, start, goal);
    if (route === undefined) continue;
    if (route.producer === 'Lanelet') w.routeProducerStats.spawnLanelet += 1;
    else w.routeProducerStats.spawnRoadFallback += 1;

    // Driver behaviour belongs to the trip: a fresh profile every time, a reused car included.
    const speedFactor = sampleDriverSpeedFactor(w);
    const maxSpeed = sampleDriverMaxSpeed(w);
    // A destination off the road is the lot the car parks on; one on the road, where the route ends.
    const toCell = w.grid.get(trip.to);
    const lot = toCell !== undefined && toCell.road.kind === 'None' && !toCell.water ? trip.to : undefined;
    const own = v.order.find((slot) => v.parked[slot] === 1 && v.carOwner[slot] === trip.citizen);
    if (own === undefined) {
      const ref = spawnVehicle(w, {
        route: route.tiles,
        speedFactor,
        maxSpeed,
        maxAccel: idm.a,
        passenger: { citizen: trip.citizen, purpose: trip.purpose },
        carOwner: trip.citizen,
      });
      const slot = refSlot(v, ref);
      v.laneletPlan[slot] = { entries: [...route.sidecar], builtFor: route.builtFor };
      v.parkX[slot] = lot?.x ?? -1;
      v.parkY[slot] = lot?.y ?? -1;
    } else {
      v.parkX[own] = lot?.x ?? -1;
      v.parkY[own] = lot?.y ?? -1;
      applyRoute(w, own, route);
      const at = tileToWorld(w.mapConfig, start);
      v.x[own] = at.x;
      v.y[own] = at.y;
      v.prevX[own] = at.x;
      v.prevY[own] = at.y;
      v.tileX[own] = start.x;
      v.tileY[own] = start.y;
      v.speed[own] = 0;
      v.maxSpeed[own] = maxSpeed;
      v.speedFactor[own] = speedFactor;
      v.maxAccel[own] = idm.a;
      v.parked[own] = 0;
      v.parkedOffset[own] = 0;
      v.rightTurnOnRed[own] = -1;
      v.passengerCitizen[own] = trip.citizen;
      v.passengerPurpose[own] = TRIP_PURPOSES.indexOf(trip.purpose);
      // It stood parked: its timers start over rather than carry what it had on arrival.
      v.stuckSecs[own] = 0;
      v.stuckLastTileX[own] = start.x;
      v.stuckLastTileY[own] = start.y;
      v.stuckLastProgress[own] = 0;
      v.stoppedSecs[own] = 0;
      v.movingSecs[own] = 0;
      v.stuckRetryTick[own] = 0;
      v.stuckRerouted[own] = 0;
      v.anchorX[own] = at.x;
      v.anchorY[own] = at.y;
      setTrafficState(v, own, FREE_FLOW);
    }
    planned += 1;
    active += 1;
  }
}
