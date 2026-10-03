import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {
  createLifeProfile,
  DIRECTIONS,
  LifeNetwork,
  parkingRoute,
  rightOf,
  sampleWalk,
  pathLength,
} from '../src/city/life/network';
import {sampleLaneRoute} from '../src/city/trafficRoutes';

describe('compact curb parking', () => {
  it('fits a car-width extension and places both spaces together along the street', () => {
    const p = createLifeProfile(generateCity('689856'));

    for (const f of p.facilities.filter(f => f.kind === 'street')) {
      const r = rightOf(f.road.direction);
      const laneToStall =
        (f.entrance.x - f.road.point.x) * r.x +
        (f.entrance.z - f.road.point.z) * r.z;
      const slots = f.slots.map(id => p.slots[id]!);

      expect(slots[0]!.width).toBeLessThanOrEqual(2.1);
      expect(laneToStall).toBeCloseTo(3.05);
      expect(
        Math.hypot(
          slots[0]!.position.x - slots[1]!.position.x,
          slots[0]!.position.z - slots[1]!.position.z,
        ),
      ).toBeLessThanOrEqual(5.8 + 1e-7);

      for (const s of slots) {
        const route = parkingRoute(f, s, true).route;
        const end = sampleLaneRoute(route, route.length);

        expect(end.x).toBeCloseTo(s.position.x);
        expect(end.z).toBeCloseTo(s.position.z);
      }
    }
  });
  it('uses interior street segments and keeps their walking routes behind the parked cars', () => {
    const p = createLifeProfile(generateCity('689856'));
    const net = new LifeNetwork(p.layout);
    const interior = p.facilities.filter(
      f =>
        f.kind === 'street' &&
        Math.abs(f.road.point.x) < 115 &&
        Math.abs(f.road.point.z) < 115,
    );

    expect(interior.length).toBeGreaterThan(0);

    for (const f of interior) {
      const d = DIRECTIONS[f.road.direction]!;
      const r = rightOf(f.road.direction);
      const center = {
        x: f.entrance.x - r.x * 5.05,
        z: f.entrance.z - r.z * 5.05,
      };
      const a = {
        x: center.x - d.x * 12 + r.x * 4.45,
        z: center.z - d.z * 12 + r.z * 4.45,
      };
      const b = {
        x: center.x + d.x * 12 + r.x * 4.45,
        z: center.z + d.z * 12 + r.z * 4.45,
      };
      const route = net.walk(net.access(a, []), net.access(b, []));

      for (let distance = 0; distance < pathLength(route); distance += 0.2) {
        const pose = sampleWalk(route, distance);

        for (const id of f.slots) {
          const s = p.slots[id]!;
          const dx = pose.x - s.position.x;
          const dz = pose.z - s.position.z;
          const along = Math.abs(dx * d.x + dz * d.z);
          const across = Math.abs(dx * r.x + dz * r.z);

          expect(along >= s.length / 2 || across >= s.width / 2 + 0.2).toBe(
            true,
          );
        }
      }
    }
  });
});

it('enters and leaves a compact space without clipping the car next to it', () => {
  const profile = createLifeProfile(generateCity('689856'));

  type Pose = ReturnType<typeof sampleLaneRoute>;
  const corners = (p: Pose, length: number, width: number) =>
    [-1, 1].flatMap(a =>
      [-1, 1].map(b => ({
        x: p.x + (p.dx * a * length) / 2 - (p.dz * b * width) / 2,
        z: p.z + (p.dz * a * length) / 2 + (p.dx * b * width) / 2,
      })),
    );
  const intersects = (moving: Pose, parked: Pose) => {
    const a = corners(moving, 4.2, 1.9);
    const b = corners(parked, 3.8, 1.5);

    return [moving, parked]
      .flatMap(p => [
        {x: p.dx, z: p.dz},
        {x: -p.dz, z: p.dx},
      ])
      .every(axis => {
        const pa = a.map(p => p.x * axis.x + p.z * axis.z);
        const pb = b.map(p => p.x * axis.x + p.z * axis.z);

        return (
          Math.max(...pa) > Math.min(...pb) + 0.01 &&
          Math.max(...pb) > Math.min(...pa) + 0.01
        );
      });
  };

  for (const f of profile.facilities.filter(f => f.kind === 'street')) {
    for (const id of f.slots) {
      const next = profile.slots[f.slots.find(n => n !== id)!]!;
      const neighbour = {
        ...next.position,
        dx: Math.sin(next.yaw),
        dz: Math.cos(next.yaw),
      };

      for (const entering of [true, false]) {
        const route = parkingRoute(f, profile.slots[id]!, entering).route;

        for (let at = 0; at <= route.length; at += 0.1) {
          expect(intersects(sampleLaneRoute(route, at), neighbour)).toBe(false);
        }
      }
    }
  }
});
