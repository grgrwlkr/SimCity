import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {generateTerrain} from '../src/region/model/terrain';
import {
  containsPoint,
  pointInPolygon,
  polygonsOverlap,
} from '../src/region/model/geometry';
import {createRegion} from '../src/region/model/world';
import {applyAction} from '../src/region/model/commands';
import {TerrainView} from '../src/region/view/terrainView';
import {disposeLayer} from '../src/region/view/resources';
import type {Point} from '../src/region/model/types';

function crossSection(polygon: readonly Point[], z: number): number[] {
  return polygon
    .flatMap((start, index) => {
      const end = polygon[(index + 1) % polygon.length]!;

      return start.z > z !== end.z > z
        ? [start.x + ((z - start.z) * (end.x - start.x)) / (end.z - start.z)]
        : [];
    })
    .sort((a, b) => a - b);
}

describe('regional river', () => {
  it('clears civic reserve trees when founding and restores them after removal', () => {
    const state = createRegion('forest', '689856');
    const view = new TerrainView(state);
    const forest = view.group.getObjectByName('vegetation')!;

    view.setDetail({x: 0, z: 0}, 10_000);
    view.group.updateMatrixWorld(true);
    const trees = forest.children.find(
      (child): child is THREE.InstancedMesh =>
        child instanceof THREE.InstancedMesh,
    )!;
    const matrix = new THREE.Matrix4();

    trees.getMatrixAt(0, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    const center = {x: position.x, z: position.z};
    const ray = new THREE.Raycaster(
      new THREE.Vector3(center.x, 100, center.z),
      new THREE.Vector3(0, -1, 0),
    );

    expect(ray.intersectObject(forest, true).length).toBeGreaterThan(0);
    view.update({
      ...state,
      settlements: [
        {
          id: 'town',
          name: 'Town',
          center,
          townHall: {roadId: 'access', heading: Math.PI / 3},
        },
      ],
    });
    expect(ray.intersectObject(forest, true)).toHaveLength(0);
    view.update(state);
    expect(ray.intersectObject(forest, true).length).toBeGreaterThan(0);
    disposeLayer(view.group);
  });

  it.each(['689856', 'region-a', 'river-b', '0', 'mountains'])(
    'connects both region edges through the lake for seed %s',
    seed => {
      const terrain = generateTerrain(seed, 4000);
      const river = terrain.water.find(
        polygon =>
          polygon.some(point => point.z === -2000) &&
          polygon.some(point => point.z === 2000),
      );

      expect(river).toBeDefined();
      expect(river!.every(point => containsPoint(terrain.bounds, point))).toBe(
        true,
      );
      expect(polygonsOverlap(river!, terrain.water[0]!)).toBe(true);
      const centers: number[] = [];

      for (let z = -1999; z < 2000; z += 25) {
        const crossings = crossSection(river!, z);

        expect(crossings).toHaveLength(2);
        expect(crossings[1]! - crossings[0]!).toBeGreaterThan(50);
        centers.push((crossings[0]! + crossings[1]!) / 2);
      }

      expect(Math.max(...centers) - Math.min(...centers)).toBeGreaterThan(100);
      expect(generateTerrain(seed, 4000)).toEqual(terrain);
    },
  );

  it('preserves the existing seeded lake', () => {
    const lake = generateTerrain('689856', 4000).water[0]!;

    expect(lake).toHaveLength(24);
    expect([lake[0], lake[6], lake[12], lake[18]]).toEqual([
      {x: 1579.4, z: -176.83},
      {x: 923.37, z: 836.7},
      {x: 267.34, z: -176.83},
      {x: 923.37, z: -1190.37},
    ]);
  });

  it('rejects roads crossing the river outside the lake', () => {
    const state = createRegion('river-road', '689856');
    const points = [
      {x: -1900, z: -1700},
      {x: 1900, z: -1700},
    ];

    expect(
      points.every(
        point =>
          !state.terrain.water.some(polygon => pointInPolygon(point, polygon)),
      ),
    ).toBe(true);
    expect(applyAction(state, {type: 'road', points}, state.revision)).toEqual({
      ok: false,
      state,
      reason: 'water',
    });
  });

  it('keeps the terrain and shoreline inside region boundaries', () => {
    const state = createRegion('river-view', '689856');
    const view = new TerrainView(state);
    const bounds = new THREE.Box3().setFromObject(view.group);

    expect(bounds.min.x).toBeGreaterThanOrEqual(-2000);
    expect(bounds.max.x).toBeLessThanOrEqual(2000);
    expect(bounds.min.z).toBeGreaterThanOrEqual(-2000);
    expect(bounds.max.z).toBeLessThanOrEqual(2000);
    disposeLayer(view.group);
  });
});
