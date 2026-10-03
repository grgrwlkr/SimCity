import * as THREE from 'three';
import {
  MovingAssets,
  personParts,
  vehicleParts,
  type AssetPart,
} from '../assetParts';
import {personKit, vehicleKit} from '../assetKits';
import {cityVehicleKits, AMBIENT_VEHICLES} from '../harborLayout';
import {lifeCarKit} from './population';
import type {LifeFrame} from './types';

export function freightParts(seed: string): AssetPart[][] {
  return cityVehicleKits(seed)
    .slice(AMBIENT_VEHICLES)
    .map(kit => {
      const parts = vehicleParts(kit);
      const flatbed = parts.filter(
        p => p.slot !== 'cargo' && p.slot !== 'cargo-trim',
      );

      for (const side of [-1, 1]) {
        for (const z of [0.8, -3.5]) {
          for (const slot of ['wheel', 'hub']) {
            flatbed.push({
              ...parts.find(p => p.slot === slot && Math.sign(p.x) === side)!,
              z,
            });
          }
        }
      }

      flatbed.push({
        ...parts.find(p => p.slot === 'chassis')!,
        slot: 'trailer-bed',
        color: 'steel',
        y: 0.99,
        z: -1.2,
        w: 1.83,
        h: 0.1,
        d: 5.4,
      });

      return flatbed;
    });
}

export class LifeView {
  readonly group = new THREE.Group();
  readonly people = new THREE.Group();
  readonly cars = new THREE.Group();
  private personAssets: MovingAssets | undefined;
  private carAssets: MovingAssets | undefined;
  private readonly freight: MovingAssets;
  private personIds = '';
  private carIds = '';
  private readonly object = new THREE.Object3D();
  private readonly ring = new THREE.Mesh(
    new THREE.RingGeometry(1.1, 1.5, 32),
    new THREE.MeshBasicMaterial({
      color: 0xe8b367,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );
  selected: number | null = null;

  constructor(private seed: string) {
    this.people.userData['kind'] = 'person';
    this.cars.userData['kind'] = 'car';
    this.group.add(this.people, this.cars);
    const utility = new THREE.Group();

    this.group.add(utility);
    this.freight = new MovingAssets(utility, [
      ...freightParts(seed),
      vehicleParts({
        ...vehicleKit(seed, 9876),
        body: 'van',
        length: 4.2,
        width: 1.9,
        color: 'yellow',
        roof: 'bare',
      }),
    ]);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 10;
    this.group.add(this.ring);
  }

  private clear(group: THREE.Group): void {
    group.traverse(o => {
      if (o instanceof THREE.InstancedMesh) {
        o.dispose();
      }
    });
    group.clear();
  }

  private pose(
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale = 1,
  ): THREE.Matrix4 {
    this.object.position.set(x, y, z);
    this.object.rotation.set(0, yaw, 0);
    this.object.scale.setScalar(scale);
    this.object.updateMatrix();

    return this.object.matrix.clone();
  }

  update(frame: LifeFrame): void {
    const personIds = frame.people.map(p => p.id).join(',');

    if (this.personIds !== personIds) {
      this.clear(this.people);
      this.personIds = personIds;
      this.personAssets = new MovingAssets(
        this.people,
        frame.people.map(p =>
          personParts(personKit(this.seed, `resident/${p.id}`)),
        ),
      );
    }

    const carIds = frame.cars.map(c => `${c.id}/${c.tier}`).join(',');

    if (this.carIds !== carIds) {
      this.clear(this.cars);
      this.carIds = carIds;
      this.carAssets = new MovingAssets(
        this.cars,
        frame.cars.map(c => vehicleParts(lifeCarKit(this.seed, c.id, c.tier))),
      );
    }

    this.personAssets?.update(
      frame.people.map(p =>
        this.pose(p.x, p.y, p.z, p.yaw, p.visible ? (p.child ? 0.7 : 1) : 0),
      ),
      frame.seconds,
    );
    this.carAssets?.update(
      frame.cars.map(c => this.pose(c.x, c.y, c.z, c.yaw, c.visible ? 1 : 0)),
      frame.seconds,
    );
    this.freight.update(
      [
        ...frame.freight.map(p =>
          this.pose(p.x, p.y ?? 0.91, p.z, Math.atan2(p.dx, p.dz)),
        ),
        this.pose(
          frame.bus.x,
          frame.bus.y ?? 0.91,
          frame.bus.z,
          Math.atan2(frame.bus.dx, frame.bus.dz),
          frame.bus.visible ? 1 : 0,
        ),
      ],
      frame.seconds,
    );
    const selected = frame.people.find(p => p.id === this.selected);

    this.ring.visible = !!selected;

    if (selected) {
      this.ring.position.set(selected.x, 1.25, selected.z);
    }

    this.group.updateMatrixWorld(true);
  }

  pick(ray: THREE.Raycaster, frame: LifeFrame): number | null {
    for (const hit of ray.intersectObjects([this.people, this.cars], true)) {
      const index = hit.instanceId;

      if (index === undefined) {
        continue;
      }

      const actor = (hit.object.userData['actorIds'] as number[])[index]!;

      if (hit.object.parent === this.people) {
        return frame.people[actor]!.id;
      }

      const car = frame.cars[actor]!;

      if (car.driver !== null) {
        return car.driver;
      }

      // Catalog family ownership is resolved by the worker; the frame keeps a driver only while travelling.
      const owner = frame.carOwners[car.id];

      if (owner !== undefined) {
        return owner;
      }
    }

    return null;
  }

  dispose(): void {
    this.group.traverse(o => {
      if (o instanceof THREE.InstancedMesh) {
        o.dispose();
      }
    });
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
