// A summary of the traffic for the HUD: counts and averages read off the micro vehicles and the meso cars, no state of
// its own.
import { linkRoomMeters } from '../meso/traffic';
import type { World } from '../world';
import { STUCK_REROUTE_SECS } from './constants';

export interface TrafficSummary {
  readonly driving: number;
  readonly parked: number;
  /** Stopped at a stop line or waiting for green. */
  readonly waitingAtLights: number;
  /** Driving cars that have not moved on for a minute or more. */
  readonly stuckOverMinute: number;
  readonly avgSpeedKmh: number;
  /** Car trips waiting for a tick that can serve them, or for room on their first link. */
  readonly backlog: number;
  readonly avgCongestionPct: number;
  /** Trucks on the road. */
  readonly trucks: number;
  /** Citizens on foot. */
  readonly pedestrians: number;
  /** Vehicles of the region on the road: commuters, visitors, through traffic and trucks. */
  readonly regional: number;
}

export function summarizeTraffic(w: World): TrafficSummary {
  const v = w.vehicles;
  let driving = 0;
  let parked = 0;
  let waitingAtLights = 0;
  let stuckOverMinute = 0;
  let speedSum = 0;
  for (const slot of v.order) {
    if (v.parked[slot] === 1) {
      parked += 1;
      continue;
    }
    driving += 1;
    const kind = v.trafficState[slot]!.kind;
    if (kind === 'WaitingForGreen' || kind === 'Stopped') waitingAtLights += 1;
    if (v.stoppedSecs[slot]! >= STUCK_REROUTE_SECS) stuckOverMinute += 1;
    speedSum += v.speed[slot]!;
  }
  const worldPerMeter = w.mapConfig.tileSize / w.trafficConfig.tileMeters;
  const microKmh = (speedSum / worldPerMeter) * 3.6;

  // A meso car drives at its link's limit until its time on the link is up, and stands after that.
  const meso = w.mesoTraffic;
  const g = w.meso;
  let mesoKmh = 0;
  // Cars that hold the spot they drive to: a citizen's, or a car of the region driving in.
  let holdingSpots = 0;
  for (let car = 0; car < meso.highWater; car++) {
    const link = meso.link[car]!;
    if (link < 0) continue;
    if (meso.readySec[car]! > meso.nowSec) mesoKmh += g.speedKmh[link] ?? 0;
    const citizen = meso.citizen[car]!;
    if (citizen >= 0 || w.regional.holdsSpotWhileDriving(-citizen - 1)) holdingSpots += 1;
  }
  let load = 0;
  let loaded = 0;
  for (let link = 0; link < meso.onLink.length && link < g.linkCount; link++) {
    if (meso.onLink[link] === 0) continue;
    load += Math.min(meso.usedMeters[link]! / linkRoomMeters(w, link), 1);
    loaded += 1;
  }
  const mesoDriving = meso.carCount();
  const total = driving + mesoDriving;
  return {
    driving: total,
    parked: parked + Math.max(w.parking.totalUsed() - holdingSpots, 0),
    waitingAtLights: waitingAtLights + meso.waitingAtLights(),
    stuckOverMinute: stuckOverMinute + meso.stuckOverMinute(),
    avgSpeedKmh: total === 0 ? 0 : (microKmh + mesoKmh) / total,
    backlog: w.tripBacklog.length + meso.pending.length,
    avgCongestionPct: driving > 0 ? w.trafficIndex.avgCongestion * 100 : loaded > 0 ? (load / loaded) * 100 : 0,
    trucks: meso.trucks,
    pedestrians: w.citizens.onFootCount,
    regional: w.regional.drivingCount,
  };
}
