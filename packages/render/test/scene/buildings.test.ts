// Ports of the scene tests of crates/simcity_sim/src/game/buildings/visual.rs (tag rust-final): the shared mesh cache,
// the roof glyph, the decay tint and the atlas tiling of a building body. Bevy handles become object identity here.
import { describe, expect, it } from 'vitest';
import type { BuildingKind, BuildingProfile } from '@simcity/sim';
import { uvIn } from '../../src/atlas';
import { RenderPrimitives } from '../../src/renderPrimitives';
import { BuildingVisuals, atlasRepeats, buildingBodyMesh } from '../../src/scene/buildings';

const TILE = 16;
const MEDIUM: BuildingProfile = { density: 'Medium', class: 'Middle' };
/** `spawn_building` of the Rust tests: a 2×2 footprint at (2, 2). */
const shape = (kind: BuildingKind, level: number) => ({ kind, level, width: 2, length: 2, profile: MEDIUM });
const visuals = () => new BuildingVisuals(new RenderPrimitives(), TILE);
const cfg = { worldUnitsPerCell: 12, maxRepeats: 4 };

describe('building visuals', () => {
  it('meshCacheDedupsSameShape', () => {
    const v = visuals();
    const a = v.set(1, shape('Residential', 1));
    const b = v.set(2, shape('Residential', 1));
    const c = v.set(3, shape('Residential', 3));
    expect(a.body, 'same shape shares one mesh').toBe(b.body);
    expect(a.body, 'level 3 is a different (taller) mesh').not.toBe(c.body);
  });

  it('serviceBuildingGetsRoofGlyph', () => {
    const v = visuals();
    const hospital = v.set(1, shape('Hospital', 1));
    expect(hospital.body, 'exactly one body mesh').toBeDefined();
    expect(hospital.glyph.length, 'hospital must also carry glyph pieces').toBeGreaterThan(0);
    expect(hospital.glyphZ).toBeGreaterThan(0);
    expect(v.set(2, shape('Residential', 1)).glyph).toHaveLength(0);
  });

  it('tintAppliesAndClears', () => {
    const v = visuals();
    const white = v.set(1, shape('Residential', 1)).material;
    const tinted = v.setTint(1, [1, 0.3, 0.3]).material;
    expect(tinted, 'tint must swap the body material').not.toBe(white);
    expect(v.setTint(1, null).material, 'removal restores the base material').toBe(white);
  });

  it('repeatsFollowTheSurfaceSizeAndStayWithinTheCap', () => {
    // Anything shorter than one cell still gets a single repeat.
    expect(atlasRepeats(0, cfg)).toBe(1);
    expect(atlasRepeats(6, cfg)).toBe(1);
    // Two cells' worth of wall gets two repeats.
    expect(atlasRepeats(24, cfg)).toBe(2);
    // Far past the cap the count is clamped, not unbounded.
    expect(atlasRepeats(1000, cfg)).toBe(4);
  });

  it('roofGravelTilesInsteadOfStretchingOverTheWholeRoof', () => {
    // 46×46 roof: 46 / 12 rounds to 4 repeats each way, so 16 sub-quads.
    const mesh = buildingBodyMesh(46, 46, 36, [1, 1, 1], cfg);
    const [loU, loV] = uvIn('RoofGravel', 0, 0);
    const [hiU, hiV] = uvIn('RoofGravel', 1, 1);
    const roof: Array<[number, number]> = [];
    for (let i = 0; i < mesh.uvs.length; i += 2) {
      const u = mesh.uvs[i]!;
      const v = mesh.uvs[i + 1]!;
      if (u >= Math.fround(loU) && u <= Math.fround(hiU) && v >= Math.fround(loV) && v <= Math.fround(hiV)) roof.push([u, v]);
    }
    expect(roof, 'roof should be tiled, not one quad').toHaveLength(4 * 4 * 4);
    const corners = roof.filter(([u, v]) => u === Math.fround(hiU) && v === Math.fround(hiV)).length;
    expect(corners, "each sub-quad must reach the cell's far corner").toBe(16);
  });

  it('batches follow the shapes, not the number of buildings', () => {
    const few = visuals();
    const many = visuals();
    const kinds: BuildingKind[] = ['Residential', 'Commercial', 'Industrial', 'Hospital'];
    for (let id = 1; id <= 8; id++) few.set(id, shape(kinds[id % kinds.length]!, 1));
    for (let id = 1; id <= 4000; id++) many.set(id, shape(kinds[id % kinds.length]!, 1));
    expect(many.batches().length).toBe(few.batches().length);
    expect(many.batches().reduce((n, b) => n + b.ids.length, 0)).toBe(4000);
  });
});
