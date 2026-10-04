import * as THREE from 'three';
import {Batch, material} from './primitives';
import type {BatchObject} from './primitives';
import {createCity, drawNativeBuilding} from './model';
import type {GeneratedCity} from './model';
import {drawNativeBlock} from './blockModules';
import {Construction} from './construction';
import {createConstructionSite} from './constructionSite';
import type {ConstructionPlot} from './constructionSite';
import {buildingTop} from './buildingModules';
import {createLifeProfile} from './life/network';
import {transformPlacement} from './life/definition';
import type {
  CityWorldDefinition,
  AuthoredWorldDefinition,
  AuthoredPlacement,
} from './life/definition';
import {generateCity} from './generator';
import type {CityLayout, CityBuilding} from './generator';
import {CITY_GRID} from './cityGrid';
import {createNativeRegionView} from './regionGeography';
import type {NativeRegionGeography} from './regionGeography';
import type {HarborStatus} from './harbor';
import {roadContour} from '../region/model/roads';
import {rectangle} from '../region/model/geometry';
import {CITY_ROAD_WIDTH} from './trafficRoutes';
import {createNativeInfrastructureView} from './nativeInfrastructureView';
import {nativePlacementTransform} from './nativeInfrastructurePlacement';
import {addAuthoredRoadDetails} from './nativeRoadParts';

interface PlacedAssembly {
  sourcePlot: ConstructionPlot;
  transform: THREE.Matrix4;
}

function sourcePlot(layout: CityLayout, b: CityBuilding): ConstructionPlot {
  if (b.plot) {
    const p = b.plot;

    return {
      x: b.x,
      z: b.z,
      width: b.width,
      depth: b.depth,
      minX: p.x - p.width / 2 + 0.3,
      maxX: p.x + p.width / 2 - 0.3,
      minZ: p.z - p.depth / 2 + 0.3,
      maxZ: p.z + p.depth / 2 - 0.3,
      craneSide: p.front === 'north' ? 1 : -1,
      front: p.front,
    };
  }

  const block = layout.blocks.find(item => item.id === b.blockId)!;
  const neighbours = layout.buildings.filter(
    other => other.blockId === b.blockId,
  );
  const left = Math.max(
    block.x - 12.75,
    ...neighbours
      .filter(other => other.x < b.x)
      .map(other => (other.x + b.x) / 2),
  );
  const right = Math.min(
    block.x + 12.75,
    ...neighbours
      .filter(other => other.x > b.x)
      .map(other => (other.x + b.x) / 2),
  );
  const back = Math.max(
    block.z - 12.75,
    ...neighbours
      .filter(other => other.z < b.z)
      .map(other => (other.z + b.z) / 2),
  );
  const front = Math.min(
    block.z + 12.75,
    ...neighbours
      .filter(other => other.z > b.z)
      .map(other => (other.z + b.z) / 2),
  );

  return {
    x: b.x,
    z: b.z,
    width: b.width,
    depth: b.depth,
    minX: Math.max(left + 0.1, b.x - b.width / 2 - 1),
    maxX: Math.min(right - 0.1, b.x + b.width / 2 + 1),
    minZ: Math.max(back + 0.1, b.z - b.depth / 2 - 1.15),
    maxZ: Math.min(front - 0.1, b.z + b.depth / 2 + 1.15),
  };
}

function placementMatrix(placement: AuthoredPlacement): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(placement.center.x, 0, placement.center.z)
    .multiply(new THREE.Matrix4().makeRotationY(placement.yaw))
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -placement.template.x,
        0,
        -placement.template.z,
      ),
    );
}

function emptyHarborStatus(): HarborStatus {
  return {
    shipPhase: 'away',
    berth: 0,
    shipCargo: 0,
    yardCargo: 0,
    freightTrucks: 0,
    delivered: 0,
    exported: 0,
    departedEmpty: 0,
    departedLoaded: 0,
    created: 0,
    activeCargo: 0,
  };
}

