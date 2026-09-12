// Port of the tests in crates/simcity_sim/src/game/employment.rs, and of what they left untested: who gets
// which job, and a job lost with its workplace.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../src/app';
import { newBuilding, type Building } from '../src/buildings/building';
import { newCitizen } from '../src/citizens';
import type { BuildingKind, RoadCell, TilePos } from '../src/commands';
import type { WealthClass } from '../src/economy/wealth';
import { assignJobs, classJobMatches, clearInvalidWorkplaces, computeEmploymentStats } from '../src/employment';
import { MapGrid } from '../src/map/grid';
import { roadSegmentCommands } from '../src/map/roadTool';
import { requestState } from '../src/state';
import { createWorld, type World } from '../src/world';
import { t, worldOn } from './buildings/helpers';

function building(kind: BuildingKind, anchor: TilePos, jobs: number, wealth: WealthClass): Building {
  return newBuilding({ kind, anchor, capacityJobs: jobs, profile: { density: 'Medium', class: wealth } });
}

const workplace = (w: World, ref: number) => w.citizens.view(ref)!.workplace;

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

    expect(workplace(w, first), 'the one middle-class job the road reaches').toBe(shop.id);
    expect(workplace(w, second), 'its one job is taken and the low-class shop is not for them').toBeNull();
    expect(w.citizens.workersOf(shop.id)).toBe(1);
  });

  // Stage 3½b: by the district travel times, not by the tiles of a path. The shop down the street is 110 tiles away at
  // 40 km/h; the works on the arterial takes a longer road, most of it at 60 km/h, and is reached sooner.
  it('aWorkerTakesTheJobNearestByTravelTime', () => {
    const w = createWorld({ mapWidth: 128, mapHeight: 32 });
    requestState(w, 'InGame');
    frame(w, 0);
    for (const [from, to, kind] of [
      [{ x: 1, y: 8 }, { x: 126, y: 8 }, 'TwoLane'],
      [{ x: 10, y: 7 }, { x: 10, y: 21 }, 'TwoLane'],
      [{ x: 1, y: 20 }, { x: 126, y: 20 }, 'FourLane'],
    ] as const) {
      w.commands.push(...roadSegmentCommands(from, to, kind, w.trafficConfig.driveOnRight, false));
    }
    // The commands apply after the frame, the graphs on the next tick, sixteen rows of times over the four after it.
    step(w, 8);
    const home = w.buildings.add(building('Residential', t(4, 9), 0, 'Middle'));
    w.buildings.add(building('Commercial', t(118, 9), 5, 'Middle'));
    const works = w.buildings.add(building('Industrial', t(118, 22), 5, 'Middle'));
    const worker = w.citizens.add(newCitizen(home));

    assignJobs(w);

    expect(workplace(w, worker)).toBe(works.id);
  });

  it('noOneWorksAtABuildingStillUnderConstruction', () => {
    const w = town();
    const home = w.buildings.add(building('Residential', t(2, 6), 0, 'Middle'));
    w.buildings.add({ ...building('Commercial', t(20, 6), 5, 'Middle'), phase: { kind: 'UnderConstruction', hoursRemaining: 2 } });
    const worker = w.citizens.add(newCitizen(home));
    assignJobs(w);
    expect(workplace(w, worker)).toBeNull();
  });

  it('aWorkerLosesTheJobWhenTheWorkplaceIsGone', () => {
    const w = worldOn(new MapGrid(16, 16));
    const home = w.buildings.add(building('Residential', t(0, 0), 0, 'Middle'));
    const shop = w.buildings.add(building('Commercial', t(8, 0), 5, 'Middle'));
    const worker = w.citizens.add({ ...newCitizen(home), workplace: shop.id });

    clearInvalidWorkplaces(w);
    expect(workplace(w, worker), 'the workplace still stands').toBe(shop.id);

    w.buildings.remove(shop.id);
    clearInvalidWorkplaces(w);
    expect(workplace(w, worker)).toBeNull();
    expect(w.citizens.workersOf(shop.id)).toBe(0);
  });
});
