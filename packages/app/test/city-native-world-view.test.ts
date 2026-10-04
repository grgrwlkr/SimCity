import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {createNativeWorldView} from '../src/city/nativeWorldView';
import {
  createAuthoredDefinition,
  createPrototypeDefinition,
} from '../src/city/life/definition';
import type {AuthoredPlacement} from '../src/city/life/definition';
import {generateCity} from '../src/city/generator';
import {createCity, drawNativeBuilding} from '../src/city/model';
import {createLifeProfile} from '../src/city/life/network';
import {drawNativeBlock} from '../src/city/blockModules';
import {Batch} from '../src/city/primitives';
import {CITY_GRID} from '../src/city/cityGrid';
import {CityLife} from '../src/city/life/world';
import {createConstructionSite} from '../src/city/constructionSite';
import {buildingTop} from '../src/city/buildingModules';
import type {CityLayout, District} from '../src/city/generator';

function blockDefinition(district: District, yaw: number, pending = false) {
  const source = generateCity('689856');
  const block = source.blocks.find(
    item =>
      item.district === district &&
      source.buildings.some(
        building =>
          building.blockId === item.id &&
          (district !== 'residential' || building.plot) &&
          (district !== 'industrial' || building.variant === 'power'),
      ),
  )!;
  const templates = source.buildings.filter(item => item.blockId === block.id);
  const center = {x: -600, z: 450};
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const move = (point: {x: number; z: number}) => ({
    x: center.x + (point.x - block.x) * c + (point.z - block.z) * s,
    z: center.z - (point.x - block.x) * s + (point.z - block.z) * c,
  });
  const placements: AuthoredPlacement[] = templates.map((template, index) => ({
    id: `placed-${index}`,
    municipalityId: 'town',
    template,
    sourceBlock: block,
    center: move(template),
    yaw,
    kind: district === 'industrial' ? 'factory' : 'home',
    ...(pending ? {startedAt: 0, readyAt: 60} : {}),
  }));
  const corners = [
    {x: block.x - 17, z: block.z - 17},
    {x: block.x + 17, z: block.z - 17},
    {x: block.x + 17, z: block.z + 17},
    {x: block.x - 17, z: block.z + 17},
  ];
  const roads = corners.map((point, index) => ({
    id: `road-${index}`,
    points: [move(point), move(corners[(index + 1) % 4]!)],
  }));
  const definition = createAuthoredDefinition({
    seed: source.seed,
    roads,
    placements,
  });

  return {definition, source, block, templates};
}

function meshes(
  group: THREE.Object3D,
): Array<{matrices: number[]; dispose: () => void}> {
  const found: Array<{matrices: number[]; dispose: () => void}> = [];

  group.traverse(object => {
    if (object instanceof THREE.InstancedMesh) {
      found.push({
        matrices: Array.from(object.instanceMatrix.array),
        dispose: () => object.dispose(),
      });
    }
  });

  return found;
}

