import * as THREE from 'three';
import { Batch, geometries, material } from './primitives';
import {
  RAILWAY_CAR_COUNT,
  RAILWAY_CAR_GAP,
  RAILWAY_CAR_LENGTH,
  RAILWAY_CAR_WIDTH,
  RAILWAY_PLATFORM_LENGTH,
  RAILWAY_ROAD_CENTERS,
  RAILWAY_STATION_X,
  RAILWAY_TRACKS,
} from './railwayLayout';
import type { RailwaySnapshot } from './railway';

const TRACKS = RAILWAY_TRACKS;
const STATION_X = RAILWAY_STATION_X;
const TRACK_START = -229;
const TRACK_END = 161;
const STAIR_COUNT = 18;
const BRIDGE_X = -44.5;

/** Station details stay in the block between roads; ballast leaves the road slab exposed. */
export function railwayInfrastructure(
  batch: Pick<Batch, 'add'>,
  roads: readonly number[] = RAILWAY_ROAD_CENTERS,
): void {
  const insideRoad = (x: number, margin = 0) => roads.some((road) => Math.abs(road - x) < 4 + margin);
  for (const track of TRACKS) {
    let cursor = TRACK_START;
    for (const road of [...roads, TRACK_END + 4.2]) {
      const end = road - 4.2;
      if (end > cursor) {
        batch.add('box', 'roof', (cursor + end) / 2, 0.76, track, end - cursor, 0.15, 3.4);
        for (const offset of [-0.78, 0.78]) {
          batch.add('box', 'metal', (cursor + end) / 2, 0.885, track + offset, end - cursor, 0.08, 0.085);
        }
      }
      cursor = road + 4.2;
    }
    for (let x = TRACK_START + 0.7; x < TRACK_END; x += 0.85) {
      if (!insideRoad(x, 0.2)) {
        batch.add('box', 'trunk', x, 0.835, track, 0.24, 0.09, 2.75);
      }
    }
    for (const road of roads) {
      for (const offset of [-0.78, 0.78]) {
        batch.add('box', 'metal', road, 0.815, track + offset, 8.4, 0.07, 0.085);
      }
    }
  }
  for (const x of roads) {
    batch.add('box', 'asphalt', x, 0.81, -136, 8, 0.08, 11);
    batch.add('box', 'cream', x - 2, 0.861, -146.5, 3.2, 0.02, 0.16);
    batch.add('box', 'cream', x + 2, 0.861, -125.5, 3.2, 0.02, 0.16);
  }
  for (const [index, road] of roads.entries()) {
    const next = roads[index + 1];
    if (next === undefined) {
      continue;
    }
    const x = (road + next) / 2;
    if (x === STATION_X) {
      continue;
    }
    for (const z of [-146.5, -125.5]) {
      batch.add('box', 'metal', x, 5.4, z, 0.2, 9.1, 0.2);
      batch.add('box', 'cream', x, 1.03, z, 0.65, 0.36, 0.65);
    }
    batch.add('box', 'metal', x, 9.5, -136, 0.16, 0.2, 21.4);
    for (const z of TRACKS) {
      batch.add('box', 'metal', x, 9.15, z, 0.1, 0.65, 0.1);
    }
  }
  for (const z of TRACKS) {
    batch.add('box', 'metal', (TRACK_START + TRACK_END) / 2, 9.1, z, TRACK_END - TRACK_START, 0.028, 0.028);
  }
  for (const z of [-142, -130]) {
    batch.add('box', 'paving', STATION_X, 1.12, z, RAILWAY_PLATFORM_LENGTH, 0.55, 3);
    const edge = z === -142 ? z + 1.42 : z - 1.42;
    batch.add('box', 'yellow', STATION_X, 1.406, edge, 25.8, 0.025, 0.16);
    for (const x of [-33, -26]) {
      for (const side of [-0.8, 0.8]) {
        batch.add('box', 'teal', x + side, 2.65, z, 0.12, 2.6, 0.12);
      }
      batch.add('box', 'teal', x, 4.04, z, 2, 0.18, 2.7);
      batch.add('box', 'headlight', x, 3.85, z, 0.45, 0.09, 0.3);
    }
    batch.add('box', 'teal', -28.2, 4.2, z, 13, 0.25, 3.6);
    batch.add('box', 'trim', -28.2, 4.08, z + (z === -142 ? 1.75 : -1.75), 13.2, 0.2, 0.16);
    for (const x of [-29.5, -24]) {
      const seatZ = z === -142 ? z - 0.5 : z + 0.5;
      batch.add('box', 'trunk', x, 1.83, seatZ, 2.1, 0.15, 0.45);
      batch.add('box', 'trunk', x, 2.15, seatZ + (z === -142 ? -0.22 : 0.22), 2.1, 0.5, 0.08);
      for (const dx of [-0.8, 0.8]) {
        batch.add('box', 'metal', x + dx, 1.62, seatZ, 0.12, 0.5, 0.35);
      }
    }
    for (let step = 0; step < STAIR_COUNT; step++) {
      const x = BRIDGE_X + (STAIR_COUNT - step - 0.5) * 0.6;
      const top = 1.4 + (step + 1) * 0.33;
      batch.add('box', 'paving', x, top - 0.12, z, 0.63, 0.24, 1.8);
      for (const dz of [-0.84, 0.84]) {
        batch.add('box', 'cream', x, top + 0.5, z + dz, 0.055, 1, 0.055);
        batch.add('box', 'teal', x, top + 1, z + dz, 0.68, 0.06, 0.06, 0, 0, -Math.atan(0.33 / 0.6));
      }
    }
    for (const x of [BRIDGE_X, BRIDGE_X + 5.4]) {
      batch.add('box', 'metal', x, 3.85, z, 0.2, 5.4, 0.25);
    }
  }
  batch.add('box', 'paving', BRIDGE_X, 7.23, -136, 1.9, 0.24, 12.2);
  for (const dx of [-0.87, 0.87]) {
    batch.add('box', 'teal', BRIDGE_X + dx, 8.25, -136, 0.07, 0.07, 12.3);
    for (let z = -141.8; z < -129.9; z += 0.8) {
      batch.add('box', 'cream', BRIDGE_X + dx, 7.81, z, 0.055, 1, 0.055);
    }
  }
  batch.add('box', 'path', -24, 1.01, -127.1, 3.2, 0.3, 2.8);
  for (const x of [-25.45, -22.55]) {
    batch.add('box', 'teal', x, 1.9, -127.7, 0.12, 1.45, 0.12);
  }
  stationBuilding(batch);
}

