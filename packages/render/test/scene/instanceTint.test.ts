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

  it('aTintGivenBeforeTheBufferGrowsSurvivesTheGrowth', () => {
    // Review F15: only the edited tiles are re-tinted, so the colours of every other instance ride the grown buffer.
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial(), 'buildings', 2);
    for (const owner of [5, 7]) batch.put(owner, at);
    batch.tintOwner(5, [1, 0, 0]);
    batch.tintOwner(7, [0, 0.5, 0]);
    batch.put(9, at); // grows the buffer
    batch.flush();
    expect([5, 7, 9].map((o) => batch.tintOf(o))).toEqual([[1, 0, 0], [0, 0.5, 0], [1, 1, 1]]);
  });

  it('aTintReachesTheGpuThroughTheColourBuffersVersion', () => {
    // Review F12/N09: a colour written without `needsUpdate` stays on the CPU until some later edit uploads it.
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial(), 'buildings', 4);
    batch.put(3, at);
    batch.flush();
    const colours = () => batch.drawn.instanceColor!.version;
    let before = colours();
    batch.tint(() => [1, 0, 0]);
    expect(colours(), 'tint over every instance').toBeGreaterThan(before);
    before = colours();
    batch.tintOwner(3, [0, 1, 0]);
    expect(colours(), 'tint of one owner').toBeGreaterThan(before);
  });

  it('aFlushUploadsOnlyTheSlotsThatMovedNotTheWholeBuffer', () => {
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial(), 'windows', 8);
    const ranges = () => [batch.drawn.instanceMatrix.updateRanges.map((r) => [r.start, r.count]), batch.drawn.instanceColor!.updateRanges.map((r) => [r.start, r.count])];
    // What the renderer does once it has uploaded the ranges.
    const upload = () => [batch.drawn.instanceMatrix, batch.drawn.instanceColor!].forEach((a) => a.clearUpdateRanges());
    for (const owner of [1, 2, 3]) batch.put(owner, at);
    batch.flush();
    expect(ranges(), 'a new buffer goes up whole').toEqual([[[0, 3 * 16]], [[0, 3 * 3]]]);
    upload();
    batch.put(4, at);
    batch.put(5, at);
    batch.flush();
    expect(ranges(), 'two appended: the tail from slot 3 on').toEqual([[[3 * 16, 2 * 16]], [[3 * 3, 2 * 3]]]);
    // A second edit before the frame keeps the first one's range.
    batch.remove(2);
    batch.flush();
    expect(ranges(), 'the last instance moved into slot 1').toEqual([[[3 * 16, 2 * 16], [16, 3 * 16]], [[3 * 3, 2 * 3], [3, 3 * 3]]]);
    upload();
    // A tint rewrites every colour; a flush after it before the frame adds to it, it does not narrow it.
    batch.tint(() => [1, 0, 0]);
    batch.put(6, at);
    batch.flush();
    expect(ranges()).toEqual([[[4 * 16, 16]], [[0, 4 * 3], [4 * 3, 3]]]);
  });
});
