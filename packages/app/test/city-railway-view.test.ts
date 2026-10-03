import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {
  createRailwayView,
  railwayInfrastructure,
} from '../src/city/railwayView';
import {geometries, type Batch} from '../src/city/primitives';
import {Railway, type RailwaySnapshot} from '../src/city/railway';

describe('railway infrastructure geometry', () => {
  it('marks a stop before each barrier on the incoming right-hand lane', () => {
    const roads = [-51, -17];
    const parts: Array<Parameters<Batch['add']>> = [];

    railwayInfrastructure({add: (...part) => parts.push(part)}, roads);
    const lines = parts.filter(
      ([, color, , y, , w]) => color === 'cream' && y === 0.861 && w === 3.2,
    );

    expect(lines).toHaveLength(roads.length * 2);

    for (const road of roads) {
      const southbound = lines.find(
        ([, , x, , z]) => x < road && x > road - 4 && z < -136,
      );
      const northbound = lines.find(
        ([, , x, , z]) => x > road && x < road + 4 && z > -136,
      );

      expect(southbound).toBeDefined();
      expect(northbound).toBeDefined();
      expect(southbound![4]).toBeLessThan(-144.6);
      expect(northbound![4]).toBeGreaterThan(-127.4);
      expect(southbound![2] + southbound![5] / 2).toBeLessThan(road);
      expect(northbound![2] - northbound![5] / 2).toBeGreaterThan(road);
    }
  });

  it('keeps platforms, sleepers and station furniture clear of road crossings', () => {
    const roads = [-187, -153, -119, -85, -51, -17, 17, 51, 85, 119];
    const parts: Array<Parameters<Batch['add']>> = [];

    railwayInfrastructure({add: (...part) => parts.push(part)}, roads);
    const transform = new THREE.Object3D();

    for (const [
      shape,
      color,
      x,
      y,
      z,
      w,
      h,
      d,
      ry = 0,
      rx = 0,
      rz = 0,
    ] of parts) {
      expect([x, y, z, w, h, d].every(Number.isFinite)).toBe(true);
      expect([w, h, d].every(n => n > 0)).toBe(true);
      transform.position.set(x, y, z);
      transform.scale.set(w, h, d);
      transform.rotation.set(rx, ry, rz);
      transform.updateMatrix();
      const geometry = geometries[shape];

      geometry.computeBoundingBox();
      const bounds = geometry
        .boundingBox!.clone()
        .applyMatrix4(transform.matrix);

      if (
        bounds.min.z > -148.9 &&
        bounds.max.z < -123.8 &&
        (bounds.max.y > 0.95 || color === 'trunk') &&
        color !== 'metal'
      ) {
        for (const road of roads) {
          expect(
            bounds.max.x <= road - 4 || bounds.min.x >= road + 4,
            `${shape}:${color} at ${x},${z}`,
          ).toBe(true);
        }
      }
    }
  });

  it('renders both directions with the engine leading and opens only platform-side doors', () => {
    const view = createRailwayView();
    const snapshot: RailwaySnapshot = new Railway().snapshot();

    snapshot.train.phase = 'boarding';
    snapshot.train.x = -34;
    snapshot.train.z = -138.4;
    snapshot.train.doorsOpen = true;
    const train = view.group.getObjectByName('railway-train')!;
    const engine = view.group.getObjectByName('railway-engine')!;
    const coach = view.group.getObjectByName('railway-coach-1')!;

    for (const direction of [1, -1] as const) {
      snapshot.train.direction = direction;
      view.update(snapshot, 20);
      view.group.updateMatrixWorld(true);
      expect(train.visible).toBe(true);
      expect(engine.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(
        -34 + direction * 8.4,
      );
      expect(coach.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(
        -34 + direction * 2.8,
      );
    }

    const door = coach.children.find(
      child => child.userData['restX'] !== undefined && child.position.z < 0,
    )!;
    const openX = door.position.x;

    snapshot.train.doorsOpen = false;
    view.update(snapshot, 21);
    expect(Math.abs(door.position.x - openX)).toBeCloseTo(0.5);
    view.dispose();
  });

  it('moves barrier arms from vertical to across each approach as gates close', () => {
    const view = createRailwayView();
    const snapshot = new Railway().snapshot();

    view.update(snapshot, 0);
    const arm = view.group.getObjectByName('railway-gate-0-1')!;

    expect(arm.rotation.z).toBeCloseTo(-Math.PI / 2);
    snapshot.crossings[0]!.openness = 0;
    snapshot.crossings[0]!.state = 'closed';
    view.update(snapshot, 1);
    expect(arm.rotation.z).toBeCloseTo(0);
    view.dispose();
  });

  it('restores open doors immediately when loading an earlier station stop on pause', () => {
    const view = createRailwayView();
    const boarding = new Railway().snapshot();

    boarding.train.phase = 'boarding';
    boarding.train.x = -34;
    boarding.train.doorsOpen = true;
    view.update(boarding, 40);
    const coach = view.group.getObjectByName('railway-coach-1')!;
    const door = coach.children.find(
      child => child.userData['restX'] !== undefined && child.position.z < 0,
    )!;
    const open = door.position.x;
    const leaving = structuredClone(boarding);

    leaving.train.phase = 'leaving';
    leaving.train.doorsOpen = false;
    view.update(leaving, 60);
    expect(door.position.x).not.toBe(open);
    view.update(boarding, 40);
    expect(door.position.x).toBe(open);
    view.dispose();
  });

  it('constructs a batched station and hidden train without a DOM and releases owned resources', () => {
    const view = createRailwayView();

    expect(view.group.getObjectByName('railway-station')).toBeDefined();
    expect(view.group.getObjectByName('railway-train')!.visible).toBe(false);
    expect(view.targets).toHaveLength(1);
    let instances = 0;

    view.group.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        instances += object.count;
      }
    });
    expect(instances).toBeGreaterThan(400);
    view.dispose();
  });
});
