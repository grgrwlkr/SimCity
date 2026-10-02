import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';
import { createCity } from '../src/city/model';
import { AMBIENT_VEHICLES, WAREHOUSES, cityVehicleKits } from '../src/city/harborLayout';
import { createTrafficRoutes, sampleLaneRoute } from '../src/city/trafficRoutes';

const roadCenters = [-119, -85, -51, -17, 17, 51, 85, 119];
const nearestRoad = (coordinate: number) => roadCenters.reduce((best, road) => Math.abs(road - coordinate) < Math.abs(best - coordinate) ? road : best);
const onRoad = (x: number, z: number) => (Math.abs(x) <= 123.0001 && Math.abs(z) <= 123.0001
  && (Math.abs(x - nearestRoad(x)) <= 4.0001 || Math.abs(z - nearestRoad(z)) <= 4.0001))
  || (x >= 47 && x <= 123 && z >= 123 && z <= 147)
  || WAREHOUSES.some((yard) => x >= yard.x - 13 && x <= yard.x + 13 && z >= yard.z && z <= yard.z + 13);

describe('rendered city traffic', () => {
  const city = createCity(generateCity('689856'));
  const bodies = city.group.getObjectByName('city-traffic-body') as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  const times = [0, 7, 17, 29, 41, 53, 73];
  const sizes = cityVehicleKits('689856');
  afterAll(() => city.dispose());

  function poses() {
    return Array.from({ length: bodies.count }, (_, id) => {
      bodies.getMatrixAt(id, matrix);
      const m = matrix.elements;
      const length = Math.hypot(m[8]!, m[10]!);
      return { id, x: m[12]!, z: m[14]!, dx: m[8]! / length, dz: m[10]! / length, length, width: Math.hypot(m[0]!, m[2]!) };
    });
  }

  it('centers every vehicle on the right-hand lane in all four travel directions', () => {
    const errors: object[] = [], directions = new Set<string>();
    for (const seconds of times) {
      city.update(seconds);
      for (const p of poses()) {
        if (Math.abs(p.dz) < 0.0001) {
          if (p.id >= AMBIENT_VEHICLES && [74, 108, 138].some((z) => Math.abs(p.z - z) < 0.0001)) {
            expect(Math.sign(p.dx)).toBe(Math.abs(p.z - 138) < 0.001 ? -1 : 1);
            continue;
          }
          const wanted = nearestRoad(p.z) + Math.sign(p.dx) * 2;
          directions.add(p.dx > 0 ? 'east' : 'west');
          if (Math.abs(p.z - wanted) > 0.0001) errors.push({ seconds, id: p.id, z: p.z, wanted });
        } else if (Math.abs(p.dx) < 0.0001) {
          const wanted = nearestRoad(p.x) - Math.sign(p.dz) * 2;
          directions.add(p.dz > 0 ? 'south' : 'north');
          if (Math.abs(p.x - wanted) > 0.0001) errors.push({ seconds, id: p.id, x: p.x, wanted });
        }
      }
    }
    expect(directions.size).toBe(4);
    expect(errors.slice(0, 5)).toEqual([]);
  }, 20_000); // Advances 73 simulation seconds; wall-clock speed is not the assertion.

  it('keeps the whole vehicle body on asphalt, including truck overhang on corners', () => {
    const errors: object[] = [];
    let turns = 0;
    for (let seconds = 0; seconds < 100; seconds += 0.7) {
      city.update(seconds);
      for (const p of poses()) {
        if (Math.abs(p.dx) > 0.01 && Math.abs(p.dz) > 0.01) turns++;
        for (let step = 0; step <= 10; step++) for (const side of [-0.5, 0.5]) {
          const edge = step / 10 - 0.5;
          for (const [along, across] of [[edge, side], [side, edge]]) {
            // Use the largest permitted assembly, including wheels, bumpers and lights.
            const length = Math.max(5.8, sizes[p.id]!.length);
            const x = p.x + p.dx * along! * length - p.dz * across! * 1.9;
            const z = p.z + p.dz * along! * length + p.dx * across! * 1.9;
            if (!onRoad(x, z)) errors.push({ seconds, id: p.id, x, z });
          }
        }
      }
    }
    expect(turns).toBeGreaterThan(100);
    expect(errors.slice(0, 5)).toEqual([]);
  }, 20_000); // Sweeps every vehicle's perimeter over 100 simulation seconds.

  it('samples lane distances at a steady free-flow speed through corners and seams', () => {
    const errors: object[] = [];
    for (const seconds of times) {
      for (const [id, route] of createTrafficRoutes().entries()) {
        const p = sampleLaneRoute(route, seconds * 5.5), next = sampleLaneRoute(route, (seconds + 0.01) * 5.5);
        const dx = next.x - p.x, dz = next.z - p.z;
        const speed = Math.hypot(dx, dz) / 0.01;
        if (Math.abs(speed - 5.5) > 0.01 || dx * p.dx + dz * p.dz <= 0) errors.push({ seconds, id, speed });
      }
    }
    expect(errors.slice(0, 5)).toEqual([]);
  });

  it('keeps complete vehicle assemblies separated at spawn, while following and at junctions', () => {
    const specs = sizes;
    const collisions: object[] = [];
    // Deliberately off the 50 ms simulation step to also check interpolated render poses.
    for (let seconds = 0; seconds <= 120; seconds += 0.23) {
      city.update(seconds);
      const cars = poses().map((p) => {
        const kit = specs[p.id]!;
        // Include a 1 m bumper gap, not just the smaller chassis mesh.
        const corners = [-1, 1].flatMap((along) => [-1, 1].map((across) => ({
          x: p.x + p.dx * along * (kit.length + 1) / 2 - p.dz * across * kit.width / 2,
          z: p.z + p.dz * along * (kit.length + 1) / 2 + p.dx * across * kit.width / 2,
        })));
        return { ...p, corners };
      });
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i]!, b = cars[j]!;
        if (Math.abs(a.x - b.x) > 8 || Math.abs(a.z - b.z) > 8) continue;
        const separated = [[a.dx, a.dz], [-a.dz, a.dx], [b.dx, b.dz], [-b.dz, b.dx]].some(([dx, dz]) => {
          const ap = a.corners.map((p) => p.x * dx! + p.z * dz!);
          const bp = b.corners.map((p) => p.x * dx! + p.z * dz!);
          return Math.max(...ap) <= Math.min(...bp) + 0.0001 || Math.max(...bp) <= Math.min(...ap) + 0.0001;
        });
        if (!separated) collisions.push({ seconds, a: a.id, b: b.id, ax: a.x, az: a.z, bx: b.x, bz: b.z });
      }
      if (collisions.length >= 5) break;
    }
    expect(collisions.slice(0, 5)).toEqual([]);
  }, 20_000);
});