function stationBuilding(batch: Pick<Batch, 'add'>): void {
  batch.add('box', 'paving', -34, 0.99, -146.5, 26, 0.28, 4.4);
  batch.add('box', 'brick', -34, 1.47, -146, 19, 0.58, 4.3);
  batch.add('box', 'cream', -34, 3.23, -146, 19, 3, 4.3);
  batch.add('box', 'roof', -34, 5.04, -146, 20.2, 0.7, 5.1);
  batch.add('box', 'trim', -34, 4.81, -148.14, 19.2, 0.25, 0.25);
  batch.add('box', 'trim', -34, 4.81, -143.86, 19.2, 0.25, 0.25);
  for (const z of [-148.18, -143.82]) {
    batch.add('box', 'dark', -33, 2.75, z, 1.65, 2.65, 0.08);
    batch.add('box', 'window', -33, 3.21, z + Math.sign(z + 146) * 0.05, 1.27, 1.55, 0.07);
    batch.add('box', 'gold', -32.5, 2.2, z + Math.sign(z + 146) * 0.1, 0.06, 0.38, 0.05);
    for (const x of [-41.3, -38.5, -28.5]) {
      batch.add('box', 'trim', x, 3.02, z, 1.95, 2, 0.15);
      batch.add('box', 'litWindow', x, 3.04, z + Math.sign(z + 146) * 0.08, 1.65, 1.7, 0.08);
      batch.add('box', 'cream', x, 3.04, z + Math.sign(z + 146) * 0.15, 0.08, 1.7, 0.05);
    }
  }
  batch.add('box', 'sage', -24.8, 4.22, -146, 3.2, 5.9, 3.7);
  batch.add('box', 'trim', -24.8, 6.75, -146, 3.5, 0.25, 4);
  batch.add('hip', 'roof', -24.8, 7.72, -146, 4.3, 1.7, 4.3);
  batch.add('sphere', 'gold', -24.8, 8.68, -146, 0.2, 0.3, 0.2);
  for (const z of [-147.91, -144.09]) {
    batch.add('cylinder', 'trim', -24.8, 5.7, z, 1.8, 0.12, 1.8, 0, Math.PI / 2);
    batch.add('box', 'dark', -24.8, 5.96, z + Math.sign(z + 146) * 0.08, 0.065, 0.65, 0.05, 0, 0, -0.4);
    batch.add('box', 'dark', -24.55, 5.7, z + Math.sign(z + 146) * 0.09, 0.57, 0.065, 0.05);
  }
}

