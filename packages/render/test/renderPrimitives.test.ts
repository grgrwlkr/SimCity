// Port of crates/simcity_sim/src/game/render_primitives.rs (mod tests, mod composite_tests): the shared material and
// mesh caches that keep instancing batched. A cached value is returned as the same object, the way Bevy returned the
// same handle.
import { describe, expect, it } from 'vitest';
import { IDENTITY_UV } from '../src/atlas';
import { RenderPrimitives } from '../src/renderPrimitives';

describe('render primitives', () => {
  /** Asphalt and grass of the same colour are different surfaces, and one material cannot carry two UV transforms. */
  it('materialCacheKeysOnTheAtlasCellToo', () => {
    const p = new RenderPrimitives();
    const grey = [0.4, 0.4, 0.4] as const;
    const plain = p.material(grey);
    const asphalt = p.materialIn(grey, 'Asphalt', 1);
    const sidewalk = p.materialIn(grey, 'Sidewalk', 1);

    expect(plain, 'a textured surface is not the flat one').not.toBe(asphalt);
    expect(asphalt, 'two cells must not share a material').not.toBe(sidewalk);
    expect(p.materialIn(grey, 'Asphalt', 1), 'the same surface must still share one material').toBe(asphalt);
    expect(p.cacheLen()).toBe(3);
  });

  /** A mesh carrying its own atlas UVs gets the atlas bound and untransformed. */
  it('vertexMappedMaterialsAreTheirOwnThing', () => {
    const p = new RenderPrimitives();
    const white = [1, 1, 1] as const;
    const flat = p.material(white);
    const mapped = p.materialVertexMapped(white);
    const celled = p.materialIn(white, 'Facade', 1);

    expect(mapped).not.toBe(flat);
    expect(mapped).not.toBe(celled);
    expect(p.materialVertexMapped(white)).toBe(mapped);
    expect(mapped.atlas, 'the atlas must be bound').toBe(true);
    expect(mapped.uv, 'the vertices already chose the cell; the material must not move them').toEqual(IDENTITY_UV);
  });

  /** `material` is `materialIn` with the flat cell: the untextured callers keep their look. */
  it('thePlainCellIsWhatTheOldCallGives', () => {
    const p = new RenderPrimitives();
    const color = [0.3, 0.6, 0.2] as const;
    expect(p.material(color)).toBe(p.materialIn(color, 'Plain', 1));
    expect(p.material(color).atlas, 'a flat material binds no texture').toBe(false);
  });

  /** A road quad over several tiles repeats the grain instead of stretching it. */
  it('theRepeatCountIsPartOfTheKey', () => {
    const p = new RenderPrimitives();
    const grey = [0.4, 0.4, 0.4] as const;
    expect(p.materialIn(grey, 'Asphalt', 1)).not.toBe(p.materialIn(grey, 'Asphalt', 3));
  });

  /** Same colour, same shared material: the batching contract. */
  it('materialCacheDedupsSameColor', () => {
    const p = new RenderPrimitives();
    expect(p.material([0.2, 0.4, 0.6])).toBe(p.material([0.2, 0.4, 0.6]));
    expect(p.cacheLen()).toBe(1);
  });

  /** Sub-quantum colour differences collapse into one material, so the cache stays bounded. */
  it('materialCacheQuantizesToU8', () => {
    const p = new RenderPrimitives();
    expect(p.material([0.5, 0.5, 0.5])).toBe(p.material([0.5001, 0.5, 0.5]));
  });

  /** Alpha takes part in the key and switches the blend mode. */
  it('translucentGetsOwnBlendMaterial', () => {
    const p = new RenderPrimitives();
    const opaque = p.material([0.1, 0.1, 0.1]);
    const translucent = p.material([0.1, 0.1, 0.1, 0.5]);
    expect(opaque).not.toBe(translucent);
    expect(translucent.blend).toBe(true);
    expect(opaque.blend).toBe(false);
  });

  /** One car mesh per footprint, one meeple mesh per outfit: the instancing pins. */
  it('carAndMeepleCachesDedup', () => {
    const p = new RenderPrimitives();
    expect(p.carMesh(22.4, 11.2)).toBe(p.carMesh(22.4, 11.2));
    const m1 = p.meepleMesh([0.95, 0.55, 0.1]);
    expect(p.meepleMesh([0.95, 0.55, 0.1])).toBe(m1);
    expect(p.meepleMesh([0.25, 0.45, 0.8])).not.toBe(m1);
  });
});