/** One native rendering entry: authored data selects assets, never a second simulation. */
export function createNativeWorldView(
  definition: CityWorldDefinition,
  geography?: NativeRegionGeography,
): GeneratedCity {
  if (definition.kind === 'prototype-grid') {
    return createCity(
      definition.layout,
      createLifeProfile(definition.layout),
      geography,
    );
  }

  return createAuthoredView(definition, geography);
}

function createAuthoredView(
  definition: AuthoredWorldDefinition,
  geography?: NativeRegionGeography,
): GeneratedCity {
  const group = new THREE.Group();
  const blocks = new THREE.Group();
  const objects = new Map<string, BatchObject>();
  const assemblies = new Map<string, PlacedAssembly>();
  const plots = new Map<string, ConstructionPlot>();
  const hitGeometry = new THREE.BoxGeometry(1, 1, 1);
  const owned: THREE.BufferGeometry[] = [hitGeometry];
  const hitboxes: THREE.Mesh[] = [];
  const source = generateCity(definition.seed);
  const placements = new Map<string, AuthoredPlacement[]>();
  const occupied: Array<ReturnType<typeof rectangle>> = [];
  let treeCount = 0;
  const lampPositions: THREE.Vector3[] = [];
  const chimneys: THREE.Vector3[] = [];
  const chimneyOwners: string[] = [];

  blocks.name = 'authored-blocks';
  group.add(blocks);

  const portWarehouses = new Set(
    definition.infrastructure?.ports.flatMap(port => [
      ...port.warehouseBuildingIds,
    ]) ?? [],
  );

  for (const placement of definition.placements) {
    if (portWarehouses.has(placement.id)) {
      continue;
    }

    const b = definition.layout.buildings.find(
      item => item.id === placement.id,
    );

    if (!b) {
      throw new Error(`Нет сборки для размещения ${placement.id}`);
    }

    const list = placements.get(b.blockId) ?? [];

    list.push(placement);
    placements.set(b.blockId, list);
  }

  for (const [blockId, placed] of placements) {
    const first = placed[0]!;
    const originalBlock =
      first.sourceBlock ??
      source.blocks.find(block => block.id === first.template.blockId);

    if (!originalBlock) {
      throw new Error(`Нет исходного квартала для ${blockId}`);
    }

    const layout: CityLayout = {
      seed: definition.seed,
      grid: CITY_GRID,
      blocks: [originalBlock],
      buildings: placed.map(item => item.template),
    };
    const profile = createLifeProfile(layout);
    const transform = placementMatrix(first);

    // Draw only curb bays registered in the authoritative authored profile.
    profile.bays = profile.bays.filter(bay => {
      const entrance = transformPlacement(
        profile.facilities[bay.facility]!.entrance,
        first,
      );

      return definition.profile.bays.some(actual => {
        const candidate =
          definition.profile.facilities[actual.facility]!.entrance;

        return (
          Math.hypot(candidate.x - entrance.x, candidate.z - entrance.z) < 0.001
        );
      });
    });

    const batch = new Batch();
    const index = Math.max(
      0,
      source.blocks.findIndex(block => block.id === originalBlock.id),
    );

    // Freestanding migrated houses keep their own gardens and no synthetic plaza.
    if (!placed.every(placement => placement.standalone)) {
      const block = drawNativeBlock(
        batch,
        layout,
        originalBlock,
        index,
        profile,
      );

      treeCount += block.treeCount;
      lampPositions.push(
        ...block.lampPositions.map(point =>
          point.clone().applyMatrix4(transform),
        ),
      );
    }

    for (const placement of placed) {
      const template = placement.template;
      const nativeChimneys: THREE.Vector3[] = [];
      const drawn = drawNativeBuilding(
        batch,
        template,
        definition.seed,
        profile,
        nativeChimneys,
      );
      const matrix = placementMatrix(placement);

      chimneys.push(
        ...nativeChimneys.map(point => point.clone().applyMatrix4(matrix)),
      );
      chimneyOwners.push(...nativeChimneys.map(() => placement.id));
      const plot = sourcePlot(layout, template);

      treeCount += drawn.treeCount;
      objects.set(placement.id, {
        parts: drawn.object.parts.map(part => ({
          ...part,
          matrix: matrix.clone().multiply(part.matrix),
        })),
        setVisible: visible => drawn.object.setVisible(visible),
      });
      assemblies.set(placement.id, {sourcePlot: plot, transform: matrix});
      const point = transformPlacement({x: plot.x, z: plot.z}, placement);

      plots.set(placement.id, {...plot, x: point.x, z: point.z});
      const height = buildingTop(template);
      const hitbox = new THREE.Mesh(hitGeometry, material('cream'));

      hitbox.scale.set(
        template.plot?.width ?? template.width,
        height,
        template.plot?.depth ?? template.depth,
      );
      hitbox.position.set(
        template.plot?.x ?? template.x,
        height / 2,
        template.plot?.z ?? template.z,
      );
      hitbox.updateMatrix();
      hitbox.applyMatrix4(matrix);
      hitbox.userData['building'] = definition.layout.buildings.find(
        item => item.id === placement.id,
      )!;
      hitbox.updateMatrixWorld(true);
      hitboxes.push(hitbox);
    }

    const root = new THREE.Group();

    root.name = `authored-block-${blockId}`;
    batch.finish(root);
    root.applyMatrix4(transform);
    blocks.add(root);
    const center = transformPlacement(originalBlock, first);

    occupied.push(rectangle(center, 58, 58, first.yaw));
  }

  for (const space of definition.spaces ?? []) {
    const sourceBlock = space.sourceBlock;
    const layout: CityLayout = {
      seed: definition.seed,
      grid: CITY_GRID,
      blocks: [sourceBlock],
      buildings: [],
    };
    const profile = createLifeProfile(layout);
    const placement = {...space, source: sourceBlock};
    const scalar = nativePlacementTransform(placement, sourceBlock);
    const transform = new THREE.Matrix4()
      .makeTranslation(space.center.x, 0, space.center.z)
      .multiply(new THREE.Matrix4().makeRotationY(space.yaw))
      .multiply(
        new THREE.Matrix4().makeTranslation(-sourceBlock.x, 0, -sourceBlock.z),
      );

    profile.bays = profile.bays.filter(bay => {
      const entrance = scalar.toWorld(
        profile.facilities[bay.facility]!.entrance,
      );

      return definition.profile.bays.some(actual => {
        const candidate =
          definition.profile.facilities[actual.facility]!.entrance;

        return (
          Math.hypot(candidate.x - entrance.x, candidate.z - entrance.z) < 0.001
        );
      });
    });
    const batch = new Batch();
    let count = 0;
    const captured = batch.capture(sink => {
      const drawn = drawNativeBlock(
        sink,
        layout,
        sourceBlock,
        Math.max(
          0,
          source.blocks.findIndex(block => block.id === sourceBlock.id),
        ),
        profile,
      );

      count = drawn.treeCount;
      lampPositions.push(
        ...drawn.lampPositions.map(point =>
          point.clone().applyMatrix4(transform),
        ),
      );
    });
    const root = new THREE.Group();

    root.name = `native-public-space-${space.id}`;
    batch.finish(root);
    root.applyMatrix4(transform);
    group.add(root);
    treeCount += count;
    occupied.push(rectangle(space.center, 58, 58, space.yaw));
    objects.set(space.id, {
      parts: captured.parts.map(part => ({
        ...part,
        matrix: transform.clone().multiply(part.matrix),
      })),
      setVisible: visible => captured.setVisible(visible),
    });
    const plot: ConstructionPlot = {
      x: sourceBlock.x,
      z: sourceBlock.z,
      width: 26,
      depth: 26,
      minX: sourceBlock.x - 12.75,
      maxX: sourceBlock.x + 12.75,
      minZ: sourceBlock.z - 12.75,
      maxZ: sourceBlock.z + 12.75,
    };

    assemblies.set(space.id, {sourcePlot: plot, transform});
    plots.set(space.id, {...plot, x: space.center.x, z: space.center.z});
  }

  const infrastructure = createNativeInfrastructureView(definition);

  group.add(infrastructure.group);
  lampPositions.push(...infrastructure.lampPositions);
  hitboxes.push(...infrastructure.hitboxes);

  for (const port of definition.infrastructure?.ports ?? []) {
    const transform = nativePlacementTransform(port, {x: 85, z: 135});
    const land = transform.toWorld({x: 85, z: 89});
    const quay = transform.toWorld({x: 85, z: 135});

    occupied.push(
      rectangle(land, 100, 92, port.yaw),
      rectangle(quay, 100, 48, port.yaw),
    );
  }

  for (const railway of definition.infrastructure?.railways ?? []) {
    const center = nativePlacementTransform(railway, {x: -34, z: -136}).toWorld(
      {x: -34, z: -136},
    );

    occupied.push(rectangle(center, 420, 70, railway.yaw));
  }

  const region = createNativeRegionView(
    definition.layout,
    geography ?? {
      kind: 'native-region',
      terrain: {seed: definition.seed, bounds: definition.bounds, water: []},
    },
    {preserveCity: false, occupied},
  );

  treeCount += region.treeCount;
  group.add(region.group);
  const roads = new THREE.Group();

  roads.name = 'authored-roads';

  for (const road of definition.roads) {
    if (
      definition.infrastructure?.ports.some(port =>
        road.id.startsWith(`${port.id}/road/`),
      )
    ) {
      continue;
    }

    const contour = roadContour(road.points, CITY_ROAD_WIDTH);
    const shape = new THREE.Shape(
      contour.map(point => new THREE.Vector2(point.x, -point.z)),
    );
    const geometry = new THREE.ShapeGeometry(shape);
    const mesh = new THREE.Mesh(geometry, material('asphalt'));

    owned.push(geometry);
    mesh.name = `authored-road-${road.id}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.85;
    mesh.receiveShadow = true;
    roads.add(mesh);
  }

  group.add(roads);
  const details = new THREE.Group();
  const detailBatch = new Batch();

  details.name = 'authored-road-details';
  addAuthoredRoadDetails(
    detailBatch,
    definition.roads.filter(
      road =>
        !definition.infrastructure?.ports.some(port =>
          road.id.startsWith(`${port.id}/road/`),
        ),
    ),
  );
  detailBatch.finish(details);
  group.add(details);

  const clearance = (
    id: string,
    x: number,
    z: number,
    radius: number,
  ): number => {
    let height = 0;

    for (const b of definition.layout.buildings) {
      if (b.id === id) {
        continue;
      }

      const yaw =
        definition.placements.find(placement => placement.id === b.id)?.yaw ??
        0;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const localX = c * (x - b.x) - s * (z - b.z);
      const localZ = s * (x - b.x) + c * (z - b.z);
      const dx = Math.max(0, Math.abs(localX) - b.width / 2);
      const dz = Math.max(0, Math.abs(localZ) - b.depth / 2);

      if (Math.hypot(dx, dz) < radius + 0.5) {
        height = Math.max(height, buildingTop(b));
      }
    }

    return height;
  };
  const siteFactory = (
    id: string,
    _plot: ConstructionPlot,
    height: number,
    nearby: (x: number, z: number, radius: number) => number,
  ) => {
    const assembly = assemblies.get(id)!;
    const site = createConstructionSite(
      assembly.sourcePlot,
      height,
      (x, z, radius) => {
        const point = new THREE.Vector3(x, 0, z).applyMatrix4(
          assembly.transform,
        );

        return nearby(point.x, point.z, radius);
      },
    );

    site.group.applyMatrix4(assembly.transform);
    site.group.userData['placement'] = id;

    return site;
  };
  const construction = new Construction(objects, plots, clearance, siteFactory);
  const pending = new Map<string, Construction>();

  group.add(construction.group);

  function pendingBuilding(id: string): Construction {
    let renderer = pending.get(id);

    if (!renderer) {
      renderer = new Construction(objects, plots, clearance, siteFactory);
      renderer.start(id, false);
      renderer.seek(0);
      pending.set(id, renderer);
      group.add(renderer.group);
    }

    return renderer;
  }

  for (const placement of [
    ...definition.placements,
    ...(definition.spaces ?? []),
  ]) {
    if (
      objects.has(placement.id) &&
      (placement.readyAt ?? 0) > (placement.startedAt ?? 0)
    ) {
      pendingBuilding(placement.id);
    }
  }

  const lampMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd99a,
    transparent: true,
    opacity: 0.17,
    depthWrite: false,
  });
  const lampGeometry = new THREE.CircleGeometry(3.3, 16);
  const lampPools = new THREE.InstancedMesh(
    lampGeometry,
    lampMaterial,
    lampPositions.length,
  );
  const dummy = new THREE.Object3D();

  owned.push(lampGeometry);
  lampPositions.forEach((point, index) => {
    dummy.position.copy(point);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    lampPools.setMatrixAt(index, dummy.matrix);
  });
  lampPools.name = 'native-lamp-pools';
  lampPools.visible = false;
  group.add(lampPools);
  const smokeMaterial = new THREE.MeshStandardMaterial({
    color: 0xe3e1d6,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    roughness: 1,
  });
  const smokeGeometry = new THREE.IcosahedronGeometry(1, 1);
  const smoke = new THREE.InstancedMesh(
    smokeGeometry,
    smokeMaterial,
    chimneys.length * 7,
  );

  owned.push(smokeGeometry);
  smoke.name = 'native-building-smoke';
  smoke.frustumCulled = false;
  group.add(smoke);
  let lastSeconds = 0;

  function updateSmoke(seconds: number): void {
    const status = construction.status();

    chimneys.forEach((source, index) => {
      for (let part = 0; part < 7; part++) {
        const progress =
          (((seconds * 0.13 + part / 7 + index * 0.11) % 1) + 1) % 1;

        dummy.position
          .copy(source)
          .add(new THREE.Vector3(progress * 8, progress * 16, progress * 2));
        dummy.rotation.set(progress, progress * 2, part);
        dummy.scale.setScalar(
          (1.1 + progress * 3.2) * Math.sin(progress * Math.PI),
        );

        if (
          pending.has(chimneyOwners[index]!) ||
          (status && status.id === chimneyOwners[index] && status.progress < 1)
        ) {
          dummy.scale.setScalar(0);
        }

        dummy.updateMatrix();
        smoke.setMatrixAt(index * 7 + part, dummy.matrix);
      }
    });
    smoke.instanceMatrix.needsUpdate = true;
  }

  updateSmoke(0);
  let harbor = emptyHarborStatus();

  return {
    group,
    hitboxes,
    railwayTargets: infrastructure.targets,
    treeCount,
    peopleCount: 0,
    construction,
    harborStatus: () => harbor,
    update(seconds) {
      lastSeconds = seconds;
      updateSmoke(seconds);
    },
    updateConstruction(seconds) {
      construction.advance(seconds);
      updateSmoke(lastSeconds);
    },
    applyLife(frame) {
      lastSeconds = frame.seconds;
      harbor = frame.harborStatus;
      infrastructure.update(frame, frame.seconds);

      for (const [id, progress] of Object.entries(frame.construction ?? {})) {
        if (progress < 1) {
          pendingBuilding(id).seek(progress);
        } else {
          const renderer = pending.get(id);

          if (renderer) {
            renderer.clear();
            renderer.dispose();
            group.remove(renderer.group);
            pending.delete(id);
          }
        }
      }

      updateSmoke(frame.seconds);
    },
    setNight(night) {
      lampPools.visible = night;
      construction.syncLighting();
      infrastructure.setNight();

      for (const renderer of pending.values()) {
        renderer.syncLighting();
      }
    },
    dispose() {
      construction.dispose();

      for (const renderer of pending.values()) {
        renderer.dispose();
      }

      pending.clear();
      region.dispose();
      infrastructure.dispose();
      lampMaterial.dispose();
      smokeMaterial.dispose();
      group.traverse(object => {
        if (object instanceof THREE.InstancedMesh) {
          object.dispose();
        }
      });

      for (const geometry of owned) {
        geometry.dispose();
      }
    },
  };
}
