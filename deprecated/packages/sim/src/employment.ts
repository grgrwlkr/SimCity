// Port of crates/simcity_sim/src/game/employment.rs: unemployed citizens take a job of their home's class, a job goes with
// its workplace, and the stats demand reads. Only open workplaces hire; Rust hired at building sites. TS stage 3½b: a
// queue of job seekers takes the job nearest by the district travel times, where Rust searched a road path for every
// pair of home and job and kept a cache of the pairs no path joined.
import { isOperational, type Building } from './buildings/building';
import type { WealthClass } from './economy/wealth';
import { NO_TIME } from './meso/districts';
import { adjacentRoadTowardsFootprint } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;

export interface EmploymentConfig {
  /** New assignments per tick. */
  readonly maxAssignmentsPerTick: number;
  /** Job seekers looked at per tick. */
  readonly maxSeekersPerTick: number;
}

export const EMPLOYMENT_CONFIG: EmploymentConfig = { maxAssignmentsPerTick: 32, maxSeekersPerTick: 512 };

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
  /** Job seekers looked at on the last tick, and how many of them took a job. */
  seekersScannedLastTick: number;
  assignedLastTick: number;
  budgetHitLastTick: boolean;
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
    seekersScannedLastTick: 0,
    assignedLastTick: 0,
    budgetHitLastTick: false,
  };
}

/** Whether a worker from a home of class `home` takes a job of class `job`: only the same class, so a mismatch leaves people unemployed beside open jobs. */
export function classJobMatches(home: WealthClass, job: WealthClass): boolean {
  return home === job;
}

const isWorkplace = (b: Building) => b.kind === 'Commercial' || b.kind === 'Industrial';

const besideRoad = (w: World, b: Building) => adjacentRoadTowardsFootprint(w.grid, b.anchor, b.width, b.length, b.anchor) !== undefined;

/**
 * `assign_jobs` (SimStep::Employment): within the per-tick budgets, each job seeker takes an open job of their home's
 * class in the district nearest by travel time from home; a seeker with none in reach, or whose home district has no
 * times yet, waits for a later tick. A home or a workplace off the road takes part in nothing.
 */
export function assignJobs(w: World): void {
  const cfg = EMPLOYMENT_CONFIG;
  const stats = w.employmentStats;
  const citizens = w.citizens;
  const times = w.districtTimes;
  stats.seekersScannedLastTick = 0;
  stats.assignedLastTick = 0;
  stats.budgetHitLastTick = false;
  if (citizens.jobSeekers.length === 0) return;

  // Open jobs by district, in building order.
  const open = new Map<number, Building[]>();
  for (const b of w.buildings.all()) {
    if (!isWorkplace(b) || !isOperational(b) || b.capacityJobs <= citizens.workersOf(b.id) || !besideRoad(w, b)) continue;
    const district = times.districtAt(b.anchor);
    if (district === undefined) continue;
    const jobs = open.get(district);
    if (jobs === undefined) open.set(district, [b]);
    else jobs.push(b);
  }

  const seekers = citizens.jobSeekers;
  citizens.jobSeekers = [];
  const waiting: number[] = [];
  let assigned = 0;
  let scanned = 0;
  for (let i = 0; i < seekers.length; i++) {
    if (assigned >= cfg.maxAssignmentsPerTick || scanned >= cfg.maxSeekersPerTick) {
      stats.budgetHitLastTick = true;
      citizens.jobSeekers.push(...seekers.slice(i));
      break;
    }
    const ref = seekers[i]!;
    const slot = citizens.resolve(ref);
    if (slot === undefined || citizens.workplace[slot] !== -1) continue;
    scanned += 1;
    const home = w.buildings.get(citizens.home[slot]!);
    const from = home === undefined ? undefined : times.districtAt(home.anchor);
    if (home === undefined || from === undefined || !times.rowReady(from) || !besideRoad(w, home)) {
      waiting.push(ref);
      continue;
    }
    let job: Building | undefined;
    let best = NO_TIME;
    for (const [district, jobs] of open) {
      const seconds = times.seconds(from, district);
      if (seconds >= best) continue;
      const candidate = jobs.find((b) => classJobMatches(home.profile.class, b.profile.class) && citizens.workersOf(b.id) < b.capacityJobs);
      if (candidate === undefined) continue;
      job = candidate;
      best = seconds;
    }
    if (job === undefined) {
      waiting.push(ref);
      continue;
    }
    citizens.setWorkplace(slot, job.id);
    assigned += 1;
  }
  citizens.jobSeekers.push(...waiting);
  stats.seekersScannedLastTick = scanned;
  stats.assignedLastTick = assigned;
}

/** Derived, not state: the buildings version the workplaces were last checked against. */
const workplacesChecked = new WeakMap<World, number>();

/**
 * `clear_invalid_workplaces` (SimStep::Employment, before assignment): a job goes with its workplace. A workplace stops
 * being one only when its building goes, so the citizens are looked at after the buildings changed.
 */
export function clearInvalidWorkplaces(w: World): void {
  if (workplacesChecked.get(w) === w.buildings.version) return;
  workplacesChecked.set(w, w.buildings.version);
  const citizens = w.citizens;
  for (let slot = 0; slot < citizens.highWater; slot++) {
    if (citizens.alive[slot] !== 1 || citizens.workplace[slot] === -1) continue;
    const workplace = w.buildings.get(citizens.workplace[slot]!);
    if (workplace === undefined || !isWorkplace(workplace)) citizens.setWorkplace(slot, null);
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
  const citizens = w.citizens;
  for (let slot = 0; slot < citizens.highWater; slot++) {
    if (citizens.alive[slot] !== 1) continue;
    const wealth = w.buildings.get(citizens.home[slot]!)?.profile.class ?? 'Middle';
    workersByClass[wealth] += 1;
    if (citizens.workplace[slot] === -1) {
      unemployed += 1;
      unemployedByClass[wealth] += 1;
      continue;
    }
    employed += 1;
    const kind = w.buildings.get(citizens.workplace[slot]!)?.kind;
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
