// Buildings under a data map (review F4): a built-up city covers most zoned tiles with rooftops, so a data map tints each
// building instance with its tile's map colour and gives the plain colour back when the map closes. The tint rides the
// instance through the edits that move instances between slots.
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { MapLayersReply } from '@simcity/bridge';
import { RenderPrimitives, type CompositeMesh } from '../../src/renderPrimitives';
import { SceneMaterials, createAtlasTexture } from '../../src/scene/atlasNode';
import { InstanceBatch } from '../../src/scene/instanceBatch';
import { MapInstances } from '../../src/scene/mapInstances';

const at = new THREE.Matrix4();

describe('instance tint', () => {
  it('aDataMapTintsEachInstanceByItsOwnerAndTheTintFollowsItThroughEdits', () => {
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial(), 'buildings', 2);
    for (const owner of [5, 7, 9]) batch.put(owner, at); // the third grows the buffer
    batch.tint((owner) => (owner === 7 ? [1, 0, 0] : owner === 9 ? [0, 0.5, 0] : null));
    batch.flush();
    expect([5, 7, 9].map((o) => batch.tintOf(o))).toEqual([[1, 1, 1], [1, 0, 0], [0, 0.5, 0]]);
    expect(batch.drawn.instanceColor, 'the instances carry a colour attribute').not.toBeNull();

    // An edit moves the last instance into the freed slot: its tint moves with it, and a new instance starts plain.
    batch.remove(5);
    batch.put(11, at);
    batch.flush();
    expect([7, 9, 11].map((o) => batch.tintOf(o))).toEqual([[1, 0, 0], [0, 0.5, 0], [1, 1, 1]]);
    expect(batch.tintOf(5), 'gone').toBeNull();

    // The map closes: every instance plain again.
    batch.tint(null);
    expect([7, 9, 11].map((o) => batch.tintOf(o))).toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  });

  it('underADataMapTheBodiesDrawWhiteSoTheTintIsTheMapsColourNotAShadeOfTheRoof', () => {
    // A blue roof times a yellow map is black: the body swaps to a white material while the map is open.
    const own = new THREE.MeshBasicNodeMaterial();
    const white = new THREE.MeshBasicNodeMaterial();
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), own, 'buildings', 1);
    batch.put(3, at);
    batch.useMaterial(white);
    batch.put(4, at); // grows the buffer: the new mesh keeps the swap
    expect(batch.drawn.material).toBe(white);
    batch.useMaterial(null);
    expect(batch.drawn.material, 'its own material back').toBe(own);
  });

  it('aTintedBodyIgnoresItsGeometrysVertexColoursSoABlueRoofTakesTheMapsColourNotBlack', () => {
    // Review F4, measured on the metropolis: a white material that still reads the geometry's vertex colours multiplies
    // a blue roof by a yellow map into black. The tint material draws white lit by the scene, times the instance colour
    // and nothing else; closing the map gives every batch its own material, vertex colours and all.
    const size = 8;
    const layer = () => new Uint8Array(size * size);
    const layers = { water: layer(), roadKind: layer(), roadDir: layer(), zone: layer(), building: layer() };
    for (let i = 0; i < size * size; i++) {
      if (i % size === 0) layers.roadKind[i] = layers.roadDir[i] = 1;
      else [layers.zone[i], layers.building[i]] = [1 + (i % 3), [1, 2, 3, 4, 6][i % 5]!];
    }
    const map: MapLayersReply = { width: size, height: size, tileSize: 16, mapEditVersion: 1, graphVersion: 1, mapSeed: '0', layers };
    const geometries = new Map<CompositeMesh, THREE.BufferGeometry>();
    const geometryOf = (mesh: CompositeMesh) => geometries.get(mesh) ?? geometries.set(mesh, new THREE.BufferGeometry()).get(mesh)!;
    const instances = new MapInstances(new RenderPrimitives(), new SceneMaterials(createAtlasTexture()), geometryOf);
    instances.apply(map, [0], true);
    const batches = instances.buildingBatches();
    expect(batches.length, 'the city has buildings').toBeGreaterThan(0);
    const own = batches.map((b) => b.drawn.material);

    instances.tintBuildings(() => [1, 1, 0]);
    for (const b of batches) {
      const m = b.drawn.material as THREE.MeshLambertNodeMaterial;
      expect(m, `${b.drawn.name} lit like the rest of the scene`).toBeInstanceOf(THREE.MeshLambertNodeMaterial);
      expect(m.vertexColors, `${b.drawn.name} reads no vertex colour`).toBe(false);
      expect(m.color.getHex(), `${b.drawn.name} white`).toBe(0xffffff);
      expect(m.colorNode, `${b.drawn.name} no atlas shading on top`).toBeNull();
    }

    instances.tintBuildings(null);
    expect(batches.map((b) => b.drawn.material)).toEqual(own);
  });
});
