// One three.js material per `MaterialSpec`: a cache that handed out a new material on every call would keep the draw
// calls the same and quietly compile a shader per mesh.
import { describe, expect, it } from 'vitest';
import { RenderPrimitives } from '../../src/renderPrimitives';
import { SceneMaterials, createAtlasTexture } from '../../src/scene/atlasNode';

describe('scene materials', () => {
  it('makes one material per spec and another for another spec', () => {
    const prims = new RenderPrimitives();
    const materials = new SceneMaterials(createAtlasTexture());
    const white = materials.get(prims.materialVertexMapped([1, 1, 1]));
    expect(materials.get(prims.materialVertexMapped([1, 1, 1]))).toBe(white);
    const red = materials.get(prims.materialVertexMapped([1, 0.3, 0.3]));
    expect(red).not.toBe(white);
    expect(materials.get(prims.material([1, 1, 1]))).not.toBe(white);
    expect(materials.size).toBe(3);
  });
});
