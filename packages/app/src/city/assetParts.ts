import * as THREE from 'three';
import { geometries, material, type Batch, type Shape } from './primitives';
import type { PersonKit, PropFamily, PropKit, TreeKit, VehicleKit } from './assetKits';

export interface AssetPart {
  slot: string;
  shape: Shape;
  color: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rx: number;
  ry: number;
  rz: number;
  swing: number;
}
class Parts {
  readonly list: AssetPart[] = [];
  add(
    slot: string,
    shape: Shape,
    color: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    rx = 0,
    ry = 0,
    rz = 0,
    swing = 0,
  ): void {
    this.list.push({ slot, shape, color, x, y, z, w, h, d, rx, ry, rz, swing });
  }
}

export function vehicleParts(kit: VehicleKit): AssetPart[] {
  const p = new Parts(),
    w = kit.width,
    l = kit.length;
  const utility = kit.body === 'truck' || kit.body === 'pickup';
  const cabinZ = utility ? l * 0.28 : -0.15;
  const cabinLength = utility ? 1.55 : kit.body === 'van' || kit.body === 'estate' ? l * 0.7 : l * 0.48;
  const cabinHeight = kit.body === 'truck' && l > 6 ? 1 : kit.body === 'van' ? 0.95 : 0.58;
  p.add('chassis', 'box', kit.color, 0, 0.65, 0, w - 0.08, 0.65, l - 0.12);
  p.add('cabin', 'box', 'window', 0, 1 + cabinHeight / 2, cabinZ, w * 0.85, cabinHeight, cabinLength);
  p.add('roof', 'box', kit.color, 0, 1.04 + cabinHeight, cabinZ, w * 0.9, 0.12, cabinLength + 0.08);
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      p.add(
        'pillar',
        'box',
        kit.color,
        side * w * 0.41,
        1 + cabinHeight / 2,
        cabinZ + end * (cabinLength / 2 - 0.06),
        0.085,
        cabinHeight,
        0.11,
      );
    }
    if (kit.cabin === 'split') {
      p.add('pillar', 'box', kit.color, side * w * 0.43, 1 + cabinHeight / 2, cabinZ, 0.08, cabinHeight, 0.08);
    }
    for (const axle of [-1, 1]) {
      p.add(
        'wheel',
        'cylinder',
        'rubber',
        side * (w / 2 - 0.1),
        0.34,
        axle * l * 0.31,
        0.66,
        0.18,
        0.66,
        0,
        0,
        Math.PI / 2,
      );
      p.add(
        'hub',
        'cylinder',
        kit.wheel === 'alloy' ? 'cream' : 'steel',
        side * (w / 2 - 0.006),
        0.34,
        axle * l * 0.31,
        kit.wheel === 'alloy' ? 0.42 : 0.31,
        0.01,
        kit.wheel === 'alloy' ? 0.42 : 0.31,
        0,
        0,
        Math.PI / 2,
      );
    }
    p.add(
      'headlight',
      kit.lamp === 'round' ? 'sphere' : 'box',
      'headlight',
      side * w * 0.31,
      0.72,
      l / 2 - 0.045,
      0.3,
      0.2,
      0.075,
    );
    p.add('tail-light', 'box', 'red', side * w * 0.33, 0.7, -l / 2 + 0.045, 0.23, 0.18, 0.075);
  }
  for (const end of [-1, 1]) {
    p.add('bumper', 'box', kit.bumper, 0, 0.4, end * (l / 2 - 0.06), w * 0.92, 0.13, 0.1);
  }
  if (kit.body === 'truck') {
    p.add('cargo', 'box', 'cream', 0, 1.37, -l * 0.17, w * 0.92, 1.45, l * 0.57);
    p.add('cargo-trim', 'box', kit.color, 0, 1.24, -l * 0.17, w * 0.94, 0.2, l * 0.575);
  } else if (kit.body === 'pickup') {
    p.add('bed', 'box', 'dark', 0, 0.99, -l * 0.22, w * 0.7, 0.06, l * 0.4);
    for (const side of [-1, 1]) {
      p.add('bed-wall', 'box', kit.color, side * w * 0.45, 1.12, -l * 0.22, 0.11, 0.35, l * 0.43);
    }
  }
  if (kit.roof === 'rack') {
    for (const z of [-0.4, 0.4]) {
      p.add('roof-rack', 'box', 'metal', 0, 1.24 + cabinHeight, cabinZ + z, w * 0.83, 0.12, 0.12);
    }
    for (const side of [-1, 1]) {
      p.add('roof-rack', 'box', 'metal', side * w * 0.31, 1.3 + cabinHeight, cabinZ, 0.07, 0.08, 1.3);
    }
  } else if (kit.roof === 'box') {
    p.add('roof-box', 'box', 'roof', 0, 1.3 + cabinHeight, cabinZ, w * 0.64, 0.42, 1.3);
  }
  return p.list;
}

