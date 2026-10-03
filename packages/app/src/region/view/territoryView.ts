import * as THREE from 'three';
import {cityRadius} from '../model/territory';
import type {Settlement} from '../model/types';

export function createTerritoryView(
  settlement: Settlement,
  active: boolean,
): THREE.Group {
  const group = new THREE.Group();
  const radius = cityRadius(settlement);
  const segments = 128;
  const color = active ? 0x9a793c : 0x648675;
  const points = Array.from({length: segments}, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;

    return new THREE.Vector3(
      Math.cos(angle) * radius,
      1.3,
      Math.sin(angle) * radius,
    );
  });
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: active ? 0.95 : 0.6,
      depthWrite: false,
      depthTest: false,
    }),
  );
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, segments),
    new THREE.MeshBasicMaterial({
      color: 0xe7c985,
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
    }),
  );

  group.position.set(settlement.center.x, 0, settlement.center.z);
  outline.name = 'territory-outline';
  outline.renderOrder = 4;
  fill.name = 'territory-fill';
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 1.15;
  fill.renderOrder = 3;
  fill.visible = active;
  group.add(fill, outline);

  return group;
}
