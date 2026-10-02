import { describe, expect, it } from 'vitest';
import { vehicleKit } from '../src/city/assetKits';
import { CityTraffic } from '../src/city/trafficFlow';

describe('city traffic queues', () => {
  it.each(['689856', 'harbor'])(
    'keeps traffic flowing without jumps or permanent queues for %s',
    (seed) => {
      const traffic = new CityTraffic(Array.from({ length: 112 }, (_, id) => vehicleKit(seed, id)));
      let previous = traffic.update(0);
      const travel = new Float64Array(112),
        waiting = new Uint16Array(112);
      let longestStop = 0;
      for (let seconds = 1; seconds <= 120; seconds++) {
        const current = traffic.update(seconds);
        for (let id = 0; id < current.length; id++) {
          const from = previous[id]!,
            to = current[id]!;
          const distance = Math.hypot(to.x - from.x, to.z - from.z);
          expect(distance).toBeLessThanOrEqual(5.501);
          travel[id]! += distance;
          waiting[id] = distance < 0.02 ? waiting[id]! + 1 : 0;
          longestStop = Math.max(longestStop, waiting[id]!);
        }
        previous = current;
      }
      expect(Math.min(...travel)).toBeGreaterThan(100);
      expect(longestStop).toBeLessThan(30);
    },
    20_000,
  );

  it('reproduces positions across frame rates and when the scene time is reset', () => {
    const sizes = Array.from({ length: 112 }, (_, id) => vehicleKit('689856', id));
    const coarse = new CityTraffic(sizes),
      fine = new CityTraffic(sizes);
    const expected = coarse.update(30);
    for (let frame = 1; frame <= 1_800; frame++) {
      fine.update(frame / 60);
    }
    expect(fine.update(30)).toEqual(expected);
    coarse.update(0);
    expect(coarse.update(30)).toEqual(expected);
  }, 20_000);
});