describe('native authored world view', () => {
  it('does not manufacture prototype infrastructure or actors in an empty authored world', () => {
    const definition = createAuthoredDefinition({seed: 'empty'});
    const view = createNativeWorldView(definition);

    expect(view.group.getObjectByName('working-harbor')).toBeUndefined();
    expect(view.group.getObjectByName('railway')).toBeUndefined();
    expect(view.hitboxes).toHaveLength(0);
    expect(view.railwayTargets).toHaveLength(0);
    expect(view.peopleCount).toBe(0);
    expect(view.harborStatus().activeCargo).toBe(0);
    const region = view.group.getObjectByName('native-region-geography');

    expect(region).toBeDefined();
    const bounds = new THREE.Box3().setFromObject(region!);

    expect(bounds.min.x).toBe(-2000);
    expect(bounds.max.x).toBe(2000);
    view.dispose();
  });

  it('delegates a prototype definition to the unchanged native scene', () => {
    const definition = createPrototypeDefinition('689856');
    const actual = createNativeWorldView(definition);
    const original = createCity(
      definition.layout,
      createLifeProfile(definition.layout),
    );
    const a = meshes(actual.group);
    const b = meshes(original.group);

    expect(a).toHaveLength(b.length);

    for (const [index, mesh] of a.entries()) {
      expect(mesh.matrices).toEqual(b[index]!.matrices);
    }

    expect(actual.treeCount).toBe(original.treeCount);
    expect(actual.hitboxes).toHaveLength(original.hitboxes.length);
    actual.dispose();
    original.dispose();
  });

  it('moves a complete native house block with one rigid transform and no rescaling', () => {
    const yaw = 0.61;
    const {definition, source, block, templates} = blockDefinition(
      'residential',
      yaw,
    );
    const actual = createNativeWorldView(definition);
    const assembly = actual.group.getObjectByName('authored-blocks')!;
    const placed = assembly.children[0]!;
    const layout: CityLayout = {
      seed: source.seed,
      grid: CITY_GRID,
      blocks: [block],
      buildings: templates,
    };
    const profile = createLifeProfile(layout);
    const batch = new Batch();

    drawNativeBlock(
      batch,
      layout,
      block,
      source.blocks.indexOf(block),
      profile,
    );

    for (const template of templates) {
      drawNativeBuilding(batch, template, source.seed, profile);
    }

    const expected = new THREE.Group();

    batch.finish(expected);
    expect(assembly.children).toHaveLength(1);
    expect(placed.scale.toArray()).toEqual([1, 1, 1]);
    const a = meshes(placed);
    const b = meshes(expected);

    expect(a).toHaveLength(b.length);

    for (const [index, mesh] of a.entries()) {
      expect(mesh.matrices).toEqual(b[index]!.matrices);
    }

    expect(actual.hitboxes).toHaveLength(templates.length);

    for (const [index, hitbox] of actual.hitboxes.entries()) {
      expect(hitbox.rotation.y).toBeCloseTo(yaw);
      expect(hitbox.userData['building']).toBe(
        definition.layout.buildings[index],
      );
    }

    expect(actual.group.getObjectByName('working-harbor')).toBeUndefined();
    actual.dispose();

    for (const mesh of b) {
      mesh.dispose();
    }
  });

  it('uses physical native frame progress for multiple rotated construction sites', () => {
    const {definition} = blockDefinition('residential', 0.61, true);
    const life = CityLife.fromDefinition(definition, {initialFamilies: 0});
    const view = createNativeWorldView(definition);

    view.applyLife(life.frame());
    const sites: THREE.Object3D[] = [];

    view.group.traverse(object => {
      if (object.name === 'construction-site') {
        sites.push(object);
      }
    });

    expect(sites).toHaveLength(definition.placements.length);

    for (const site of sites) {
      const placement = definition.placements.find(
        item => item.id === site.userData['placement'],
      )!;
      const b = placement.template;
      const p = b.plot!;
      const original = createConstructionSite(
        {
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
        },
        buildingTop(b),
        () => 0,
      );

      original.group.updateMatrix();
      const matrix = new THREE.Matrix4()
        .makeTranslation(placement.center.x, 0, placement.center.z)
        .multiply(new THREE.Matrix4().makeRotationY(placement.yaw))
        .multiply(new THREE.Matrix4().makeTranslation(-b.x, 0, -b.z))
        .multiply(original.group.matrix);

      site.updateMatrix();

      for (const [index, value] of site.matrix.elements.entries()) {
        expect(value).toBeCloseTo(matrix.elements[index]!, 10);
      }

      for (const scale of site.scale.toArray()) {
        expect(scale).toBeCloseTo(1, 12);
      }
    }

    life.advance(30);
    view.applyLife(life.frame());
    expect(
      Object.values(life.frame().construction ?? {}).every(
        progress => progress === 0.5,
      ),
    ).toBe(true);
    life.advance(30);
    view.applyLife(life.frame());
    const remaining: string[] = [];

    view.group.traverse(object => {
      if (object.name === 'construction-site') {
        remaining.push(object.name);
      }
    });

    expect(remaining).toHaveLength(0);
    view.dispose();
  });

  it('retains native industrial smoke and night lamp pools on authored assemblies', () => {
    const {definition} = blockDefinition('industrial', -0.43);
    const view = createNativeWorldView(definition);
    const smoke = view.group.getObjectByName('native-building-smoke');
    const lamps = view.group.getObjectByName('native-lamp-pools');

    expect(smoke).toBeInstanceOf(THREE.InstancedMesh);

    if (!(smoke instanceof THREE.InstancedMesh)) {
      throw new Error('Missing native smoke');
    }

    expect(smoke.count).toBeGreaterThan(0);
    const before = Array.from(smoke.instanceMatrix.array);

    view.update(5);
    expect(Array.from(smoke.instanceMatrix.array)).not.toEqual(before);
    expect(lamps!.visible).toBe(false);
    view.setNight(true);
    expect(lamps!.visible).toBe(true);
    view.dispose();
  });
});
