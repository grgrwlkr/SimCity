import * as THREE from 'three';
import { Batch, geometries, material } from './primitives';

export interface ConstructionPlot {
  x: number; z: number; width: number; depth: number;
  minX: number; maxX: number; minZ: number; maxZ: number;
}

export function craneCycle(seconds: number): { turn: number; lift: number; loaded: boolean } {
  const t = ((seconds % 7) + 7) % 7 / 7;
  const smooth = (a: number, b: number) => { const p = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1); return p * p * (3 - 2 * p); };
  return {
    turn: t < 0.7 ? smooth(0.17, 0.4) : 1 - smooth(0.76, 0.95),
    lift: t < 0.4 ? smooth(0.02, 0.17) : t < 0.64 ? 1 - smooth(0.4, 0.57) : t < 0.76 ? smooth(0.64, 0.76) : 1 - smooth(0.95, 1),
    loaded: t < 0.64,
  };
}

/** A temporary, parcel-bounded site. All parts reuse the city's original palette. */
export function createConstructionSite(plot: ConstructionPlot, targetHeight: number, clearance: (x: number, z: number, radius: number) => number) {
  const group = new THREE.Group(); group.name = 'construction-site';
  const ground = 1.08;
  const batch = new Batch();
  const centerX = (plot.minX + plot.maxX) / 2, centerZ = (plot.minZ + plot.maxZ) / 2;
  batch.add('box', 'path', centerX, ground, centerZ, plot.maxX - plot.minX, 0.025, plot.maxZ - plot.minZ);
  const fence = (ax: number, az: number, bx: number, bz: number) => {
    const length = Math.hypot(bx - ax, bz - az), sections = Math.ceil(length / 1.7);
    const heading = Math.atan2(bx - ax, bz - az);
    for (let i = 0; i <= sections; i++) {
      const x = ax + (bx - ax) * i / sections, z = az + (bz - az) * i / sections;
      batch.add('box', 'metal', x, ground + 0.66, z, 0.1, 1.32, 0.1);
      if (i === sections) continue;
      const mx = ax + (bx - ax) * (i + 0.5) / sections, mz = az + (bz - az) * (i + 0.5) / sections;
      batch.add('box', 'teal', mx, ground + 0.61, mz, 0.07, 1.13, length / sections, heading);
      batch.add('box', 'cream', mx, ground + 1.2, mz, 0.09, 0.08, length / sections, heading);
    }
  };
  fence(plot.minX, plot.minZ, plot.maxX, plot.minZ);
  fence(plot.minX, plot.minZ, plot.minX, plot.maxZ);
  fence(plot.maxX, plot.minZ, plot.maxX, plot.maxZ);
  const gateWidth = Math.min(2.5, (plot.maxX - plot.minX) * 0.4);
  fence(plot.minX, plot.maxZ, centerX - gateWidth / 2, plot.maxZ);
  fence(centerX + gateWidth / 2, plot.maxZ, plot.maxX, plot.maxZ);
  // Open leaves lie inside the plot, keeping the street and delivery entrance clear.
  const gateLeaf = Math.min(gateWidth / 2, (plot.maxZ - plot.z - plot.depth / 2) * 0.85);
  for (const side of [-1, 1]) {
    batch.add('box', 'teal', centerX + side * gateWidth / 2, ground + 0.6, plot.maxZ - gateLeaf / 2, 0.07, 1.1, gateLeaf);
    batch.add('box', 'gold', centerX + side * gateWidth / 2, ground + 1.2, plot.maxZ - gateLeaf / 2, 0.1, 0.08, gateLeaf);
  }

  const rightGap = plot.maxX - (plot.x + plot.width / 2), leftGap = plot.x - plot.width / 2 - plot.minX;
  const side = rightGap >= leftGap ? 1 : -1, gap = Math.max(rightGap, leftGap);
  const mastWidth = Math.min(0.65, Math.max(0.16, gap * 0.66));
  const mastX = side > 0 ? plot.maxX - gap / 2 : plot.minX + gap / 2;
  const mastZ = plot.z;
  const pickupZ = THREE.MathUtils.clamp(plot.z - plot.depth * 0.3, plot.minZ + 0.7, plot.maxZ - 0.7);
  const pickupRadius = Math.abs(pickupZ - mastZ), dropRadius = Math.abs(plot.x - mastX);
  const reach = Math.max(pickupRadius, dropRadius) + 0.65;
  const minimumHead = Math.max(9, clearance(mastX, mastZ, reach) + 2);
  const viewHeight = Math.max(minimumHead, targetHeight + 6) + 1.8;
  batch.add('box', 'paving', mastX, ground + 0.12, mastZ, mastWidth * 1.25, 0.24, 1.2);
  for (let i = 0; i < 3; i++) {
    batch.add('box', 'trunk', mastX, ground + 0.08 + i * 0.22, pickupZ, mastWidth, 0.1, 1);
    batch.add('box', 'cream', mastX, ground + 0.18 + i * 0.22, pickupZ, mastWidth * 0.8, 0.15, 0.85);
  }
  // Timber and steel bundles occupy the rear working strip, inside the fence.
  const rearGap = plot.z - plot.depth / 2 - plot.minZ;
  if (rearGap > 0.25) for (let i = 0; i < 4; i++) {
    batch.add('box', i < 2 ? 'trunk' : 'metal', plot.x - 1 + i * 0.55, ground + 0.22, plot.minZ + rearGap / 2, 0.35, 0.35, rearGap * 0.65);
  }
  batch.finish(group);

  const crane = new THREE.Group(); crane.name = 'construction-crane'; group.add(crane);
  const segments = Math.ceil(viewHeight / 2.5), mast = new THREE.InstancedMesh(geometries.box, material('gold'), segments * 10);
  mast.castShadow = true; mast.receiveShadow = true; mast.frustumCulled = false; crane.add(mast);
  const head = new THREE.Group(); head.name = 'crane-jib'; crane.add(head);
  const boom = new Batch(), counter = Math.min(2.2, reach * 0.4), beamLength = reach + counter;
  for (const x of [-0.2, 0.2]) for (const y of [0, 0.55]) boom.add('box', 'gold', x, y, (reach - counter) / 2, 0.1, 0.1, beamLength);
  for (let z = -counter; z < reach; z += 0.8) {
    boom.add('box', 'gold', 0, 0, z, 0.5, 0.09, 0.1);
    for (const x of [-0.2, 0.2]) boom.add('box', 'gold', x, 0.27, z + 0.32, 0.07, 0.8, 0.07, 0, -Math.PI / 4);
  }
  boom.add('box', 'metal', 0, -0.2, -counter + 0.35, 0.85, 0.65, 0.7);
  boom.add('box', 'cream', 0.55, -0.18, 0.7, 0.8, 0.8, 0.9);
  boom.add('box', 'window', 0.55, -0.1, 1.16, 0.65, 0.48, 0.04);
  boom.add('box', 'window', 0.97, -0.1, 0.7, 0.04, 0.48, 0.65);
  boom.finish(head);
  const mesh = (color: string, w: number, h: number, d: number) => {
    const result = new THREE.Mesh(geometries.box, material(color)); result.scale.set(w, h, d); result.castShadow = true; return result;
  };
  const trolley = mesh('metal', 0.65, 0.23, 0.55); trolley.name = 'crane-trolley'; head.add(trolley);
  const cable = mesh('metal', 0.035, 1, 0.035); cable.name = 'crane-cable'; head.add(cable);
  const hook = mesh('gold', 0.2, 0.3, 0.2); hook.name = 'crane-hook'; head.add(hook);
  const cargo = new THREE.Group(); cargo.name = 'crane-load'; head.add(cargo);
  const slab = mesh('cream', mastWidth * 0.8, 0.32, 1.1); slab.position.y = -0.42; cargo.add(slab);
  for (const z of [-0.4, 0.4]) {
    const sling = mesh('metal', 0.05, 0.55, 0.05); sling.position.set(0, -0.16, z); cargo.add(sling);
  }
  const transform = new THREE.Object3D();
  function update(height: number, seconds: number): void {
    const headY = Math.max(minimumHead, height + 6), cycle = craneCycle(seconds);
    let index = 0;
    const beam = (x: number, y: number, z: number, w: number, h: number, d: number, rx = 0, rz = 0) => {
      transform.position.set(x, y, z); transform.scale.set(w, h, d); transform.rotation.set(rx, 0, rz); transform.updateMatrix(); mast.setMatrixAt(index++, transform.matrix);
    };
    for (let i = 0; i < segments; i++) {
      const bottom = ground + i * 2.5, h = THREE.MathUtils.clamp(headY - bottom, 0, 2.5), y = bottom + h / 2;
      const thin = h > 0 ? 0.09 : 0;
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) beam(mastX + dx * mastWidth / 2, y, mastZ + dz * mastWidth / 2, thin, h, thin);
      for (const dz of [-1, 1]) beam(mastX, bottom + h, mastZ + dz * mastWidth / 2, h > 0 ? mastWidth : 0, thin, thin);
      for (const dx of [-1, 1]) beam(mastX + dx * mastWidth / 2, bottom + h, mastZ, thin, thin, h > 0 ? mastWidth : 0);
      for (const dz of [-1, 1]) beam(mastX, y, mastZ + dz * mastWidth / 2, thin * 0.7, h > 0 ? Math.hypot(h, mastWidth) : 0, thin * 0.7, 0, (i % 2 ? 1 : -1) * Math.atan2(mastWidth, h || 1));
    }
    mast.instanceMatrix.needsUpdate = true;
    const pickupAngle = -Math.PI, dropAngle = side > 0 ? -Math.PI / 2 : -Math.PI * 1.5;
    head.position.set(mastX, headY, mastZ); head.rotation.y = THREE.MathUtils.lerp(pickupAngle, dropAngle, cycle.turn);
    const radius = THREE.MathUtils.lerp(pickupRadius, dropRadius, cycle.turn);
    const lowHook = THREE.MathUtils.lerp(ground + 1.3, height + 0.8, cycle.turn);
    const hookY = THREE.MathUtils.lerp(lowHook, headY - 1.2, cycle.lift);
    trolley.position.set(0, -0.12, radius);
    cable.position.set(0, (hookY - headY) / 2, radius); cable.scale.y = headY - hookY;
    hook.position.set(0, hookY - headY, radius);
    cargo.position.copy(hook.position); cargo.visible = cycle.loaded;
  }
  update(0, 0);
  return { group, viewHeight, update };
}
