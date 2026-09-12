// A summary of the traffic for the HUD: counts and averages read off the vehicles, no state of its own.
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
  /** Car trips waiting for a tick that can serve them. */
  readonly backlog: number;
  readonly avgCongestionPct: number;
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
  return {
    driving,
    parked,
    waitingAtLights,
    stuckOverMinute,
    avgSpeedKmh: driving === 0 ? 0 : (speedSum / driving / worldPerMeter) * 3.6,
    backlog: w.tripBacklog.length,
    avgCongestionPct: w.trafficIndex.avgCongestion * 100,
  };
}
