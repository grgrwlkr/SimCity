// Port of crates/simcity_sim/src/game/employment.rs: unemployed citizens take the nearest reachable job of their home's
// class, a job goes with its workplace, and the stats demand reads. Only open workplaces hire; Rust hired at building
// sites. The config is `assets/config/employment.ron` as a constant until the RON loader of stage 6.
import { isOperational, type Building } from './buildings/building';
import type { TilePos } from './commands';
import type { WealthClass } from './economy/wealth';
import { shuffle } from './rng';
import { roadPathCtx } from './traffic/reroute';
import { adjacentRoadTowardsFootprint } from './transport/anchors';
import { findRoadPathCached } from './transport/pathfinding';
import type { World } from './world';

const f32 = Math.fround;

export interface EmploymentConfig {
  /** New assignments per tick. */
  readonly maxAssignmentsPerTick: number;
  /** Workplaces a citizen weighs. */
  readonly maxCandidatesPerCitizen: number;
  /** Road path searches per tick. */
  readonly maxPathfindAttemptsPerTick: number;
  /** Unemployed citizens scanned per tick. */
  readonly maxUnassignedScansPerTick: number;
  /** Remember home and job road pairs no path joins, across ticks. */
  readonly unreachablePairCacheEnabled: boolean;
  readonly unreachablePairCacheCapacity: number;
  /** Ticks an unreachable pair is remembered without being looked at. */
  readonly unreachablePairCacheTtlTicks: number;
}

export const EMPLOYMENT_CONFIG: EmploymentConfig = {
  maxAssignmentsPerTick: 32,
  maxCandidatesPerCitizen: 24,
  maxPathfindAttemptsPerTick: 128,
  maxUnassignedScansPerTick: 512,
  unreachablePairCacheEnabled: true,
  unreachablePairCacheCapacity: 4096,
  unreachablePairCacheTtlTicks: 600,
};

export type ByClass = Record<WealthClass, number>;
const byClass = (): ByClass => ({ Low: 0, Middle: 0, High: 0 });

export interface EmploymentStats {
  employed: number;
  unemployed: number;
  employedCommercial: number;
  employedIndustrial: number;
  employmentRate: number;
  /** Residents by the class of their home. */
  workersByClass: ByClass;
  /** Jobs by the class of the open workplace offering them. */
  jobsByClass: ByClass;
  /** Residents without a job, by the class of their home. */
  unemployedByClass: ByClass;
  pathfindAttemptsLastTick: number;
  pathfindFailuresLastTick: number;
  skippedFailedPairsLastTick: number;
  unassignedScannedLastTick: number;
  budgetHitLastTick: boolean;
  unreachableCacheLookupsLastTick: number;
  skippedUnreachableCacheLastTick: number;
  unreachableCacheInsertsLastTick: number;
  unreachableCacheEntries: number;
  unreachableCacheTtlEvictionsLastTick: number;
  unreachableCacheCapacityEvictionsLastTick: number;
  unreachableCacheGraphClearedLastTick: boolean;
}

export function emptyEmploymentStats(): EmploymentStats {
  return {
    employed: 0,
    unemployed: 0,
    employedCommercial: 0,
    employedIndustrial: 0,
    employmentRate: 0,
    workersByClass: byClass(),
    jobsByClass: byClass(),
    unemployedByClass: byClass(),
    pathfindAttemptsLastTick: 0,
    pathfindFailuresLastTick: 0,
    skippedFailedPairsLastTick: 0,
    unassignedScannedLastTick: 0,
    budgetHitLastTick: false,
    unreachableCacheLookupsLastTick: 0,
    skippedUnreachableCacheLastTick: 0,
    unreachableCacheInsertsLastTick: 0,
    unreachableCacheEntries: 0,
    unreachableCacheTtlEvictionsLastTick: 0,
    unreachableCacheCapacityEvictionsLastTick: 0,
    unreachableCacheGraphClearedLastTick: false,
  };
}

/** Whether a worker from a home of class `home` takes a job of class `job`: only the same class, so a mismatch leaves people unemployed beside open jobs. */
export function classJobMatches(home: WealthClass, job: WealthClass): boolean {
  return home === job;
}

/** The directional key of a home road and a job road. */
export function pairKey(homeRoad: TilePos, jobRoad: TilePos): string {
  return `${homeRoad.x},${homeRoad.y}>${jobRoad.x},${jobRoad.y}`;
}

export interface CacheMaintenance {
  graphCleared: boolean;
  ttlEvictions: number;
  capacityEvictions: number;
}

/** `EmploymentUnreachablePairCache`: home and job road pairs no path joins, remembered across ticks. */
export class EmploymentUnreachablePairCache {
  private graphVersion = 0;
  private tick = 0;
  /** Pair → the tick it was last looked at. */
  private readonly lastSeen = new Map<string, number>();
  /** An approximate LRU queue from `head` on: duplicates allowed, stale entries skipped when they reach the front. */
  private lru: Array<readonly [string, number]> = [];
  private head = 0;

