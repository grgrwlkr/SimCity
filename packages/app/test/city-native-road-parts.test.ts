import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {createNativeWorldView} from '../src/city/nativeWorldView';
import {material} from '../src/city/primitives';
import type {Batch} from '../src/city/primitives';
import {addStreetCrossings, streetCrossings} from '../src/city/streetCrossings';
import {addNativeCrosswalk} from '../src/city/nativeRoadParts';

function markingMatrices(
  group: THREE.Object3D,
  color: string,
): THREE.Matrix4[] {
  const result: THREE.Matrix4[] = [];

  group.traverse(object => {
    if (
      object instanceof THREE.InstancedMesh &&
      object.material === material(color)
    ) {
      for (let index = 0; index < object.count; index++) {
        const matrix = new THREE.Matrix4();

        object.getMatrixAt(index, matrix);
        result.push(matrix);
      }
    }
  });

  return result;
}

describe('native street detail geometry in authored worlds', () => {
  it.each([false, true])(
    'keeps source crossing part order and dimensions exact with arrival %s',
    arrival => {
      const expected: Array<Parameters<Batch['add']>> = [];
      const actual: Array<Parameters<Batch['add']>> = [];

      addStreetCrossings({add: (...part) => expected.push(part)}, arrival);

      for (const crossing of streetCrossings(arrival)) {
        addNativeCrosswalk(
          {add: (...part) => actual.push(part)},
          crossing,
          crossing.axis === 'x' ? {x: 0, z: 1} : {x: 1, z: 0},
        );
      }

      expect(actual).toEqual(expected);
    },
  );

  it.each([0, 0.63])(
    'renders original dashed lines and four zebra approaches at yaw %s',
    yaw => {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const point = (x: number, z: number) => ({
        x: c * x + s * z,
        z: -s * x + c * z,
      });
      const definition = createAuthoredDefinition({
        seed: '689856',
        roads: [
          {id: 'east-west', points: [point(-24, 0), point(24, 0)]},
          {id: 'north-south', points: [point(0, -24), point(0, 24)]},
        ],
      });
      const view = createNativeWorldView(definition);
      const dashes = markingMatrices(view.group, 'cream');
      const zebra = markingMatrices(view.group, 'white');

      expect(dashes).toHaveLength(16);
      expect(zebra).toHaveLength(40);

      for (const dash of dashes) {
        const p = new THREE.Vector3().setFromMatrixPosition(dash);
        const scale = new THREE.Vector3().setFromMatrixScale(dash);

        expect(p.y).toBeCloseTo(0.865, 6);
        expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(5);
        expect([scale.x, scale.z].sort((a, b) => a - b)[0]).toBeCloseTo(
          0.13,
          6,
        );
        expect([scale.x, scale.z].sort((a, b) => a - b)[1]).toBeCloseTo(1.7, 6);
        expect(scale.y).toBeCloseTo(0.015, 6);
      }

      for (const stripe of zebra) {
        const p = new THREE.Vector3().setFromMatrixPosition(stripe);
        const scale = new THREE.Vector3().setFromMatrixScale(stripe);

        expect(p.y).toBeCloseTo(0.874, 6);
        expect(scale.y).toBeCloseTo(0.02, 6);
      }

      view.dispose();
    },
  );

  it('does not manufacture zebra junctions on an isolated straight authored street', () => {
    const definition = createAuthoredDefinition({
      seed: '689856',
      roads: [
        {
          id: 'isolated',
          points: [
            {x: -24, z: 0},
            {x: 24, z: 0},
          ],
        },
      ],
    });
    const view = createNativeWorldView(definition);

    expect(markingMatrices(view.group, 'cream').length).toBeGreaterThan(0);
    expect(markingMatrices(view.group, 'white')).toHaveLength(0);
    view.dispose();
  });

  it('keeps a bend of one road distinct from a junction of connected streets', () => {
    const definition = createAuthoredDefinition({
      seed: '689856',
      roads: [
        {
          id: 'bent-street',
          points: [
            {x: -24, z: 0},
            {x: 0, z: 0},
            {x: 0, z: 24},
          ],
        },
      ],
    });
    const view = createNativeWorldView(definition);

    expect(markingMatrices(view.group, 'white')).toHaveLength(0);
    view.dispose();
  });
});