export function personParts(kit: PersonKit): AssetPart[] {
  const p = new Parts(),
    width = { slim: 0.36, regular: 0.43, broad: 0.5 }[kit.build];
  for (const side of [-1, 1]) {
    p.add('leg', 'box', kit.trousers, side * width * 0.28, 0.31, 0, 0.14, 0.57, 0.18, 0, 0, 0, side);
    p.add('shoe', 'box', 'dark', side * width * 0.28, 0.06, 0.055, 0.16, 0.12, 0.27);
    p.add('arm', 'box', kit.clothing, side * (width / 2 + 0.08), 0.97, 0, 0.13, 0.55, 0.19, 0, 0, 0, -side);
    p.add('hand', 'sphere', kit.skin, side * (width / 2 + 0.08), 0.68, 0, 0.15, 0.17, 0.16);
  }
  p.add(
    'torso',
    'box',
    kit.clothing,
    0,
    kit.top === 'coat' ? 0.86 : 0.95,
    0,
    width,
    kit.top === 'coat' ? 0.83 : 0.65,
    0.3,
  );
  if (kit.top === 'vest') {
    p.add('vest', 'box', kit.trousers, 0, 1.03, 0.03, width * 0.84, 0.48, 0.31);
  }
  if (kit.top === 'coat') {
    p.add('coat-seam', 'box', 'cream', 0, 0.93, 0.16, 0.045, 0.6, 0.025);
  }
  p.add('head', 'sphere', kit.skin, 0, 1.52, 0, 0.43, 0.45, 0.43);
  p.add('hair', 'sphere', kit.hair === 'cap' ? kit.clothing : kit.hairColor, 0, 1.67, -0.025, 0.45, 0.23, 0.44);
  if (kit.hair === 'bun') {
    p.add('hair', 'sphere', kit.hairColor, 0, 1.73, -0.2, 0.26, 0.28, 0.25);
  }
  if (kit.hair === 'cap') {
    p.add('brim', 'box', kit.clothing, 0, 1.63, 0.24, 0.43, 0.06, 0.21);
  }
  if (kit.accessory === 'bag') {
    p.add('bag', 'box', 'trunk', width / 2 + 0.08, 0.77, 0.08, 0.18, 0.32, 0.32);
    p.add('strap', 'box', 'cream', width / 2 + 0.025, 1.02, 0.08, 0.045, 0.48, 0.05);
  } else if (kit.accessory === 'backpack') {
    p.add('backpack', 'box', kit.trousers, 0, 0.96, -0.24, width * 0.8, 0.43, 0.23);
  }
  return p.list.map((part) => ({
    ...part,
    x: part.x * kit.height,
    y: part.y * kit.height,
    z: part.z * kit.height,
    w: part.w * kit.height,
    h: part.h * kit.height,
    d: part.d * kit.height,
  }));
}

