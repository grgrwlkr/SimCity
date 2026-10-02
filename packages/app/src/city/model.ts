import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Batch, material, materials, roadLoop, type BatchObject } from './primitives';
import { type CityBuilding, type CityLayout } from './generator';
import { CITY_ROAD_CENTERS, CITY_ROAD_WIDTH } from './trafficRoutes';
import { CityTraffic } from './trafficFlow';
import { personKit, propKit, treeKit } from './assetKits';
import { addParts, MovingAssets, personParts, propParts, treeParts, vehicleParts } from './assetParts';
import { buildingTop, lowriseModules, roofModules } from './buildingModules';
import { AMBIENT_VEHICLES, BERTHS, WAREHOUSES, FREIGHT_JUNCTIONS, cityVehicleKits } from './harborLayout';
import { Harbor, freightPlans, type HarborStatus } from './harbor';
import { createHarborView } from './harborView';
import { Construction } from './construction';
import type { ConstructionPlot } from './constructionSite';

for (const [key, color] of Object.entries({ glassBlue: 0x789aaf, glassTeal: 0x669b99, glassDark: 0x4c6c7e, glassSilver: 0xa0b6ba, steel: 0xb6c5c5, port: 0xc7c1ac, cargoRed: 0xb85d48, cargoBlue: 0x527d90, cargoGold: 0xcdaa51, waterline: 0x9ccfca, assetColor: 0xffffff, skinLight: 0xefc8a1, skinTan: 0xba8c69, skinDeep: 0x775440 })) {
  materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: key.startsWith('glass') ? 0.34 : 0.75, metalness: key.startsWith('glass') ? 0.25 : 0.05 }));
}

function skyscraper(batch: Batch, b: CityBuilding): void {
  const { x, z, width: w, depth: d, height: h, color, kit } = b;
  batch.add('box', 'paving', x, 1.1, z, w + 0.5, 0.4, d + 0.5);
  batch.add('box', kit.foundation === 'brick' ? 'brick' : 'dark', x, 2.8, z, w + 0.2, 3.2, d + 0.2);
  const tiers = b.variant === 'stepped' ? 4 : b.variant === 'crown' ? 3 : 1;
  for (let tier = 0; tier < tiers; tier++) {
    const scale = 1 - tier * 0.15;
    const th = (h - 4) / tiers, bottom = 4 + tier * th;
    batch.add('box', color, x, bottom + th / 2, z, w * scale, th, d * scale);
    const bands = Math.floor(th / 2.65);
    for (let floor = 0; floor < bands; floor++) {
      const y = bottom + floor * th / bands;
      if (kit.facade !== 'vertical' || floor % 5 === 0) batch.add('box', kit.facade === 'ribbon' ? kit.accent : 'steel', x, y, z, w * scale + 0.14, kit.facade === 'ribbon' ? 0.35 : 0.12, d * scale + 0.14);
      for (const side of [-1, 1]) for (let col = 0; col < kit.rhythm; col++) {
        const glass = (floor * 7 + col * 3 + tier) % 5 < 2 ? 'litWindow' : color;
        const wx = x + ((col + 0.5) / kit.rhythm - 0.5) * w * scale;
        const wz = z + ((col + 0.5) / kit.rhythm - 0.5) * d * scale;
        const pane = kit.facade === 'ribbon' ? 0.96 : kit.facade === 'recessed' ? 0.61 : 0.8;
        batch.add('box', glass, wx, y + 1.1, z + side * (d * scale / 2 + 0.025), w * scale / kit.rhythm * pane, 1.85, 0.04);
        batch.add('box', glass, x + side * (w * scale / 2 + 0.025), y + 1.1, wz, 0.04, 1.85, d * scale / kit.rhythm * pane);
      }
    }
    for (const side of [-1, 1]) for (let col = 0; col <= kit.rhythm; col++) {
      batch.add('box', kit.facade === 'vertical' ? kit.accent : 'steel', x + (col / kit.rhythm - 0.5) * w * scale, bottom + th / 2, z + side * d * scale / 2, kit.facade === 'vertical' ? 0.24 : 0.1, th, 0.13);
      batch.add('box', kit.facade === 'vertical' ? kit.accent : 'steel', x + side * w * scale / 2, bottom + th / 2, z + (col / kit.rhythm - 0.5) * d * scale, 0.13, th, kit.facade === 'vertical' ? 0.24 : 0.1);
    }
  }
  const cap = 1 - (tiers - 1) * 0.15;
  batch.add('box', 'cream', x, h + 0.2, z, w * cap + 0.4, 0.4, d * cap + 0.4);
  roofModules(batch, b, w * cap, d * cap, h + 0.4);
  if (kit.foundation === 'columns') for (const side of [-1, 1]) for (let col = 0; col <= kit.rhythm; col++) batch.add('box', kit.accent, x + (col / kit.rhythm - 0.5) * w * 0.92, 2.8, z + side * (d / 2 + 0.15), 0.3, 3.4, 0.3);
  if (kit.entrance === 'canopy') batch.add('box', kit.accent, x, 4.1, z + d / 2 + 0.65, w * 0.5, 0.22, 1.3);
  if (kit.entrance === 'steps') batch.add('box', 'paving', x, 1.25, z + d / 2 + 0.4, w * 0.5, 0.5, 1.1);
  if (b.variant === 'slab') {
    batch.add('box', 'cream', x + w / 2, h / 2 + 2, z, 0.65, h, d * 0.35);
  }
}

