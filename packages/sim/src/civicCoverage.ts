// Port of crates/simcity_sim/src/game/civic_coverage.rs: how strongly schools, universities and parks reach each tile. An
// open civic building reaches the diamond of its service radius around its anchor. While the residents living within that
// radius fit its capacity it reaches at full strength; past it, the strength falls as capacity over residents. Recomputed
// when the map changes, the civic buildings open or close, or a day turns: residents move by the day.
import { isOperational, serviceCapacity, serviceRadius } from './buildings/building';
import type { BuildingKind, TilePos } from './commands';
import type { World } from './world';

const f32 = Math.fround;

export const CIVIC_KINDS = ['School', 'University', 'Park'] as const satisfies readonly BuildingKind[];
export type CivicKind = (typeof CIVIC_KINDS)[number];

/** Education a school at full strength adds to the tiles it reaches. */
export const SCHOOL_EDUCATION = f32(0.35);
/** Education a university at full strength adds to the tiles it reaches. */
export const UNIVERSITY_EDUCATION = f32(0.3);
/** Health a park at full strength adds to the tiles it reaches. */
export const PARK_HEALTH = f32(0.2);

/** One open civic building as the coverage last saw it. */
export interface CivicSource {
  readonly kind: CivicKind;
  readonly anchor: TilePos;
  readonly capacity: number;
  /** Residents of the homes whose footprint centre lies within the radius. */
  readonly residents: number;
  readonly strength: number;
}

export function civicKindOf(kind: BuildingKind): CivicKind | undefined {
  return (CIVIC_KINDS as readonly BuildingKind[]).includes(kind) ? (kind as CivicKind) : undefined;
}

/** How strongly a civic building of `capacity` reaches when `residents` live within its radius. */
export function civicStrength(capacity: number, residents: number): number {
  return residents <= capacity ? 1 : f32(capacity / residents);
}

export class CivicCoverage {
  /** Strength per kind per tile, in `CIVIC_KINDS` order. */
  strength: Float32Array[] = CIVIC_KINDS.map(() => new Float32Array(0));
  /** Open civic buildings, by kind and then anchor. */
  sources: CivicSource[] = [];
  /** Bumps on every recompute. */
  version = 0;
  /** The map edit and the open civic buildings the coverage was computed for. */
  mapVersion = -1;
  sourcesKey = '';

  get(kind: CivicKind, idx: number): number {
    return this.strength[CIVIC_KINDS.indexOf(kind)]![idx] ?? 0;
  }

  covers(len: number): boolean {
    return len > 0 && this.strength.every((layer) => layer.length === len);
  }
}

/**
 * `compute_civic_coverage` (PostSimStep::Coverage), once a game minute beside the service coverage: recomputed on a new
 * day, a map edit, a change in the open civic buildings or a map of another size.
 */
export function updateCivicCoverage(w: World): void {
  const out = w.civicCoverage;
  const grid = w.grid;
  const len = grid.len();
  const civic = w.buildings.all().filter((b) => isOperational(b) && civicKindOf(b.kind) !== undefined);
  const key = civic.map((b) => `${b.kind}@${b.anchor.x},${b.anchor.y}`).join('|');
  if (w.events.dayAdvanced.length === 0 && out.mapVersion === w.mapEditVersion && out.sourcesKey === key && out.covers(len)) return;

  // Residents by the tile their home's footprint is centred on.
  const residentsAt = new Map<number, number>();
  for (const b of w.buildings.all()) {
    if (b.kind !== 'Residential' || !isOperational(b) || b.occupancyResidents <= 0) continue;
    const [cx, cy] = [b.anchor.x + Math.floor(b.width / 2), b.anchor.y + Math.floor(b.length / 2)];
    residentsAt.set(cy * grid.width + cx, (residentsAt.get(cy * grid.width + cx) ?? 0) + b.occupancyResidents);
  }
  const homes = [...residentsAt];

  const sources: CivicSource[] = [];
  for (const b of civic) {
    const kind = civicKindOf(b.kind)!;
    const radius = serviceRadius(b.kind) ?? 0;
    const capacity = serviceCapacity(b.kind) ?? 0;
    let residents = 0;
    for (const [tile, count] of homes) {
      const [x, y] = [tile % grid.width, Math.floor(tile / grid.width)];
      if (Math.abs(x - b.anchor.x) + Math.abs(y - b.anchor.y) <= radius) residents += count;
    }
    sources.push({ kind, anchor: { ...b.anchor }, capacity, residents, strength: civicStrength(capacity, residents) });
  }
  // The published list does not depend on the order buildings were added in.
  sources.sort((a, b) => CIVIC_KINDS.indexOf(a.kind) - CIVIC_KINDS.indexOf(b.kind) || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);

  out.strength = CIVIC_KINDS.map(() => new Float32Array(len));
  for (const source of sources) {
    const radius = serviceRadius(source.kind) ?? 0;
    const layer = out.strength[CIVIC_KINDS.indexOf(source.kind)]!;
    for (let dy = -radius; dy <= radius; dy++) {
      const maxDx = radius - Math.abs(dy);
      for (let dx = -maxDx; dx <= maxDx; dx++) {
        const idx = grid.idx({ x: source.anchor.x + dx, y: source.anchor.y + dy });
        if (idx !== undefined) layer[idx] = Math.max(layer[idx]!, source.strength);
      }
    }
  }
  out.sources = sources;
  out.mapVersion = w.mapEditVersion;
  out.sourcesKey = key;
  out.version += 1;
}