export function treeParts(kit: TreeKit): AssetPart[] {
  const p = new Parts(),
    height = kit.height,
    spread = kit.spread;
  p.add('trunk', 'cylinder', 'trunk', 0, 1.55 * height, 0, 0.33, 3.1 * height, 0.33);
  if (kit.trunk === 'forked') {
    for (const side of [-1, 1]) {
      p.add('branch', 'cylinder', 'trunk', side * 0.35, 2.45 * height, 0, 0.18, 1.8 * height, 0.18, 0, 0, side * -0.4);
    }
  }
  if (kit.crown === 'pine') {
    for (let layer = 0; layer < 3; layer++) {
      p.add(
        'crown',
        'cone',
        kit.foliage,
        0,
        (2.5 + layer * 1.1) * height,
        0,
        (3.4 - layer * 0.65) * spread,
        2.5 * height,
        (3.4 - layer * 0.65) * spread,
      );
    }
  } else if (kit.crown === 'column') {
    p.add('crown', 'leaf', kit.foliage, 0, 3.55 * height, 0, 2.3 * spread, 5.1 * height, 2.3 * spread);
  } else {
    p.add(
      'crown',
      kit.crown === 'round' ? 'sphere' : 'leaf',
      kit.foliage,
      0,
      3.65 * height,
      0,
      3.5 * spread,
      3.7 * height,
      3.5 * spread,
    );
    if (kit.crown === 'cluster') {
      for (const side of [-1, 1]) {
        p.add(
          'crown',
          'leaf',
          kit.foliage,
          side * 0.95,
          2.8 * height,
          side * 0.3,
          2.8 * spread,
          2.8 * height,
          2.8 * spread,
        );
      }
    }
  }
  p.add('tree-bed', 'cylinder', 'grassDark', 0, 0.04, 0, 2.3, 0.08, 2.3);
  return p.list;
}

