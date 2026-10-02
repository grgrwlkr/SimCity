import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';
import { createCity } from '../src/city/model';
import { Harbor, freightPlans } from '../src/city/harbor';
import { CityTraffic } from '../src/city/trafficFlow';
import { AMBIENT_VEHICLES, FREIGHT_JUNCTIONS, cityVehicleKits } from '../src/city/harborLayout';

describe('working city harbor', () => {
  it.each(['689856', 'harbor'])(
    'keeps imports, exports and all freight trucks moving over repeated visits for %s',
    (seed) => {
      const harbor = new Harbor();
      const traffic = new CityTraffic(cityVehicleKits(seed), {
        plans: freightPlans(),
        junctions: FREIGHT_JUNCTIONS,
        onStep: (seconds, traffic) => harbor.advance(seconds, traffic),
        onReset: () => harbor.reset(),
      });
      let previous = traffic.update(0);
      const recentTravel = [0, 0, 0, 0];
      for (let seconds = 1; seconds <= 600; seconds++) {
        const poses = traffic.update(seconds);
        if (seconds > 360) {
          for (let i = 0; i < 4; i++) {
            const id = AMBIENT_VEHICLES + i;
            recentTravel[i]! += Math.hypot(poses[id]!.x - previous[id]!.x, poses[id]!.z - previous[id]!.z);
          }
        }
        const status = harbor.status();
        expect(status.created).toBe(status.activeCargo + status.delivered + status.exported);
        const snapshot = harbor.snapshot(seconds, poses);
        expect(new Set(snapshot.cargo.map((c) => c.slot)).size).toBe(snapshot.cargo.length);
        expect(
          new Set(
            snapshot.cargo.map((c) =>
              JSON.stringify(
                c.place.kind === 'receiving' ? { kind: 'receiving', warehouse: c.place.warehouse } : c.place,
              ),
            ),
          ).size,
        ).toBe(snapshot.cargo.length);
        previous = poses;
      }
      expect(Math.min(...recentTravel)).toBeGreaterThan(100);
      expect(harbor.status().delivered).toBeGreaterThanOrEqual(9);
      expect(harbor.status().exported).toBeGreaterThanOrEqual(9);
    },
    120_000,
  );
  it('provides a working vessel and four freight trucks, and records imports and exports', () => {
    const city = createCity(generateCity('689856'));
    try {
      expect(city.harborStatus).toBeTypeOf('function');
      const start = city.harborStatus();
      expect(start.freightTrucks).toBe(4);
      expect(start.shipPhase).toBe('unloading');
      city.update(300);
      const end = city.harborStatus();
      expect(end.delivered).toBeGreaterThan(0);
      expect(end.exported).toBeGreaterThan(0);
      expect(end.departedEmpty).toBeGreaterThan(0);
      expect(end.departedLoaded).toBeGreaterThan(0);
      city.update(0);
      expect(city.harborStatus()).toEqual(start);
    } finally {
      city.dispose();
    }
  }, 30_000);
});