function industry(batch: Batch, b: CityBuilding, chimneys: THREE.Vector3[]): void {
  const { x, z, width: w, depth: d, height: h, kit } = b;
  batch.add('box', kit.foundation === 'brick' ? 'brick' : 'port', x, 1.02, z, w + 0.5, 0.22, d + 0.5);
  if (b.variant === 'tanks') {
    const tanks = kit.equipmentCount + 1, diameter = Math.min(5.2, w / tanks * 0.8), height = h * 0.55 + 3.4;
    for (let n = 0; n < tanks; n++) {
      const dx = ((n + 0.5) / tanks - 0.5) * w;
      batch.add('cylinder', 'cream', x + dx, 1.1 + height / 2, z, diameter, height, diameter);
      batch.add(kit.roof === 'cone' ? 'cone' : 'sphere', 'steel', x + dx, 1.1 + height + (kit.roof === 'cone' ? 0.7 : 0), z, diameter, kit.roof === 'cone' ? 1.4 : 2.3, diameter);
      for (let band = 0; band < kit.rhythm; band++) batch.add('cylinder', kit.accent, x + dx, 1.5 + band * (height - 0.7) / kit.rhythm, z, diameter + 0.1, 0.16, diameter + 0.1);
      batch.add('cylinder', 'metal', x + dx, height + 2.35, z, 0.4, 0.5, 0.4);
      batch.add('box', 'metal', x + dx, 1.5, z + d / 2 - 0.3, 0.18, 0.25, d / 2);
    }
    batch.add('box', 'gold', x, 1.5, z + d / 2 - 0.3, w, 0.22, 0.23);
    return;
  }
  const roofHeight = Math.min(h, 8.4);
  batch.add('box', b.color, x, 1 + roofHeight / 2, z, w, roofHeight, d);
  batch.add('box', 'cream', x, 1.7, z, w + 0.1, 0.7, d + 0.1);
  if (kit.roof === 'sawtooth') {
    for (let i = 0; i < kit.rhythm; i++) {
      batch.add('roof', 'roof', x - w / 2 + (i + 0.5) * w / kit.rhythm, roofHeight + 2, z, w / kit.rhythm + 0.08, 2.3, d + 0.5);
      batch.add('box', 'glassBlue', x - w / 2 + (i + 0.78) * w / kit.rhythm, roofHeight + 2, z, 0.1, 1.4, d - 0.3);
      if (kit.rooftop === 'vents' && i < kit.equipmentCount) batch.add('box', 'steel', x - w / 2 + (i + 0.5) * w / kit.rhythm, roofHeight + 3.3, z - d * 0.24, 1.1, 0.45, 1.3);
    }
  } else {
    batch.add('box', 'roof', x, roofHeight + 1.2, z, w + 0.5, 0.4, d + 0.5);
    roofModules(batch, b, w, d, roofHeight + 1.4);
  }
  for (let i = 0; i < kit.rhythm + 1; i++) {
    const wx = x + ((i + 0.5) / (kit.rhythm + 1) - 0.5) * w;
    if (kit.facade === 'classic' || kit.facade === 'recessed') batch.add('box', kit.facade === 'classic' ? kit.accent : 'dark', wx, roofHeight - 0.3, z + d / 2 + 0.03, 2.6, 1.5, 0.1);
    batch.add('box', 'litWindow', wx, roofHeight - 0.3, z + d / 2 + 0.07, kit.facade === 'ribbon' ? w / (kit.rhythm + 1) * 0.94 : 2.3, 1.25, 0.08);
    batch.add('box', 'metal', wx, 2.8, z + d / 2 + 0.1, 2.3, 3.3, 0.1);
    for (let stripe = 0; stripe < 5; stripe++) batch.add('box', 'steel', wx, 1.4 + stripe * 0.6, z + d / 2 + 0.18, 2.1, 0.07, 0.05);
  }
  if (kit.facade === 'vertical') for (let i = 0; i <= kit.rhythm + 1; i++) batch.add('box', kit.accent, x + (i / (kit.rhythm + 1) - 0.5) * w * 0.98, 1 + roofHeight / 2, z + d / 2 + 0.1, 0.2, roofHeight, 0.2);
  if (kit.entrance === 'canopy') batch.add('box', kit.accent, x, 4.8, z + d / 2 + 0.55, w * 0.84, 0.18, 1.1);
  if (b.variant === 'power') {
    for (let n = 0; n < kit.equipmentCount; n++) {
      const dx = ((n + 0.5) / kit.equipmentCount - 0.5) * w * 0.75;
      const height = h + 15;
      batch.add('cylinder', 'brick', x + dx, height / 2 + 1, z - 1, 1.8, height, 1.8);
      for (let stripe = 0; stripe < 4; stripe++) batch.add('cylinder', 'cream', x + dx, height - 2 - stripe * 3.6, z - 1, 1.83, 1.1, 1.83);
      batch.add('cylinder', 'metal', x + dx, height + 1.1, z - 1, 2.1, 0.35, 2.1);
      chimneys.push(new THREE.Vector3(x + dx, height + 1.5, z - 1));
    }
  }
}