function trainCar(engine: boolean): { group: THREE.Group; doors: THREE.Group[]; wheels: THREE.Mesh[] } {
  const group = new THREE.Group();
  const body = new Batch();
  body.add('box', 'dark', 0, 1.47, 0, 5.05, 0.25, 1.65);
  body.add('box', engine ? 'coral' : 'cream', 0, 2.36, 0, RAILWAY_CAR_LENGTH, 1.6, RAILWAY_CAR_WIDTH);
  body.add('box', engine ? 'cream' : 'teal', 0, 1.67, 0, 5.23, 0.26, 2.12);
  body.add('box', 'roof', 0, 3.31, 0, 5.4, 0.28, 2.24);
  for (const z of [-1.06, 1.06]) {
    for (const x of [-1.6, -0.55, 0.5, 1.55]) {
      body.add('box', 'litWindow', x, 2.65, z, 0.81, 0.68, 0.05);
    }
    if (!engine) {
      for (const x of [-2.05, 2.05]) {
        body.add('box', 'dark', x, 2.32, z + Math.sign(z) * 0.015, 0.58, 1.45, 0.035);
      }
    }
  }
  for (const x of [-2.54, 2.54]) {
    body.add('box', 'dark', x, 2.35, 0, 0.08, 1.2, 0.8);
    body.add('box', 'metal', x * 1.045, 1.48, 0, 0.25, 0.12, 0.55);
  }
  if (engine) {
    body.add('box', 'window', 2.62, 2.75, 0, 0.055, 0.72, 1.64);
    for (const z of [-0.74, 0.74]) {
      body.add('sphere', 'headlight', 2.65, 2.04, z, 0.14, 0.24, 0.24);
    }
    body.add('box', 'metal', -0.6, 3.58, 0, 1.2, 0.25, 0.8);
    body.add('box', 'metal', -0.6, 3.98, 0, 1.9, 0.08, 0.75);
    body.add('box', 'metal', -0.9, 3.81, 0, 0.075, 0.65, 0.06, 0, 0, -0.9);
    body.add('box', 'metal', -0.3, 3.81, 0, 0.075, 0.65, 0.06, 0, 0, 0.9);
  }
  body.finish(group);
  const doors: THREE.Group[] = [];
  if (!engine) {
    for (const z of [-1.105, 1.105]) {
      for (const x of [-2.05, 2.05]) {
        const door = new THREE.Group();
        door.position.set(x, 0, z);
        door.userData['restX'] = x;
        const parts = new Batch();
        parts.add('box', 'teal', 0, 2.32, 0, 0.56, 1.44, 0.06);
        parts.add('box', 'window', 0, 2.68, Math.sign(z) * 0.035, 0.35, 0.47, 0.03);
        parts.add('box', 'gold', 0.15, 2.16, Math.sign(z) * 0.055, 0.035, 0.2, 0.02);
        parts.finish(door);
        group.add(door);
        doors.push(door);
      }
    }
  }
  const wheels: THREE.Mesh[] = [];
  for (const x of [-1.6, 1.6]) {
    for (const z of [-0.99, 0.99]) {
      const wheel = new THREE.Mesh(geometries.cylinder, material('metal'));
      wheel.position.set(x, 1.21, z);
      wheel.scale.set(0.65, 0.16, 0.65);
      wheel.rotation.x = Math.PI / 2;
      wheel.castShadow = true;
      group.add(wheel);
      wheels.push(wheel);
    }
  }
  return { group, doors, wheels };
}

