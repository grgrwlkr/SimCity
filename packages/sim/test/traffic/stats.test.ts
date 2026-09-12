// The traffic summary the HUD shows: counts and averages read off the vehicles, no state of its own.
import { describe, expect, it } from 'vitest';
import { kmhToWorldSpeed } from '../../src/traffic/drive';
import { summarizeTraffic } from '../../src/traffic/stats';
import { spawnVehicle } from '../../src/traffic/vehicles';
import { createWorld } from '../../src/world';

describe('traffic summary', () => {
  it('countsDrivingParkedWaitingAndStuckCars', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    const route = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ];
    spawnVehicle(w, { route, speed: kmhToWorldSpeed(w.mapConfig, w.trafficConfig, 40) });
    spawnVehicle(w, {
      route,
      state: { kind: 'WaitingForGreen', intersection: 'box', stopTile: { x: 2, y: 1 } },
      motion: { stoppedSecs: 70 },
    });
    spawnVehicle(w, { route: [{ x: 3, y: 3 }], parkedOffset: 1 });
    w.tripBacklog.push({ citizen: 1, from: { x: 0, y: 0 }, carParkedAt: null, to: { x: 1, y: 1 }, purpose: 'Work', mode: 'Car' });
    w.trafficIndex.avgCongestion = 0.25;

    const summary = summarizeTraffic(w);
    expect({ ...summary, avgSpeedKmh: Math.round(summary.avgSpeedKmh) }).toEqual({
      driving: 2,
      parked: 1,
      waitingAtLights: 1,
      stuckOverMinute: 1,
      avgSpeedKmh: 20,
      backlog: 1,
      avgCongestionPct: 25,
    });
  });

  it('anEmptyCityHasNoAverageSpeed', () => {
    expect(summarizeTraffic(createWorld({ mapWidth: 8, mapHeight: 8 })).avgSpeedKmh).toBe(0);
  });
});
