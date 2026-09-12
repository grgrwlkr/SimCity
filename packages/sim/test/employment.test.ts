// Port of the tests in crates/simcity_sim/src/game/employment.rs, and of what they left untested: who gets
// which job, and a job lost with its workplace.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../src/app';
import { newBuilding, type Building } from '../src/buildings/building';
import { newCitizen } from '../src/citizens';
import type { BuildingKind, RoadCell, TilePos } from '../src/commands';
import type { WealthClass } from '../src/economy/wealth';
import { EmploymentUnreachablePairCache, assignJobs, classJobMatches, clearInvalidWorkplaces, computeEmploymentStats, pairKey } from '../src/employment';
import { MapGrid } from '../src/map/grid';
import { requestState } from '../src/state';
import { createWorld, type World } from '../src/world';
import { t, worldOn } from './buildings/helpers';

function building(kind: BuildingKind, anchor: TilePos, jobs: number, wealth: WealthClass): Building {
  return newBuilding({ kind, anchor, capacityJobs: jobs, profile: { density: 'Medium', class: wealth } });
}

const ROAD: RoadCell = { kind: 'TwoLane', dir: 'East', lane: 0, flow: { kind: 'TwoWay' }, laneType: 'Regular' };

/** A 32×16 town with one road along y = 5, its graphs built. */
function town(): World {
  const w = createWorld({ mapWidth: 32, mapHeight: 16 });
  requestState(w, 'InGame');
  frame(w, 0);
  for (let x = 0; x < 32; x++) w.commands.push({ kind: 'SetRoad', pos: { x, y: 5 }, road: ROAD });
  // Commands apply after the frame's fixed ticks; the road graph is rebuilt on the tick after.
  step(w, 2);
  expect(w.roadGraph.version, 'the road graph is built').toBeGreaterThan(0);
  return w;
}

describe('employment stats', () => {
  it('zoneDensityUnemploymentIsCountedByTheClassOfTheHome', () => {
    expect(classJobMatches('Low', 'Low')).toBe(true);
    expect(classJobMatches('High', 'Low'), 'a rich worker does not take a poor job').toBe(false);

    const w = worldOn(new MapGrid(16, 16));
    const richHome = w.buildings.add(building('Residential', t(0, 0), 0, 'High'));
    w.buildings.add(building('Commercial', t(8, 0), 5, 'Low'));
    const middleHome = w.buildings.add(building('Residential', t(0, 8), 0, 'Middle'));
    const middleFactory = w.buildings.add(building('Industrial', t(8, 8), 4, 'Middle'));
    for (let i = 0; i < 3; i++) w.citizens.add(newCitizen(richHome));
    w.citizens.add({ ...newCitizen(middleHome), workplace: middleFactory.id });

    computeEmploymentStats(w);
    const stats = w.employmentStats;
    expect(stats.workersByClass).toEqual({ Low: 0, Middle: 1, High: 3 });
    expect(stats.jobsByClass).toEqual({ Low: 5, Middle: 4, High: 0 });
    expect(stats.unemployedByClass, 'rich workers beside poor jobs stay unemployed').toEqual({ Low: 0, Middle: 0, High: 3 });
    expect(stats.employedIndustrial).toBe(1);
  });
});

describe('unreachable pair cache', () => {
  it('unreachableCacheKeyIsDirectional', () => {
    const cache = new EmploymentUnreachablePairCache();
    const ab = pairKey(t(1, 1), t(2, 2));
    cache.beginTick(1, true, 10, 32);
    cache.rememberUnreachable(ab, 32);
    expect(cache.containsUnreachable(ab)).toBe(true);
    expect(cache.containsUnreachable(pairKey(t(2, 2), t(1, 1)))).toBe(false);
  });

  it('unreachableCacheExpiresAfterTtlTicks', () => {
    const cache = new EmploymentUnreachablePairCache();
    const key = pairKey(t(3, 3), t(4, 4));
    cache.beginTick(1, true, 2, 32);
    cache.rememberUnreachable(key, 32);
    cache.beginTick(1, true, 2, 32);
    cache.beginTick(1, true, 2, 32);
    expect(cache.len()).toBe(1);
    cache.beginTick(1, true, 2, 32);
    expect(cache.len()).toBe(0);
    expect(cache.containsUnreachable(key)).toBe(false);
  });

  it('unreachableCacheEnforcesCapacityWithLruTouch', () => {
    const cache = new EmploymentUnreachablePairCache();
    const a = pairKey(t(1, 1), t(1, 2));
    const b = pairKey(t(2, 1), t(2, 2));
    const c = pairKey(t(3, 1), t(3, 2));
    cache.beginTick(1, true, 100, 2);
    cache.rememberUnreachable(a, 2);
    cache.rememberUnreachable(b, 2);
    cache.beginTick(1, true, 100, 2);
    expect(cache.containsUnreachable(a)).toBe(true);
    cache.beginTick(1, true, 100, 2);
    cache.rememberUnreachable(c, 2);

    expect(cache.len()).toBe(2);
    expect(cache.containsUnreachable(a)).toBe(true);
    expect(cache.containsUnreachable(c)).toBe(true);
    expect(cache.containsUnreachable(b)).toBe(false);
  });

  it('unreachableCacheClearsOnGraphVersionChange', () => {
    const cache = new EmploymentUnreachablePairCache();
    cache.beginTick(10, true, 100, 32);
    cache.rememberUnreachable(pairKey(t(7, 7), t(8, 8)), 32);
    expect(cache.len()).toBe(1);
    expect(cache.beginTick(11, true, 100, 32).graphCleared).toBe(true);
    expect(cache.len()).toBe(0);
  });
});

describe('job assignment', () => {
  it('aWorkerTakesAJobOfTheClassOfTheirHomeThatTheRoadReaches', () => {
    const w = town();
    const home = w.buildings.add(building('Residential', t(2, 6), 0, 'Middle'));
    w.buildings.add(building('Commercial', t(10, 6), 5, 'Low'));
    const shop = w.buildings.add(building('Commercial', t(20, 6), 1, 'Middle'));
    // A middle-class factory on no road at all.
    w.buildings.add(building('Industrial', t(20, 11), 5, 'Middle'));
    const first = w.citizens.add(newCitizen(home));
    const second = w.citizens.add(newCitizen(home));

    assignJobs(w);

    expect(first.workplace, 'the one middle-class job the road reaches').toBe(shop.id);
    expect(second.workplace, 'its one job is taken and the low-class shop is not for them').toBeNull();
  });

  it('noOneWorksAtABuildingStillUnderConstruction', () => {
    const w = town();
    const home = w.buildings.add(building('Residential', t(2, 6), 0, 'Middle'));
    w.buildings.add({ ...building('Commercial', t(20, 6), 5, 'Middle'), phase: { kind: 'UnderConstruction', hoursRemaining: 2 } });
    const worker = w.citizens.add(newCitizen(home));
    assignJobs(w);
    expect(worker.workplace).toBeNull();
  });

  it('aWorkerLosesTheJobWhenTheWorkplaceIsGone', () => {
    const w = worldOn(new MapGrid(16, 16));
    const home = w.buildings.add(building('Residential', t(0, 0), 0, 'Middle'));
    const shop = w.buildings.add(building('Commercial', t(8, 0), 5, 'Middle'));
    const worker = w.citizens.add({ ...newCitizen(home), workplace: shop.id });

    clearInvalidWorkplaces(w);
    expect(worker.workplace, 'the workplace still stands').toBe(shop.id);

    w.buildings.remove(shop.id);
    clearInvalidWorkplaces(w);
    expect(worker.workplace).toBeNull();
  });
});