export function createRailwayView() {
  const group = new THREE.Group();
  group.name = 'working-railway';
  const clipped: Array<{ source: THREE.MeshStandardMaterial; copy: THREE.MeshStandardMaterial }> = [];
  const boundaries = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 208.9),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 140.9),
  ];
  const clip = (root: THREE.Object3D): void => {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        const source = object.material;
        const copy = source.clone();
        copy.clippingPlanes = boundaries;
        copy.clipShadows = true;
        object.material = copy;
        clipped.push({ source, copy });
      }
    });
  };
  const infrastructure = new Batch();
  railwayInfrastructure(infrastructure);
  const trackRoot = new THREE.Group();
  infrastructure.finish(trackRoot);
  clip(trackRoot);
  group.add(trackRoot);
  const station = new THREE.Group();
  station.name = 'railway-station';
  group.add(station);
  const target = new THREE.Mesh(geometries.box, material('cream'));
  target.position.set(STATION_X, 3.2, -146);
  target.scale.set(26, 5, 5);
  target.userData['railwayStation'] = true;
  target.updateMatrixWorld();
  const targets = [target];
  const ownedTextures: THREE.Texture[] = [];
  const ownedMaterials: THREE.Material[] = [];
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = '#f9efd7';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#344d4d';
      context.font = 'bold 66px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('ВОКЗАЛ', 256, 51);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      ownedTextures.push(texture);
      const labelMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.82 });
      ownedMaterials.push(labelMaterial);
      for (const [z, yaw] of [
        [-148.26, Math.PI],
        [-143.74, 0],
      ] as const) {
        const label = new THREE.Mesh(geometries.box, labelMaterial);
        label.position.set(-34, 4.4, z);
        label.rotation.y = yaw;
        label.scale.set(4.8, 0.85, 0.045);
        station.add(label);
      }
    }
  }
  const train = new THREE.Group();
  train.name = 'railway-train';
  train.visible = false;
  const cars = Array.from({ length: RAILWAY_CAR_COUNT }, (_, index) => {
    const car = trainCar(index === 0);
    car.group.position.x = ((RAILWAY_CAR_COUNT - 1) / 2 - index) * (RAILWAY_CAR_LENGTH + RAILWAY_CAR_GAP);
    car.group.name = index === 0 ? 'railway-engine' : `railway-coach-${index}`;
    train.add(car.group);
    return car;
  });
  clip(train);
  group.add(train);
  const barriers = RAILWAY_ROAD_CENTERS.map((x, id) => {
    const crossing = new THREE.Group();
    crossing.name = `railway-crossing-${id}`;
    const signals: THREE.Mesh[] = [];
    const arms: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.name = `railway-gate-${id}-${side}`;
      pivot.position.set(x + side * 4.2, 1.9, -136 + side * 8.6);
      pivot.rotation.z = (-side * Math.PI) / 2;
      const pole = new Batch();
      pole.add('box', 'cream', pivot.position.x, 1.15, pivot.position.z, 0.6, 0.6, 0.6);
      pole.add('box', 'teal', pivot.position.x, 1.55, pivot.position.z, 0.38, 0.9, 0.4);
      const signalX = x + side * 4.48;
      pole.add('box', 'metal', signalX, 2.2, pivot.position.z + side * 0.9, 0.12, 2.7, 0.12);
      pole.add('box', 'dark', signalX, 3.15, pivot.position.z + side * 0.9, 0.65, 0.6, 0.3);
      pole.add('box', 'cream', signalX, 3.75, pivot.position.z + side * 0.9, 0.8, 0.11, 0.12, 0, 0, 0.55);
      pole.add('box', 'cream', signalX, 3.75, pivot.position.z + side * 0.9, 0.8, 0.11, 0.12, 0, 0, -0.55);
      pole.finish(crossing);
      const arm = new Batch();
      arm.add('box', 'cream', -side * 2.18, 0, 0, 4.36, 0.14, 0.15);
      for (const distance of [0.5, 1.5, 2.5, 3.5]) {
        arm.add('box', 'red', -side * distance, 0, 0, 0.45, 0.16, 0.16);
      }
      arm.finish(pivot);
      pivot.userData['side'] = side;
      crossing.add(pivot);
      arms.push(pivot);
      for (const dx of [-0.17, 0.17]) {
        const copy = material('red').clone();
        copy.emissive.set(0xdf715a);
        copy.emissiveIntensity = 0;
        ownedMaterials.push(copy);
        const light = new THREE.Mesh(geometries.sphere, copy);
        light.position.set(signalX + dx, 3.15, pivot.position.z + side * 1.08);
        light.scale.set(0.23, 0.23, 0.12);
        crossing.add(light);
        signals.push(light);
      }
    }
    group.add(crossing);
    return { arms, signals };
  });
  let doorsOpen = 0;
  let lastSeconds = 0;
  return {
    group,
    targets,
    update(snapshot: RailwaySnapshot, seconds: number): void {
      const pose = snapshot.train;
      train.visible = pose.phase !== 'away';
      train.position.set(pose.x, 0, pose.z);
      train.rotation.y = pose.direction === 1 ? 0 : Math.PI;
      const doorTarget = pose.doorsOpen ? 1 : 0;
      if (seconds < lastSeconds) {
        doorsOpen = doorTarget;
      }
      const doorStep = Math.max(0, Math.min(1, seconds - lastSeconds)) * 2.5;
      doorsOpen += Math.sign(doorTarget - doorsOpen) * Math.min(Math.abs(doorTarget - doorsOpen), doorStep);
      lastSeconds = seconds;
      for (const car of cars) {
        for (const door of car.doors) {
          const restX = door.userData['restX'] as number;
          door.position.x = restX + (door.position.z < 0 ? -Math.sign(restX) * 0.5 * doorsOpen : 0);
        }
        for (const wheel of car.wheels) {
          wheel.rotation.z = -pose.x / 0.325;
        }
      }
      for (const state of snapshot.crossings) {
        const crossing = barriers[state.id];
        if (!crossing) {
          continue;
        }
        for (const arm of crossing.arms) {
          const side = arm.userData['side'] as number;
          arm.rotation.z = (-side * state.openness * Math.PI) / 2;
        }
        crossing.signals.forEach((light, index) => {
          const lightMaterial = light.material;
          if (lightMaterial instanceof THREE.MeshStandardMaterial) {
            const waiting = state.openness < 1 || state.state !== 'open';
            lightMaterial.color.copy(material(waiting ? 'red' : 'sage').color);
            lightMaterial.emissive.copy(material(waiting ? 'red' : 'sage').color);
            lightMaterial.emissiveIntensity = waiting ? (Math.floor(seconds * 3) % 2 === index % 2 ? 2.4 : 0.05) : 0.2;
          }
        });
      }
    },
    syncLighting(): void {
      for (const { source, copy } of clipped) {
        copy.color.copy(source.color);
        copy.emissive.copy(source.emissive);
        copy.emissiveIntensity = source.emissiveIntensity;
      }
    },
    dispose(): void {
      group.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) {
          object.dispose();
        }
      });
      ownedTextures.forEach((texture) => texture.dispose());
      ownedMaterials.forEach((owned) => owned.dispose());
      clipped.forEach(({ copy }) => copy.dispose());
    },
  };
}