export interface GeneratedCity {
  group: THREE.Group;
  hitboxes: THREE.Mesh[];
  treeCount: number;
  peopleCount: number;
  harborStatus: () => HarborStatus;
  construction: Construction;
  updateConstruction: (seconds: number) => void;
  update: (seconds: number) => void;
  setNight: (night: boolean) => void;
  dispose: () => void;
}

export function createCity(layout: CityLayout): GeneratedCity {
  const group = new THREE.Group(), batch = new Batch();
  const owned = new Set<THREE.BufferGeometry>();
  const own = <T extends THREE.BufferGeometry>(geometry: T): T => { owned.add(geometry); return geometry; };
  const mesh = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) => {
    const result = new THREE.Mesh(own(geometry), material(color));
    result.position.set(x, y, z); result.receiveShadow = true; result.castShadow = true; group.add(result); return result;
  };
  mesh(new RoundedBoxGeometry(282, 5.5, 308, 3, 2), 'cream', 0, -2.3, 12);
  mesh(new RoundedBoxGeometry(280, 0.8, 306, 3, 2), 'trunk', 0, -5.03, 12);
  mesh(new RoundedBoxGeometry(278, 0.5, 270, 2, 1), 'grass', 0, 0.48, -6);
  batch.add('box', 'water', 0, 0.42, 145, 277, 0.25, 32);
  for (let i = 0; i < 42; i++) batch.add('box', 'waterline', -127 + (i * 31) % 184, 0.56, 133 + (i * 7) % 26, 2.5 + (i % 5), 0.015, 0.16);
  // The freight access opens the promenade instead of sending trucks through its raised curb.
  batch.add('box', 'paving', -44.5, 0.83, 127.5, 183, 0.6, 5);
  batch.add('box', 'paving', 129.5, 0.83, 127.5, 13, 0.6, 5);
  batch.add('box', 'cream', -44.5, 0.64, 130.1, 183, 1.9, 0.65);
  batch.add('box', 'cream', 129.5, 0.64, 130.1, 13, 1.9, 0.65);
  // A connected street grid surrounds every block; marking gaps keep junctions legible.
  const roads = CITY_ROAD_CENTERS;
  const roadLength = roads[roads.length - 1]! - roads[0]! + CITY_ROAD_WIDTH;
  for (const position of roads) {
    batch.add('box', 'asphalt', position, 0.79, 0, CITY_ROAD_WIDTH, 0.12, roadLength);
    batch.add('box', 'asphalt', 0, 0.79, position, roadLength, 0.12, CITY_ROAD_WIDTH);
    for (let along = -115; along <= 115; along += 4) {
      if (roads.some((cross) => Math.abs(along - cross) < 5)) continue;
      batch.add('box', 'cream', position, 0.865, along, 0.13, 0.015, 1.7);
      batch.add('box', 'cream', along, 0.865, position, 1.7, 0.015, 0.13);
    }
  }
  let treeCount = 0;
  const plant = (x: number, z: number, scale: number) => {
    addParts(batch, treeParts(treeKit(layout.seed, `${x}/${z}`)), x, 1, z, scale); treeCount++;
  };
  const bench = (x: number, z: number, heading = 0) => addParts(batch, propParts('bench', propKit(layout.seed, 'bench', `${x}/${z}`)), x, 1.03, z, 1, heading);
  const lampPositions: THREE.Vector3[] = [];
  for (const [index, block] of layout.blocks.entries()) {
    const freightYard = WAREHOUSES.some((yard) => yard.blockId === block.id);
    batch.add('box', block.district === 'industrial' ? 'port' : 'paving', block.x, freightYard ? 0.7 : 0.91, block.z, 26, 0.3, 26);
    if (block.district === 'park') {
      batch.add('box', 'grass', block.x, 1.11, block.z, 23.6, 0.1, 23.6);
      batch.add('box', 'path', block.x, 1.18, block.z, 23.6, 0.05, 2.5);
      batch.add('box', 'path', block.x, 1.18, block.z, 2.5, 0.05, 23.6);
      for (const dx of [-8, -4, 5, 9]) for (const dz of [-8, 7]) plant(block.x + dx, block.z + dz, 1.2 + (index % 3) * 0.2);
      addParts(batch, propParts('fountain', propKit(layout.seed, 'fountain', block.id)), block.x, 1.1, block.z);
      bench(block.x - 6, block.z - 3); bench(block.x + 6, block.z + 3, Math.PI);
    } else if (block.district !== 'industrial') {
      for (const [dx, dz] of [[-12,-10],[12,10],[-12,10],[12,-10]]) plant(block.x + dx!, block.z + dz!, 0.86);
    }
    for (const side of [-1, 1]) {
      const lx = block.x + side * 12.4, lz = block.z + side * 4;
      addParts(batch, propParts('lamp', propKit(layout.seed, 'lamp', `${block.id}/${side}`)), lx, freightYard ? 0.87 : 1.03, lz, 1, side > 0 ? 0 : Math.PI);
      lampPositions.push(new THREE.Vector3(lx, 1.13, lz));
    }
    if (index % 3 === 0) for (let stripe = 0; stripe < 6; stripe++) {
      batch.add('box', 'white', block.x + 17, 0.874, block.z + 11.7 + stripe * 0.84, 2.5, 0.02, 0.42);
    }
  }
  // Waterfront promenade and industrial quays.
  for (let x = -126; x < 48; x += 9) {
    plant(x, 126, 0.92);
    if (x % 3 === 0) bench(x + 3, 128, Math.PI);
  }
  batch.add('box', 'port', 85, 0.5, 135, 76, 0.7, 24);
  batch.add('box', 'asphalt', 85, 0.875, 138, 76, 0.04, 4);
  for (const x of [51, 85, 119]) batch.add('box', 'asphalt', x, 0.875, 129.5, 8, 0.04, 21);
  for (const x of BERTHS) {
    batch.add('box', 'port', x, 0.85, 144.3, 22, 0.8, 5.4);
    for (const offset of [-5, 0, 5]) for (const z of [142.8, 145.8]) {
      batch.add('box', 'cream', x + offset, 1.26, z - 1, 4.8, 0.025, 0.08);
      batch.add('box', 'cream', x + offset, 1.26, z + 1, 4.8, 0.025, 0.08);
    }
  }
  for (const yard of WAREHOUSES) {
    batch.add('box', 'asphalt', yard.x, 0.875, yard.z + 6, 26, 0.04, 4);
    for (const offset of [-5, 5]) batch.add('box', 'gold', yard.x + offset, 0.902, yard.z + 6, 0.13, 0.02, 3.6);
    batch.add('box', 'metal', yard.x, 0.91, yard.z - 1, 2.2, 0.1, 6);
    for (let n = 0; n < 9; n++) batch.add('box', 'steel', yard.x, 0.98, yard.z - 3.6 + n * 0.65, 2, 0.05, 0.13);
  }

  const chimneys: THREE.Vector3[] = [];
  const chimneyBuildings: string[] = [];
  const buildings = new Map<string, BatchObject>();
  for (const b of layout.buildings) {
    const firstChimney = chimneys.length;
    buildings.set(b.id, batch.capture((sink) => {
      if (b.district === 'downtown') skyscraper(sink, b);
      else if (b.district === 'industrial') industry(sink, b, chimneys);
      else lowriseModules(sink, b);
    }));
    for (let i = firstChimney; i < chimneys.length; i++) chimneyBuildings.push(b.id);
  }
  batch.finish(group);
  const plots = new Map<string, ConstructionPlot>();
  for (const b of layout.buildings) {
    const block = layout.blocks.find((block) => block.id === b.blockId)!;
    const neighbours = layout.buildings.filter((other) => other.blockId === b.blockId);
    const left = Math.max(block.x - 12.75, ...neighbours.filter((other) => other.x < b.x).map((other) => (other.x + b.x) / 2));
    const right = Math.min(block.x + 12.75, ...neighbours.filter((other) => other.x > b.x).map((other) => (other.x + b.x) / 2));
    const back = Math.max(block.z - 12.75, ...neighbours.filter((other) => other.z < b.z).map((other) => (other.z + b.z) / 2));
    const front = Math.min(block.z + 12.75, ...neighbours.filter((other) => other.z > b.z).map((other) => (other.z + b.z) / 2));
    plots.set(b.id, {
      x: b.x, z: b.z, width: b.width, depth: b.depth,
      minX: Math.max(left + 0.1, b.x - b.width / 2 - 1), maxX: Math.min(right - 0.1, b.x + b.width / 2 + 1),
      minZ: Math.max(back + 0.1, b.z - b.depth / 2 - 1.15), maxZ: Math.min(front - 0.1, b.z + b.depth / 2 + 1.15),
    });
  }
  const construction = new Construction(buildings, plots, (id, x, z, radius) => {
    let height = 0;
    for (const other of layout.buildings) {
      if (other.id === id) continue;
      const dx = Math.max(0, Math.abs(other.x - x) - other.width / 2), dz = Math.max(0, Math.abs(other.z - z) - other.depth / 2);
      if (Math.hypot(dx, dz) < radius + 0.5) height = Math.max(height, buildingTop(other));
    }
    return height;
  });
  group.add(construction.group);
  const hitGeometry = own(new THREE.BoxGeometry(1, 1, 1));
  const hitboxes = layout.buildings.map((building) => {
    const height = buildingTop(building);
    const box = new THREE.Mesh(hitGeometry, material('cream'));
    box.scale.set(building.width, height, building.depth);
    box.position.set(building.x, height / 2, building.z);
    box.userData['building'] = building; box.updateMatrixWorld(); return box;
  });

  const dummy = new THREE.Object3D();
  const lampPoolMaterial = new THREE.MeshBasicMaterial({ color: 0xffd99a, transparent: true, opacity: 0.17, depthWrite: false });
  const lampPools = new THREE.InstancedMesh(own(new THREE.CircleGeometry(3.3, 16)), lampPoolMaterial, lampPositions.length);
  lampPositions.forEach((p, i) => { dummy.position.copy(p); dummy.rotation.set(-Math.PI / 2, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); lampPools.setMatrixAt(i, dummy.matrix); });
  lampPools.visible = false; group.add(lampPools);

  const harbor = new Harbor(), harborView = createHarborView(layout.seed);
  group.add(harborView.group);
  const moving = createTraffic(group, layout.seed, harbor);
  const people = createPedestrians(group, layout);
  const smokeMaterial = new THREE.MeshStandardMaterial({ color: 0xe3e1d6, transparent: true, opacity: 0.3, depthWrite: false, roughness: 1 });
  const smoke = new THREE.InstancedMesh(own(new THREE.IcosahedronGeometry(1, 1)), smokeMaterial, chimneys.length * 7);
  smoke.frustumCulled = false; group.add(smoke);
  let lastSeconds = 0;
  const updateSmoke = (seconds: number) => {
    const status = construction.status();
    chimneys.forEach((source, index) => {
      for (let n = 0; n < 7; n++) {
        const progress = ((seconds * 0.13 + n / 7 + index * 0.11) % 1 + 1) % 1;
        dummy.position.copy(source).add(new THREE.Vector3(progress * 8, progress * 16, progress * 2));
        dummy.rotation.set(progress, progress * 2, n);
        dummy.scale.setScalar((1.1 + progress * 3.2) * Math.sin(progress * Math.PI));
        if (status && status.id === chimneyBuildings[index] && status.progress < 1) dummy.scale.setScalar(0);
        dummy.updateMatrix(); smoke.setMatrixAt(index * 7 + n, dummy.matrix);
      }
    });
    smoke.instanceMatrix.needsUpdate = true;
  };
  const update = (seconds: number) => {
    lastSeconds = seconds;
    const vehicles = moving(seconds);
    harborView.update(harbor.snapshot(seconds, vehicles), seconds);
    people.update(seconds);
    updateSmoke(seconds);
  };
  update(0);
  return {
    group, hitboxes, treeCount, peopleCount: people.count, update, harborStatus: () => harbor.status(), construction,
    updateConstruction(seconds) { construction.advance(seconds); updateSmoke(lastSeconds); },
    setNight(night) { lampPools.visible = night; harborView.syncLighting(); construction.syncLighting(); },
    dispose() {
      construction.dispose();
      group.traverse((object) => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
      for (const geometry of owned) geometry.dispose();
      lampPoolMaterial.dispose(); smokeMaterial.dispose(); harborView.dispose();
    },
  };
}