export function propParts(family: PropFamily, kit: PropKit): AssetPart[] {
  const p = new Parts(),
    frame = { metal: 'metal', stone: 'cream', timber: 'trunk' }[kit.frame];
  if (family === 'bench') {
    const length = kit.profile === 'double' ? 3.1 : 2.4;
    for (let n = 0; n < 3 + kit.details; n++) {
      p.add(
        'seat',
        'box',
        kit.color === 'cream' ? 'trunk' : kit.color,
        0,
        0.48,
        -0.34 + (n * 0.68) / (2 + kit.details),
        length,
        0.12,
        0.12,
      );
    }
    for (const side of [-1, 1]) {
      p.add('support', 'box', frame, side * length * 0.35, 0.24, 0, kit.frame === 'stone' ? 0.4 : 0.12, 0.48, 0.75);
    }
    if (kit.profile !== 'minimal') {
      p.add('back', 'box', 'trunk', 0, 0.92, 0.37, length, 0.56, 0.12, -0.12);
    }
  } else if (family === 'lamp') {
    const h = kit.profile === 'classic' ? 4.8 : 5.4;
    p.add('pole', 'cylinder', frame, 0, h / 2, 0, 0.17, h, 0.17);
    p.add('base', 'cylinder', frame, 0, 0.14, 0, 0.48, 0.28, 0.48);
    for (let n = 0; n < kit.details; n++) {
      p.add('collar', 'cylinder', kit.color, 0, 0.6 + n * 0.3, 0, 0.29, 0.08, 0.29);
    }
    const sides = kit.profile === 'double' ? [-1, 1] : [1];
    for (const side of sides) {
      p.add('arm', 'box', frame, side * 0.65, h, 0, 1.45, 0.15, 0.2);
      p.add(
        'lamp-head',
        kit.profile === 'classic' ? 'sphere' : 'box',
        'headlight',
        side * 1.2,
        h - 0.16,
        0,
        kit.profile === 'classic' ? 0.6 : 0.78,
        kit.profile === 'classic' ? 0.63 : 0.16,
        0.55,
      );
      p.add('cap', 'box', kit.color, side * 1.2, h + 0.15, 0, 0.74, 0.09, 0.65);
    }
  } else if (family === 'fountain') {
    const shape = kit.profile === 'minimal' ? 'box' : 'cylinder';
    p.add('basin', shape, kit.color, 0, 0.28, 0, 7, 0.55, 7);
    p.add('water', shape, 'water', 0, 0.59, 0, 6.3, 0.06, 6.3);
    const tiers = kit.profile === 'minimal' ? 1 : kit.details + (kit.profile === 'double' ? 1 : 0);
    for (let tier = 0; tier < tiers; tier++) {
      p.add('stem', 'cylinder', frame, 0, 1 + tier * 0.65, 0, 0.65, 0.8, 0.65);
      p.add('dish', 'cylinder', 'cream', 0, 1.4 + tier * 0.65, 0, 3 - tier * 0.6, 0.15, 3 - tier * 0.6);
      p.add('water', 'cylinder', 'water', 0, 1.49 + tier * 0.65, 0, 2.7 - tier * 0.6, 0.05, 2.7 - tier * 0.6);
    }
    p.add('jet', 'sphere', 'water', 0, 1.3 + tiers * 0.65, 0, 0.3, 0.9, 0.3);
  } else if (family === 'container') {
    p.add('shell', 'box', kit.color, 0, 1.2, 0, 4.2, 2.4, 5.5);
    const ribs = kit.profile === 'minimal' ? 0 : 6 + kit.details * 2;
    for (const side of [-1, 1]) {
      for (let n = 0; n < ribs; n++) {
        p.add('rib', 'box', kit.color, side * 2.12, 1.2, -2.4 + (n * 4.8) / (ribs - 1), 0.08, 2.2, 0.09);
      }
    }
    if (kit.profile === 'double') {
      for (const side of [-1, 1]) {
        p.add('reinforcement', 'box', frame, side * 2.14, 1.2, 0, 0.07, 0.14, 5.4);
      }
    }
    for (const side of [-1, 1]) {
      p.add('door-bar', 'box', frame, side * 0.8, 1.2, 2.78, 0.06, 2.25, 0.05);
    }
  } else if (family === 'crane') {
    const h = 17 + kit.details * 2,
      boom = kit.profile === 'double' ? 29 : 24;
    for (const side of [-1, 1]) {
      p.add('tower', 'box', kit.color, side * 7, h / 2, 0, 0.75, h, 0.8);
      if (kit.profile !== 'minimal') {
        p.add('brace', 'box', kit.color, side * 7, h * 0.32, 0, 0.45, h * 0.64, 0.55, 0, 0, -side * 0.12);
      }
    }
    p.add('crossbeam', 'box', kit.color, 0, h, 4, 16, 1.1, 1.2);
    p.add('boom', 'box', kit.color, 0, h + 0.6, 1, 0.9, 1, boom);
    p.add('cab', 'box', 'window', 0, h - 0.7, 0, 2.5, 1.5, 2.2);
    p.add('cable', 'box', 'metal', 0, h - 5, boom / 2 - 2, 0.1, 11, 0.1);
    p.add('hook', 'box', frame, 0, h - 10.5, boom / 2 - 2, 3, 0.35, 0.8);
  } else {
    p.add('hull', 'box', kit.color, 0, 0.3, 0, 30, 2.5, 6.2);
    p.add('cabin', 'box', 'cream', -11, 2.5, 0, 5, 3, 5.3);
    p.add('bridge', 'box', 'window', -11, 3.3, 2.7, 3.7, 0.8, 0.08);
    for (let n = 0; n < 3 + (kit.profile === 'double' ? 1 : 0); n++) {
      p.add('cargo', 'box', n % 2 ? 'cargoRed' : 'cargoBlue', -4 + n * 4, 2.3, 0, 3.7, 2.1, 5);
    }
    for (let n = 0; n < kit.details; n++) {
      p.add('mast', 'cylinder', frame, -11 + n * 1.5, 5.1, 0, 0.13, 2.4, 0.13);
    }
    if (kit.profile === 'classic') {
      for (const side of [-1, 1]) {
        p.add('rail', 'box', 'cream', 0, 1.7, side * 2.9, 28, 0.12, 0.1);
      }
    }
  }
  return p.list;
}

