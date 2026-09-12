// `ServiceCoverageIndex` of crates/simcity_sim/src/game/services/coverage.rs: the tiles each service reaches, a
// Manhattan diamond of its funded radius around every station, and the share of zoned building tiles covered.
import { serviceRadius } from '../buildings/building';
import type { World } from '../world';
import { serviceBuildingKind, serviceStations, type ServiceKind } from './stations';

const f32 = Math.fround;

export const MASK_FIRE = 1 << 0;
export const MASK_POLICE = 1 << 1;
export const MASK_MEDICAL = 1 << 2;
const MASKS: Readonly<Record<ServiceKind, number>> = { Fire: MASK_FIRE, Police: MASK_POLICE, Medical: MASK_MEDICAL };

export class ServiceCoverageIndex {
  /** Bumps on every recompute. */
  version = 0;
  /** The map edit, the funding and the stations the coverage was computed for. */
  mapVersion = 0;
  fundingVersion = 0;
  stationsKey = '';
  /** Shares of zoned building tiles covered, 0..1 (`f32`). */
  fire = 0;
  police = 0;
  medical = 0;
  buildingsTotal = 0;
  /** Per tile: `MASK_FIRE | MASK_POLICE | MASK_MEDICAL`. */
  coverageMap = new Uint8Array(0);

  overall(): number {
    if (this.buildingsTotal === 0) return 0;
    return Math.min(Math.max(f32(f32(f32(this.fire + this.police) + this.medical) / 3), 0), 1);
  }

  isCovered(idx: number, mask: number): boolean {
    return idx < this.coverageMap.length && (this.coverageMap[idx]! & mask) !== 0;
  }
}

/**
 * `compute_service_coverage_index` (PostSimStep::Coverage). Recomputes when the map was edited, a funding changed or
 * the set of stations did: a station opening or losing its road changes coverage without a map edit.
 */
export function updateServiceCoverage(w: World): void {
  const out = w.serviceCoverage;
  const grid = w.grid;
  const stations = serviceStations(w);
  const key = stations.map((s) => `${s.kind}@${s.pos.x},${s.pos.y}`).join('|');
  const len = grid.len();
  if (out.mapVersion === w.mapEditVersion && out.coverageMap.length === len && out.fundingVersion === w.serviceFunding.version && out.stationsKey === key) return;

  if (out.coverageMap.length !== len) out.coverageMap = new Uint8Array(len);
  else out.coverageMap.fill(0);

  for (const station of stations) {
    const radius = w.serviceFunding.scaledRadius(station.kind, serviceRadius(serviceBuildingKind(station.kind)) ?? 0);
    if (radius <= 0) continue;
    const mask = MASKS[station.kind];
    for (let dy = -radius; dy <= radius; dy++) {
      const maxDx = radius - Math.abs(dy);
      for (let dx = -maxDx; dx <= maxDx; dx++) {
        const idx = grid.idx({ x: station.pos.x + dx, y: station.pos.y + dy });
        if (idx !== undefined) out.coverageMap[idx]! |= mask;
      }
    }
  }

  let total = 0;
  let fire = 0;
  let police = 0;
  let medical = 0;
  for (let idx = 0; idx < len; idx++) {
    const building = grid.cellAt(idx).building;
    if (building !== 'Residential' && building !== 'Commercial' && building !== 'Industrial') continue;
    total += 1;
    const mask = out.coverageMap[idx]!;
    if ((mask & MASK_FIRE) !== 0) fire += 1;
    if ((mask & MASK_POLICE) !== 0) police += 1;
    if ((mask & MASK_MEDICAL) !== 0) medical += 1;
  }

  out.mapVersion = w.mapEditVersion;
  out.fundingVersion = w.serviceFunding.version;
  out.stationsKey = key;
  out.version += 1;
  out.buildingsTotal = total;
  out.fire = total > 0 ? f32(fire / total) : 0;
  out.police = total > 0 ? f32(police / total) : 0;
  out.medical = total > 0 ? f32(medical / total) : 0;
}
