import type { Batch } from './primitives';
import type { CityBuilding } from './generator';

type Sink = Pick<Batch, 'add'>;

export function buildingTop(b: CityBuilding): number {
  return b.height + (b.variant === 'power' ? 17 : b.district === 'downtown' ? 14 : 6);
}

export function roofModules(batch: Sink, b: CityBuilding, width: number, depth: number, top: number): void {
  const { x, z, kit } = b, w = width, d = depth;
  const cottage = b.variant === 'cottage', roofColor = b.plot?.roofColor ?? 'roof';
  if (kit.roof === 'gable' || kit.roof === 'hip') {
    const rise = cottage ? Math.min(1.9, w * 0.32) : Math.min(3, w * 0.42);
    batch.add(kit.roof === 'gable' ? 'roof' : 'hip', roofColor, x, top + rise / 2, z, w + 0.5, rise, d + 0.5);
    for (let n = 0; n < kit.equipmentCount; n++) {
      const px = x + ((n + 0.5) / kit.equipmentCount - 0.5) * w * (kit.rooftop === 'dormers' ? 0.8 : 0.55);
      if (kit.rooftop === 'chimney') {
        batch.add('box', 'brick', px, top + (cottage ? 1.4 : 2.2), z - d * 0.18, 0.55, cottage ? 1.6 : 3.6, 0.65);
        batch.add('box', kit.accent, px, top + (cottage ? 2.23 : 4.03), z - d * 0.18, 0.75, 0.16, 0.85);
      } else {
        batch.add('box', b.color, px, top + rise * 0.55, z + d * 0.22, 1.1, 1.25, 1.5);
        batch.add('roof', 'roof', px, top + rise * 0.55 + 0.85, z + d * 0.22, 1.5, 0.65, 1.8);
        batch.add('box', 'litWindow', px, top + rise * 0.55, z + d * 0.22 + 0.77, 0.7, 0.8, 0.07);
      }
    }
    return;
  }
  batch.add('box', roofColor, x, top + 0.12, z, w - 0.15, 0.2, d - 0.15);
  if (b.district !== 'industrial') for (const side of [-1, 1]) {
    batch.add('box', kit.accent, x + side * (w / 2 - 0.1), top + 0.4, z, 0.2, 0.7, d);
    batch.add('box', kit.accent, x, top + 0.4, z + side * (d / 2 - 0.1), w, 0.7, 0.2);
  }
  if (kit.roof === 'solar') {
    // Panels use the front roof strip; equipment and antenna bases keep their own rear/center slots.
    const count = kit.equipmentCount + 1;
    for (let col = 0; col < count; col++) {
      const px = x + ((col + 0.5) / count - 0.5) * w * 0.72;
      batch.add('box', 'steel', px, top + 0.65, z + d * 0.28, w * 0.65 / count, 0.14, d * 0.25, 0, -0.25);
      batch.add('box', 'glassDark', px, top + 0.74, z + d * 0.28, w * 0.61 / count, 0.04, d * 0.23, 0, -0.25);
    }
  } else if (kit.roof === 'garden') {
    batch.add('box', 'grassDark', x, top + 0.3, z, w * 0.64, 0.15, d * 0.64);
    for (const side of [-1, 1]) {
      batch.add('box', 'cream', x + side * w * 0.3, top + 0.6, z, w * 0.12, 0.6, d * 0.6);
      batch.add('leaf', 'green', x + side * w * 0.3, top + 1.1, z + d * 0.2, w * 0.2, 1.2, d * 0.25);
    }
  }
  if (kit.rooftop === 'pergola') {
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) batch.add('box', 'trunk', x + dx * w * 0.25, top + 1.45, z + dz * d * 0.25, 0.12, 2.6, 0.12);
    for (let n = 0; n < 6; n++) batch.add('box', 'trunk', x + (n / 5 - 0.5) * w * 0.58, top + 2.8, z, 0.15, 0.14, d * 0.6);
  } else if (kit.rooftop === 'antenna') {
    batch.add('box', 'steel', x, top + 1.4, z, w * 0.3, 2.4, d * 0.3);
    batch.add('cylinder', 'metal', x, top + 6.6, z, 0.25, 9, 0.25);
    batch.add('sphere', 'headlight', x, top + 11.2, z, 0.45, 0.45, 0.45);
  } else if (kit.rooftop === 'skylight') {
    batch.add('box', 'steel', x, top + 0.6, z - d * 0.25, w * 0.46, 0.75, d * 0.2);
    batch.add('roof', 'glassBlue', x, top + 1.2, z - d * 0.25, w * 0.48, 0.55, d * 0.23);
  } else {
    for (let n = 0; n < kit.equipmentCount; n++) {
      const px = x + ((n + 0.5) / kit.equipmentCount - 0.5) * w * 0.58;
      batch.add('box', 'steel', px, top + 0.65, z - d * 0.26, Math.min(1.5, w * 0.22), 0.9, Math.min(1.6, d * 0.23));
      batch.add('cylinder', 'metal', px, top + 1.12, z - d * 0.26, Math.min(0.85, w * 0.15), 0.06, Math.min(0.85, w * 0.15));
    }
  }
}

