// The scene's ground under a data map: each tile takes the map's colour over its own, in linear light for the lit
// material, and a repaint in place leaves the geometry alone.
import { renderLayersOf } from '@simcity/bridge';
import { MapGrid } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { dataMapInputs, dataMapPaint, pollutionColor } from '../../src/dataMap';
import { buildGroundArea, groundColors } from '../../src/scene/ground';

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

describe('scene ground', () => {
  it('aDataMapTintsTheGroundInLinearLightAndRepaintsInPlace', () => {
    const map = renderLayersOf(new MapGrid(4, 4), { width: 4, height: 4, tileSize: 16 }, 1, 1, 0n);
    const area = { x0: 0, y0: 0, x1: 4, y1: 4 };
    const pollution = new Float32Array(16).fill(0.75);
    const paint = dataMapPaint('Pollution', dataMapInputs(map, { pollution }));
    const plain = buildGroundArea(map, area);
    const painted = buildGroundArea(map, area, paint);
    const [r, g, b] = pollutionColor(0.75);
    const got = Array.from(painted.colors.subarray(0, 3));
    [lin(r), lin(g), lin(b)].forEach((want, i) => expect(got[i]).toBeCloseTo(want, 6));
    expect(Array.from(painted.positions)).toEqual(Array.from(plain.positions));
    const colors = plain.colors.slice();
    groundColors(map, area, colors, paint);
    expect(Array.from(colors)).toEqual(Array.from(painted.colors));
    groundColors(map, area, colors, null);
    expect(Array.from(colors)).toEqual(Array.from(plain.colors));
  });
});
