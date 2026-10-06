import {generateCity} from '../city/generator';
import type {CityBuilding, CityLayout} from '../city/generator';
import type {AuthoredPlacement} from '../city/life/definition';
import type {Point} from '../region/model/types';

export type ZoneDistrict = 'residential' | 'commercial' | 'industrial';

export interface AssemblyEntry {
  readonly template: CityBuilding;
  readonly city: CityLayout;
}

/** Original procedural assemblies only; several source cities widen variety. */
export function assemblyPool(
  seed: string,
  district: ZoneDistrict,
): AssemblyEntry[] {
  const sources = [
    generateCity(seed),
    generateCity(`${seed}/v2`),
    generateCity(`${seed}/v3`),
  ];
  // residential/commercial keep the underground-parking eligibility filter.
  const passes: Record<
    ZoneDistrict,
    (b: CityBuilding, city: CityLayout) => boolean
  > = {
    residential: (b, city) =>
      b.district === 'residential' &&
      !b.plot &&
      b.floors >= 6 &&
      b.z > city.blocks.find(block => block.id === b.blockId)!.z,
    commercial: (b, city) =>
      b.district === 'commercial' &&
      b.floors >= 6 &&
      b.z > city.blocks.find(block => block.id === b.blockId)!.z,
    industrial: b => b.district === 'industrial' && b.variant !== 'warehouse',
  };

  return sources.flatMap(city =>
    city.buildings
      .filter(building => passes[district](building, city))
      .map(template => ({template, city})),
  );
}

/** Stable FNV hash of an arbitrary key, as used by the authorized migration. */
export function stableHash(key: string): number {
  let hash = 2166136261;

  for (const char of key) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }

  return hash >>> 0;
}

export interface StripPackingOptions {
  readonly seed: string;
  readonly district: ZoneDistrict;
  /** Strip origin (front line at the street edge) and its unit direction. */
  readonly origin: Point;
  readonly direction: Point;
  readonly length: number;
  readonly municipalityId: string;
  readonly idPrefix: string;
  readonly startedAt: number;
  readonly duration: number;
  /** Keeps the last N chosen assemblies from repeating along the strip. */
  readonly recentRing?: number;
  readonly dry: (center: Point, width: number, depth: number) => boolean;
  readonly blocked: (center: Point, width: number, depth: number) => boolean;
}

/** Pack freestanding houses of their own size along a street-facing strip. */
export function packStreetStrip(
  options: StripPackingOptions,
): AuthoredPlacement[] {
  const pool = assemblyPool(options.seed, options.district);

  if (!pool.length) {
    throw new Error('Для зоны нет исходных сборок.');
  }

  const ring = options.recentRing ?? 10;
  const recent: string[] = [];
  const placements: AuthoredPlacement[] = [];
  const along = {x: options.direction.x, z: options.direction.z};
  const normal = {x: -along.z, z: along.x};
  let cursor = 2;

  while (cursor < options.length - 6) {
    const index =
      stableHash(`${options.seed}/${options.idPrefix}/${placements.length}`) %
      pool.length;
    let entry = pool[index]!;

    for (let offset = 0; offset < pool.length; offset++) {
      const candidate = pool[(index + offset) % pool.length]!;

      if (!recent.includes(candidate.template.id)) {
        entry = candidate;
        break;
      }
    }

    const template = entry.template;
    const width = template.width;
    const depth = template.depth;

    if (cursor + width > options.length - 2) {
      break;
    }

    const frontCenter = {
      x: options.origin.x + along.x * (cursor + width / 2),
      z: options.origin.z + along.z * (cursor + width / 2),
    };
    const center = {
      x: frontCenter.x + normal.x * (depth / 2 + 1),
      z: frontCenter.z + normal.z * (depth / 2 + 1),
    };

    cursor += width + 1.5;

    if (
      !options.dry(center, width, depth) ||
      options.blocked(center, width, depth)
    ) {
      continue;
    }

    recent.push(template.id);

    if (recent.length > ring) {
      recent.shift();
    }

    placements.push({
      id: `${options.idPrefix}/${placements.length}`,
      municipalityId: options.municipalityId,
      template,
      sourceBlock: entry.city.blocks.find(
        block => block.id === template.blockId,
      )!,
      center,
      yaw: Math.atan2(normal.x, normal.z),
      kind:
        options.district === 'residential'
          ? 'home'
          : options.district === 'commercial'
            ? 'shop'
            : 'factory',
      startedAt: options.startedAt,
      readyAt: options.startedAt + options.duration,
      standalone: true,
    });
  }

  return placements;
}