/** Chassis, cabins, wheels and accessories share instanced material/shape batches. */
function createTraffic(group: THREE.Group, seed: string, harbor: Harbor) {
  const kits = cityVehicleKits(seed), count = kits.length;
  const assets = new MovingAssets(group, kits.map((kit, id) => {
    const parts = vehicleParts(kit);
    if (id < AMBIENT_VEHICLES) return parts;
    const flatbed = parts.filter((part) => part.slot !== 'cargo' && part.slot !== 'cargo-trim');
    for (const side of [-1, 1]) for (const z of [0.8, -3.5]) for (const slot of ['wheel', 'hub']) {
      const part = parts.find((part) => part.slot === slot && Math.sign(part.x) === side)!;
      flatbed.push({ ...part, z });
    }
    const chassis = parts.find((part) => part.slot === 'chassis')!;
    flatbed.push({ ...chassis, slot: 'trailer-bed', color: 'steel', y: 0.99, z: -1.2, w: 1.83, h: 0.1, d: 5.4 });
    return flatbed;
  }));
  const poses = Array.from({ length: count }, () => new THREE.Matrix4());
  const transform = new THREE.Object3D();
  const traffic = new CityTraffic(kits, { plans: freightPlans(), junctions: FREIGHT_JUNCTIONS, onStep: (time, traffic) => harbor.advance(time, traffic), onReset: () => harbor.reset() });
  return (seconds: number) => {
    const vehicles = traffic.update(seconds);
    for (let i = 0; i < count; i++) {
      const pose = vehicles[i]!;
      transform.position.set(pose.x, 0.91, pose.z); transform.rotation.set(0, Math.atan2(pose.dx, pose.dz), 0);
      transform.updateMatrix(); poses[i]!.copy(transform.matrix);
    }
    assets.update(poses, seconds);
    return vehicles;
  };
}