  beginTick(graphVersion: number, enabled: boolean, ttlTicks: number, capacity: number): CacheMaintenance {
    this.tick += 1;
    const maintenance: CacheMaintenance = { graphCleared: false, ttlEvictions: 0, capacityEvictions: 0 };
    if (this.graphVersion !== graphVersion) {
      this.clearAll();
      this.graphVersion = graphVersion;
      maintenance.graphCleared = true;
    }
    if (!enabled) {
      this.clearAll();
      return maintenance;
    }
    maintenance.ttlEvictions = this.purgeTtl(ttlTicks);
    maintenance.capacityEvictions = this.enforceCapacity(capacity);
    return maintenance;
  }

  containsUnreachable(key: string): boolean {
    if (!this.lastSeen.has(key)) return false;
    this.touch(key);
    return true;
  }

  rememberUnreachable(key: string, capacity: number): { readonly inserted: boolean; readonly capacityEvictions: number } {
    const known = this.lastSeen.has(key);
    this.touch(key);
    return known ? { inserted: false, capacityEvictions: 0 } : { inserted: true, capacityEvictions: this.enforceCapacity(capacity) };
  }

  len(): number {
    return this.lastSeen.size;
  }

  fingerprintState(): unknown {
    return [this.graphVersion, this.tick, [...this.lastSeen], this.lru.slice(this.head)];
  }

  private touch(key: string): void {
    this.lastSeen.set(key, this.tick);
    this.lru.push([key, this.tick]);
  }

  private clearAll(): void {
    this.lastSeen.clear();
    this.lru = [];
    this.head = 0;
  }

  private purgeTtl(ttlTicks: number): number {
    if (ttlTicks === 0) {
      const removed = this.lastSeen.size;
      this.clearAll();
      return removed;
    }
    let removed = 0;
    while (this.head < this.lru.length) {
      const [key, touched] = this.lru[this.head]!;
      if (this.tick - touched <= ttlTicks) break;
      this.head += 1;
      if (this.lastSeen.get(key) === touched) {
        this.lastSeen.delete(key);
        removed += 1;
      }
    }
    this.compact();
    return removed;
  }

  private enforceCapacity(capacity: number): number {
    if (capacity === 0) {
      const removed = this.lastSeen.size;
      this.clearAll();
      return removed;
    }
    let removed = 0;
    while (this.lastSeen.size > capacity && this.head < this.lru.length) {
      const [key, touched] = this.lru[this.head]!;
      this.head += 1;
      if (this.lastSeen.get(key) === touched) {
        this.lastSeen.delete(key);
        removed += 1;
      }
    }
    // The queue drained without restoring capacity: evict in insertion order, which is deterministic.
    for (const key of this.lastSeen.keys()) {
      if (this.lastSeen.size <= capacity) break;
      this.lastSeen.delete(key);
      removed += 1;
    }
    this.compact();
    return removed;
  }

  private compact(): void {
    if (this.head > 1024 && this.head * 2 > this.lru.length) {
      this.lru = this.lru.slice(this.head);
      this.head = 0;
    }
  }
}

const isWorkplace = (b: Building) => b.kind === 'Commercial' || b.kind === 'Industrial';

/**
 * `assign_jobs` (SimStep::Employment): open jobs in a shuffled order; each unemployed citizen, within the per-tick
 * budgets, takes the candidate of their class with the shortest road path from home.
 */