export function addParts(
  batch: Pick<Batch, 'add'>,
  parts: readonly AssetPart[],
  x: number,
  y: number,
  z: number,
  scale = 1,
  heading = 0,
): void {
  const c = Math.cos(heading),
    s = Math.sin(heading);
  for (const p of parts) {
    batch.add(
      p.shape,
      p.color,
      x + (p.x * c + p.z * s) * scale,
      y + p.y * scale,
      z + (p.z * c - p.x * s) * scale,
      p.w * scale,
      p.h * scale,
      p.d * scale,
      p.ry + heading,
      p.rx,
      p.rz,
    );
  }
}

/** All actors reuse geometry and material batches; adding a recipe does not add one draw per actor. */
export class MovingAssets {
  private readonly groups: Array<{
    mesh: THREE.InstancedMesh;
    records: Array<{ actor: number; part: AssetPart; local: THREE.Matrix4 }>;
  }> = [];
  private readonly local = new THREE.Object3D();
  private readonly world = new THREE.Matrix4();

  constructor(parent: THREE.Group, assets: readonly (readonly AssetPart[])[]) {
    const grouped = new Map<
      string,
      { shape: Shape; color: string; records: Array<{ actor: number; part: AssetPart; local: THREE.Matrix4 }> }
    >();
    assets.forEach((parts, actor) =>
      parts.forEach((part) => {
        const color = ['window', 'litWindow', 'headlight'].includes(part.color) ? part.color : 'assetColor';
        const key = `${part.shape}:${color}:${part.slot === 'chassis' ? 'chassis' : ''}`;
        let group = grouped.get(key);
        if (!group) {
          group = { shape: part.shape, color, records: [] };
          grouped.set(key, group);
        }
        this.local.position.set(part.x, part.y, part.z);
        this.local.scale.set(part.w, part.h, part.d);
        this.local.rotation.set(part.rx, part.ry, part.rz);
        this.local.updateMatrix();
        group.records.push({ actor, part, local: this.local.matrix.clone() });
      }),
    );
    for (const { shape, color, records } of grouped.values()) {
      const mesh = new THREE.InstancedMesh(geometries[shape], material(color), records.length);
      if (records[0]!.part.slot === 'chassis') {
        mesh.name = 'city-traffic-body';
      }
      if (color === 'assetColor') {
        records.forEach(({ part }, i) => mesh.setColorAt(i, material(part.color).color));
      }
      mesh.frustumCulled = false;
      mesh.castShadow = color !== 'headlight';
      mesh.receiveShadow = true;
      mesh.userData['actorIds'] = records.map((record) => record.actor);
      parent.add(mesh);
      this.groups.push({ mesh, records });
    }
  }

  update(poses: readonly THREE.Matrix4[], seconds: number): void {
    for (const { mesh, records } of this.groups) {
      records.forEach(({ actor, part, local }, i) => {
        if (part.swing) {
          this.local.position.set(part.x, part.y, part.z);
          this.local.scale.set(part.w, part.h, part.d);
          this.local.rotation.set(part.rx + Math.sin(seconds * 5 + actor) * 0.3 * part.swing, part.ry, part.rz);
          this.local.updateMatrix();
          this.world.multiplyMatrices(poses[actor]!, this.local.matrix);
        } else {
          this.world.multiplyMatrices(poses[actor]!, local);
        }
        mesh.setMatrixAt(i, this.world);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
