import * as THREE from 'three';
import {Batch, material} from '../primitives';
import {CURB_PARKING} from './streetParking';
import {DIRECTIONS, rightOf} from './network';
import type {LifeFrame, LifeProfile, ParkingFacility} from './types';

export function addGarage(batch: Pick<Batch, 'add'>, f: ParkingFacility): void {
  const {x, z} = f.entrance;

  batch.add('box', 'dark', x, 2.17, z + 0.29, 2.55, 2.6, 0.15);

  for (const dx of [-1.4, 1.4]) {
    batch.add('box', 'cream', x + dx, 2.18, z + 0.36, 0.22, 2.76, 0.32);
  }

  batch.add('box', 'cream', x, 3.63, z + 0.36, 3, 0.25, 0.32);
  batch.add('box', 'glassDark', x, 3.99, z + 0.4, 1.1, 0.45, 0.14);
  batch.add('box', 'cream', x - 0.2, 3.99, z + 0.49, 0.045, 0.28, 0.03);

  for (const y of [4.11, 4]) {
    batch.add('box', 'cream', x - 0.1, y, z + 0.49, 0.2, 0.045, 0.03);
  }

  batch.add('box', 'cream', x, 4.05, z + 0.49, 0.045, 0.15, 0.03);
  batch.add('box', 'gold', x + 0.24, 3.96, z + 0.49, 0.055, 0.23, 0.03);
  batch.add('box', 'gold', x + 0.24, 3.9, z + 0.49, 0.2, 0.055, 0.03);
}