export function lowriseModules(batch: Sink, b: CityBuilding): void {
  const { x, z, width: w, depth: d, height: h, floors, color, kit } = b, base = 0.93;
  const plinth = kit.foundation === 'brick' ? 'brick' : 'paving';
  batch.add('box', 'paving', x, 0.91, z, w + 0.7, 0.3, d + 0.7);
  batch.add('box', color, x, base + h / 2, z, w, h, d);
  batch.add('box', plinth, x, 1.23, z, w + 0.15, 0.65, d + 0.15);

  function wall(axis: 'x' | 'z', sign: number): void {
    const wallWidth = axis === 'z' ? w : d, halfDepth = axis === 'z' ? d / 2 : w / 2;
    const columns = kit.rhythm + (wallWidth > 8 ? 1 : 0), spacing = wallWidth / columns;
    const add = (mat: string, along: number, y: number, outward: number, width: number, height: number, thickness: number) => {
      if (axis === 'z') batch.add('box', mat, x + along, y, z + sign * (halfDepth + outward), width, height, thickness);
      else batch.add('box', mat, x + sign * (halfDepth + outward), y, z + along, thickness, height, width);
    };
    if (kit.facade === 'vertical') for (let col = 0; col <= columns; col++) add(kit.accent, (col / columns - 0.5) * wallWidth * 0.97, base + h / 2, 0.13, 0.16, h, 0.2);
    for (let floor = 0; floor < floors; floor++) {
      const level = base + (floor + 0.55) * h / floors;
      if (kit.facade === 'ribbon') add('window', 0, level, 0.055, wallWidth - 0.15, 1.5, 0.12);
      if (floor > 0 && kit.facade !== 'vertical') add(kit.accent, 0, base + floor * h / floors, 0.09, wallWidth + 0.15, kit.facade === 'ribbon' ? 0.3 : 0.14, 0.17);
      for (let col = 0; col < columns; col++) {
        const wx = ((col + 0.5) / columns - 0.5) * wallWidth;
        if (b.plot && axis === 'z' && sign === 1 && floor === 0 && Math.abs(wx) < 0.85) continue;
        const windowWidth = spacing * (b.plot ? 0.48 : kit.facade === 'ribbon' ? 0.88 : 0.62);
        const glass = (floor * 7 + col * 3 + sign + kit.equipmentCount) % 4 ? 'litWindow' : 'window';
        if (kit.facade !== 'ribbon') add(kit.facade === 'recessed' ? 'dark' : kit.accent, wx, level, 0.09, windowWidth + 0.2, 1.8, 0.2);
        add(glass, wx, level, 0.21, windowWidth, 1.48, 0.06);
        if (kit.facade === 'classic') {
          add(kit.accent, wx, level, 0.26, 0.055, 1.5, 0.06);
          add(kit.accent, wx, level, 0.26, windowWidth, 0.055, 0.06);
        }
        if (axis === 'z' && floor > 0 && (kit.balconies === 'rows' || (kit.balconies === 'alternate' && (floor + col) % 2 === 0))) {
          const bw = Math.min(spacing * 0.92, 1.85);
          add('cream', wx, level - 0.92, 0.67, bw, 0.14, 1.25);
          add('metal', wx, level - 0.3, 1.25, bw, 0.08, 0.075);
          for (let rail = 0; rail < 4; rail++) add('metal', wx + (rail / 3 - 0.5) * bw * 0.9, level - 0.59, 1.25, 0.045, 0.66, 0.055);
          if ((floor + col) % 3 === 0) add('green', wx, level - 0.57, 0.68, bw * 0.6, 0.45, 0.4);
        }
      }
    }
    if (kit.foundation === 'columns') for (let col = 0; col <= columns; col++) add(kit.accent, (col / columns - 0.5) * wallWidth * 0.92, 2.12, 0.19, 0.24, 2.35, 0.28);
  }
  for (const side of [-1, 1]) { wall('x', side); wall('z', side); }
  batch.add('box', kit.accent, x, base + h, z, w + 0.4, 0.32, d + 0.4);
  roofModules(batch, b, w, d, base + h + 0.18);
  batch.add('box', 'dark', x, 2.14, z + d / 2 + 0.3, 1.2, 2.22, 0.12);
  batch.add('box', 'gold', x + 0.39, 2.1, z + d / 2 + 0.39, 0.07, 0.28, 0.06);
  if (kit.entrance === 'canopy') batch.add('box', kit.accent, x, 3.5, z + d / 2 + 0.7, 2, 0.18, 1.25);
  if (kit.entrance === 'steps') for (let n = 0; n < 3; n++) batch.add('box', plinth, x, 1.08 + n * 0.1, z + d / 2 + 0.45 - n * 0.1, 1.8 - n * 0.1, 0.12, 1.1 - n * 0.2);
  if (b.district === 'commercial') {
    for (let col = 0; col < kit.rhythm; col++) {
      const wx = x + ((col + 0.5) / kit.rhythm - 0.5) * w * 0.85;
      batch.add('box', 'window', wx, 2.18, z + d / 2 + 0.4, w * 0.75 / kit.rhythm, 2, 0.1);
    }
    for (let stripe = 0; stripe < 10; stripe++) batch.add('box', stripe % 2 ? 'trim' : color === 'cream' ? 'forest' : color, x + ((stripe + 0.5) / 10 - 0.5) * w * 0.92, 3.4, z + d / 2 + 0.76, w * 0.092, 0.18, 1.38, 0, 0.15);
    batch.add('box', kit.accent, x, 4.1, z + d / 2 + 0.19, w * 0.76, 0.58, 0.23);
  }
}