export function assignJobs(w: World): void {
  const cfg = EMPLOYMENT_CONFIG;
  const stats = w.employmentStats;
  const cache = w.unreachablePairs;
  const cacheOn = cfg.unreachablePairCacheEnabled;
  const capacity = cfg.unreachablePairCacheCapacity;
  const maintenance = cache.beginTick(w.roadGraph.version, cacheOn, cfg.unreachablePairCacheTtlTicks, capacity);

  const taken = new Map<number, number>();
  for (const c of w.citizens.all()) if (c.workplace !== null) taken.set(c.workplace, (taken.get(c.workplace) ?? 0) + 1);
  const jobs = w.buildings.all().filter((b) => isWorkplace(b) && isOperational(b) && b.capacityJobs > (taken.get(b.id) ?? 0));

  let assigned = 0;
  let attempts = 0;
  let failures = 0;
  let skippedFailed = 0;
  let scanned = 0;
  let budgetHit = false;
  let lookups = 0;
  let skippedCached = 0;
  let inserts = 0;
  let capacityEvictions = maintenance.capacityEvictions;

  if (jobs.length > 0) {
    shuffle(w.simRng, jobs);
    const candidates = Math.min(jobs.length, cfg.maxCandidatesPerCitizen);
    // Pairs that failed this tick, so many citizens of one block do not repeat one failed search.
    const failed = new Set<string>();
    const ctx = roadPathCtx(w);
    citizens: for (const c of w.citizens.all()) {
      if (assigned >= cfg.maxAssignmentsPerTick) break;
      if (c.workplace !== null) continue;
      scanned += 1;
      if (cfg.maxUnassignedScansPerTick > 0 && scanned > cfg.maxUnassignedScansPerTick) {
        budgetHit = true;
        break;
      }
      const home = w.buildings.get(c.home);
      if (home === undefined) continue;

      let best: { readonly job: Building; readonly steps: number } | undefined;
      for (let i = 0; i < candidates; i++) {
        const job = jobs[i]!;
        if ((taken.get(job.id) ?? 0) >= job.capacityJobs) continue;
        if (!classJobMatches(home.profile.class, job.profile.class)) continue;
        const homeRoad = adjacentRoadTowardsFootprint(w.grid, home.anchor, home.width, home.length, job.anchor);
        if (homeRoad === undefined) continue;
        const jobRoad = adjacentRoadTowardsFootprint(w.grid, job.anchor, job.width, job.length, home.anchor);
        if (jobRoad === undefined) continue;

        const key = pairKey(homeRoad, jobRoad);
        if (failed.has(key)) {
          skippedFailed += 1;
          continue;
        }
        if (cacheOn) {
          lookups += 1;
          if (cache.containsUnreachable(key)) {
            skippedCached += 1;
            continue;
          }
        }
        if (cfg.maxPathfindAttemptsPerTick > 0 && attempts >= cfg.maxPathfindAttemptsPerTick) {
          budgetHit = true;
          break citizens;
        }
        attempts += 1;

        const path = findRoadPathCached(ctx, homeRoad, jobRoad);
        if (path.length === 0) {
          failures += 1;
          failed.add(key);
          if (cacheOn) {
            const result = cache.rememberUnreachable(key, capacity);
            if (result.inserted) inserts += 1;
            capacityEvictions += result.capacityEvictions;
          }
          continue;
        }
        if (best === undefined || path.length < best.steps) best = { job, steps: path.length };
      }

      if (best === undefined) continue;
      c.workplace = best.job.id;
      taken.set(best.job.id, (taken.get(best.job.id) ?? 0) + 1);
      assigned += 1;
    }
  }

  stats.pathfindAttemptsLastTick = attempts;
  stats.pathfindFailuresLastTick = failures;
  stats.skippedFailedPairsLastTick = skippedFailed;
  stats.unassignedScannedLastTick = scanned;
  stats.budgetHitLastTick = budgetHit;
  stats.unreachableCacheLookupsLastTick = lookups;
  stats.skippedUnreachableCacheLastTick = skippedCached;
  stats.unreachableCacheInsertsLastTick = inserts;
  stats.unreachableCacheEntries = cache.len();
  stats.unreachableCacheTtlEvictionsLastTick = maintenance.ttlEvictions;
  stats.unreachableCacheCapacityEvictionsLastTick = capacityEvictions;
  stats.unreachableCacheGraphClearedLastTick = maintenance.graphCleared;
}

/** `clear_invalid_workplaces` (SimStep::Employment, before assignment): a job goes with its workplace. */
export function clearInvalidWorkplaces(w: World): void {
  for (const c of w.citizens.all()) {
    if (c.workplace === null) continue;
    const workplace = w.buildings.get(c.workplace);
    if (workplace === undefined || !isWorkplace(workplace)) c.workplace = null;
  }
}

/** `compute_employment_stats` (PostSimStep::EmploymentStats). */
export function computeEmploymentStats(w: World): void {
  const stats = w.employmentStats;
  const jobsByClass = byClass();
  for (const b of w.buildings.all()) if (isWorkplace(b) && isOperational(b)) jobsByClass[b.profile.class] += b.capacityJobs;

  let employed = 0;
  let unemployed = 0;
  let employedCommercial = 0;
  let employedIndustrial = 0;
  const workersByClass = byClass();
  const unemployedByClass = byClass();
  for (const c of w.citizens.all()) {
    const wealth = w.buildings.get(c.home)?.profile.class ?? 'Middle';
    workersByClass[wealth] += 1;
    if (c.workplace === null) {
      unemployed += 1;
      unemployedByClass[wealth] += 1;
      continue;
    }
    employed += 1;
    const kind = w.buildings.get(c.workplace)?.kind;
    if (kind === 'Commercial') employedCommercial += 1;
    else if (kind === 'Industrial') employedIndustrial += 1;
  }

  stats.employed = employed;
  stats.unemployed = unemployed;
  stats.employedCommercial = employedCommercial;
  stats.employedIndustrial = employedIndustrial;
  stats.workersByClass = workersByClass;
  stats.jobsByClass = jobsByClass;
  stats.unemployedByClass = unemployedByClass;
  const total = employed + unemployed;
  stats.employmentRate = total > 0 ? f32(employed / total) : 0;
}