export class ParkingView {
  readonly group = new THREE.Group();
  readonly targets: THREE.Mesh[] = [];
  private readonly paint: THREE.InstancedMesh;
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly paintMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.64,
    depthWrite: false,
  });
  private readonly transform = new THREE.Object3D();

  constructor(readonly profile: LifeProfile) {
    const batch = new Batch();
    // A short connection to the world outside the diorama for incoming households.
    const arrivalX = profile.arrival.point.x;

    batch.add('box', 'asphalt', arrivalX + 12, 0.79, -85, 16, 0.12, 8);

    for (const x of [arrivalX + 17, arrivalX + 12, arrivalX + 7]) {
      batch.add('box', 'cream', x, 0.866, -85, 2, 0.02, 0.12);
    }

    addCurbParking(batch, profile);
    batch.finish(this.group);
    this.paint = new THREE.InstancedMesh(
      this.geometry,
      this.paintMaterial,
      profile.slots.length,
    );
    this.paint.frustumCulled = false;
    this.paint.visible = false;
    this.paint.renderOrder = 5;

    for (const slot of profile.slots) {
      const f = profile.facilities[slot.facility]!;

      this.transform.position.set(slot.position.x, 1.17, slot.position.z);
      this.transform.rotation.set(0, slot.yaw, 0);
      this.transform.scale.set(
        f.kind === 'street' ? CURB_PARKING.width - 0.15 : 2.2,
        0.025,
        f.kind === 'street' ? CURB_PARKING.placeLength - 0.2 : 4.6,
      );

      if (f.kind === 'underground') {
        this.transform.position.set(f.entrance.x, 1.18, f.entrance.z + 1.8);
        this.transform.scale.set(2.4, 0.03, 2);
      }

      this.transform.updateMatrix();
      this.paint.setMatrixAt(slot.id, this.transform.matrix);
    }

    this.group.add(this.paint);

    for (const f of profile.facilities) {
      const target = new THREE.Mesh(this.geometry, material('cream'));

      target.position.set(
        f.entrance.x,
        1.2,
        f.entrance.z + (f.kind === 'underground' ? 1.8 : 0),
      );
      target.scale.set(
        f.kind === 'street' ? CURB_PARKING.width : 2.8,
        0.5,
        f.kind === 'street' ? CURB_PARKING.pavedLength : 4,
      );
      target.rotation.y = f.yaw;
      target.userData['parking'] = f.id;
      target.updateMatrixWorld();
      this.targets.push(target);
    }
  }

  toggle(show: boolean): void {
    this.paint.visible = show;
  }

  update(frame: LifeFrame): void {
    const counts = new Map<number, number>();

    for (const slot of frame.parking) {
      if (slot.occupant !== null) {
        const f = this.profile.slots[slot.id]!.facility;

        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
    }

    for (const slot of frame.parking) {
      const f = this.profile.facilities[this.profile.slots[slot.id]!.facility]!;
      const occupied =
        f.kind === 'underground'
          ? (counts.get(f.id) ?? 0) >= f.slots.length
          : slot.occupant !== null;

      this.paint.setColorAt(
        slot.id,
        new THREE.Color(
          occupied ? 0xbc7155 : slot.reserved !== null ? 0xe3b15e : 0x67a886,
        ),
      );
    }

    if (this.paint.instanceColor) {
      this.paint.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.traverse(o => {
      if (o instanceof THREE.InstancedMesh) {
        o.dispose();
      }
    });
    this.geometry.dispose();
    this.paintMaterial.dispose();
  }
}

/** Compact on-street spaces share the road surface; pavement follows the same
 * path as the walkers, without separate islands or a sign at every pair of cars. */
export function addCurbParking(
  batch: Pick<Batch, 'add'>,
  profile: LifeProfile,
): void {
  for (const bay of profile.bays) {
    const f = profile.facilities[bay.facility]!;
    const d = DIRECTIONS[f.road.direction]!;
    const r = rightOf(f.road.direction);
    const {x, z} = f.entrance;

    batch.add(
      'box',
      'asphalt',
      x,
      0.79,
      z,
      CURB_PARKING.width,
      0.12,
      CURB_PARKING.pavedLength,
      f.yaw,
    );

    if (
      bay.blockId === null ||
      profile.layout.blocks.find(b => b.id === bay.blockId)?.district ===
        'railway'
    ) {
      const length = Math.hypot(
        bay.sidewalk.at(-1)!.x - bay.sidewalk[0]!.x,
        bay.sidewalk.at(-1)!.z - bay.sidewalk[0]!.z,
      );
      const shift = CURB_PARKING.sidewalkOffset - CURB_PARKING.centerOffset;

      batch.add(
        'box',
        'paving',
        x + r.x * shift,
        0.91,
        z + r.z * shift,
        CURB_PARKING.sidewalkWidth,
        0.3,
        length,
        f.yaw,
      );
      const endLength = (length - CURB_PARKING.pavedLength) / 2;

      for (const side of [-1, 1]) {
        batch.add(
          'box',
          'paving',
          x + d.x * side * (length / 2 - endLength / 2),
          0.91,
          z + d.z * side * (length / 2 - endLength / 2),
          CURB_PARKING.width,
          0.3,
          endLength,
          f.yaw,
        );
      }
    }

    for (const along of [
      -CURB_PARKING.placeLength,
      0,
      CURB_PARKING.placeLength,
    ]) {
      batch.add(
        'box',
        'cream',
        x + d.x * along,
        0.865,
        z + d.z * along,
        CURB_PARKING.width - 0.12,
        0.02,
        0.07,
        f.yaw,
      );
    }

    batch.add(
      'box',
      'cream',
      x + r.x * (CURB_PARKING.width / 2 - 0.08),
      0.865,
      z + r.z * (CURB_PARKING.width / 2 - 0.08),
      0.07,
      0.02,
      CURB_PARKING.placeLength * 2,
      f.yaw,
    );
  }

  const outside = profile.bays.filter(b => b.blockId === null);

  for (const [i, a] of outside.entries()) {
    for (const b of outside.slice(i + 1)) {
      const f = profile.facilities[a.facility]!;
      const other = profile.facilities[b.facility]!;

      if (
        f.road.direction !== other.road.direction ||
        Math.abs(Math.hypot(a.x - b.x, a.z - b.z) - 34) > 0.01
      ) {
        continue;
      }

      const r = rightOf(f.road.direction);
      const x = (a.x + b.x) / 2;
      const z = (a.z + b.z) / 2;

      if (f.road.direction === 1 && Math.abs(z - profile.arrival.point.z) < 4) {
        continue;
      }

      const width = CURB_PARKING.width + CURB_PARKING.sidewalkWidth;
      const offset = 4 + width / 2;

      batch.add(
        'box',
        'paving',
        x + r.x * offset,
        0.91,
        z + r.z * offset,
        width,
        0.3,
        8.9,
        f.yaw,
      );
    }
  }
}