function createPedestrians(group: THREE.Group, layout: CityLayout): { count: number; update: (seconds: number) => void } {
  const actors = layout.blocks.filter((b) => b.district !== 'industrial').flatMap((block) => [0, 1].map((n) => ({
    block, n, parts: personParts(personKit(layout.seed, `${block.id}/${n}`)),
  })));
  const assets = new MovingAssets(group, actors.map((actor) => actor.parts));
  const route = roadLoop(12.55, 12.55, 1.75), length = route.getLength();
  const transform = new THREE.Object3D(), poses = actors.map(() => new THREE.Matrix4());
  return {
    count: actors.length,
    update(seconds) {
      actors.forEach(({ block, n }, i) => {
        const direction = n ? -1 : 1;
        const progress = ((n * 0.5 + i * 0.013 + seconds * 1.2 / length * direction) % 1 + 1) % 1;
        const point = route.getPointAt(progress), tangent = route.getTangentAt(progress);
        transform.position.set(block.x + point.x, 1.07 + Math.abs(Math.sin(seconds * 5 + i)) * 0.025, block.z + point.z);
        transform.rotation.set(0, Math.atan2(tangent.x * direction, tangent.z * direction), 0);
        transform.updateMatrix(); poses[i]!.copy(transform.matrix);
      });
      assets.update(poses, seconds);
    },
  };
}
