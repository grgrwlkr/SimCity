import * as THREE from 'three';
import {Batch, material} from '../../../../packages/app/src/city/primitives';
import type {Parcel} from '../../../../packages/app/src/region/model/types';

export function createParcelView(parcel: Parcel): THREE.Group {
  const group = new THREE.Group();
  const batch = new Batch();
  const color = {residential: 'green', commercial: 'blue', industrial: 'gold'}[
    parcel.zone
  ];
  const mat = material(color).clone();

  mat.transparent = true;
  mat.opacity = 0.32;
  mat.depthWrite = false;
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(parcel.width, parcel.depth),
    mat,
  );

  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 1.07;
  group.add(fill);
  const border = parcel.access ? color : 'red';

  for (const sign of [-1, 1]) {
    batch.add(
      'box',
      border,
      0,
      1.09,
      (sign * parcel.depth) / 2,
      parcel.width,
      0.05,
      0.24,
    );
    batch.add(
      'box',
      border,
      (sign * parcel.width) / 2,
      1.09,
      0,
      0.24,
      0.05,
      parcel.depth,
    );
  }

  if (!parcel.access) {
    const length = Math.hypot(parcel.width, parcel.depth);
    const heading = Math.atan2(parcel.width, parcel.depth);

    batch.add('box', 'red', 0, 1.09, 0, 0.22, 0.05, length, heading);
    batch.add('box', 'red', 0, 1.09, 0, 0.22, 0.05, length, -heading);
  }

  batch.finish(group);
  group.position.set(parcel.center.x, 0, parcel.center.z);
  group.rotation.y = parcel.heading;

  return group;
}
