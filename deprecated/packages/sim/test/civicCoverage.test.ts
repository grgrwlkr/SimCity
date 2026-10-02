// Port of the tests in crates/simcity_sim/src/game/civic_coverage.rs: one-row maps with coverage and the city fields
// computed in one pass (64 tiles are one chunk of the fields).
import { describe, expect, it } from 'vitest';
import { newBuilding, serviceRadius, type Building } from '../src/buildings/building';
import { computeCityFields } from '../src/cityFieldsCompute';
import { PARK_HEALTH, SCHOOL_EDUCATION, civicStrength, updateCivicCoverage } from '../src/civicCoverage';
import type { BuildingKind } from '../src/commands';
import type { WealthClass } from '../src/economy/wealth';
import { emptyEvents } from '../src/events';
import { createWorld, type World } from '../src/world';

const t = (x: number, y: number) => ({ x, y });
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-5;

function row(width: number): World {
  const w = createWorld({ mapWidth: width, mapHeight: 1 });
  w.appState = 'InGame';
  return w;
}

const open = (kind: BuildingKind, x: number): Building => newBuilding({ kind, anchor: t(x, 0) });

function home(x: number, residents: number, wealth: WealthClass = 'Middle'): Building {
  return newBuilding({
    kind: 'Residential',
    anchor: t(x, 0),
    capacityResidents: residents,
    occupancyResidents: residents,
    targetOccupancyResidents: residents,
    profile: { density: 'Medium', class: wealth },
  });
}

/** `(compute_civic_coverage, compute_city_fields).chain()`, then the tick's events are gone. */
function update(w: World): void {
  updateCivicCoverage(w);
  computeCityFields(w);
  w.events = emptyEvents();
}

describe('civic coverage', () => {
  it('serviceBuildingAnOvercrowdedSchoolTeachesLess', () => {
    expect(civicStrength(400, 0)).toBe(1);
    expect(civicStrength(400, 400)).toBe(1);
    expect(near(civicStrength(400, 800), 0.5)).toBe(true);
    expect(near(civicStrength(400, 1600), 0.25)).toBe(true);
  });

  it('serviceBuildingASchoolRaisesEducationWithinItsRadius', () => {
    const w = row(64);
    w.buildings.add(open('School', 0));
    w.buildings.add(newBuilding({ kind: 'School', anchor: t(44, 0), phase: { kind: 'UnderConstruction', hoursRemaining: 48 } }));
    update(w);

    const radius = serviceRadius('School')!;
    const coverage = w.civicCoverage;
    expect(coverage.covers(64)).toBe(true);
    expect(coverage.get('School', 10)).toBe(1);
    expect(coverage.get('School', radius), 'the edge of the radius').toBe(1);
    expect(coverage.get('School', radius + 1), 'just past it').toBe(0);
    expect(coverage.get('School', 50), 'a school under construction reaches nobody').toBe(0);
    expect(coverage.sources, 'only the open school is a source').toHaveLength(1);

    const fields = w.cityFields;
    expect(near(fields.get('Education', 10), SCHOOL_EDUCATION), `education within the radius: ${fields.get('Education', 10)}`).toBe(true);
    expect(fields.get('Education', 40), 'and none outside it').toBe(0);
  });

  it('serviceBuildingAParkRaisesHealthNearby', () => {
    const w = row(32);
    w.buildings.add(open('Park', 0));
    update(w);
    const [inside, outside] = [w.cityFields.get('Health', 4), w.cityFields.get('Health', 20)];
    expect(near(inside - outside, PARK_HEALTH), `health beside the park ${inside}, away from it ${outside}`).toBe(true);
  });

  it('serviceBuildingASchoolCrowdedByTheHomesAroundItReachesWithLessStrength', () => {
    const w = row(64);
    w.buildings.add(open('School', 0));
    // Low-class homes bring no schooling of their own, so the education below is the school's.
    w.buildings.add(home(5, 800, 'Low'));
    w.buildings.add(home(50, 800, 'Low'));
    update(w);

    const coverage = w.civicCoverage;
    expect(near(coverage.get('School', 10), 0.5)).toBe(true);
    expect(coverage.sources).toEqual([{ kind: 'School', anchor: t(0, 0), capacity: 400, residents: 800, strength: 0.5 }]);
    expect(near(w.cityFields.get('Education', 10), SCHOOL_EDUCATION * 0.5)).toBe(true);
  });

  it('serviceBuildingCoverageFollowsTheResidentsDayByDay', () => {
    const w = row(64);
    w.buildings.add(open('School', 0));
    const house = w.buildings.add(home(5, 400));
    update(w);
    expect(w.civicCoverage.get('School', 10)).toBe(1);

    house.occupancyResidents = 1600;
    update(w);
    expect(w.civicCoverage.get('School', 10), 'within a day the coverage stands').toBe(1);

    w.events.dayAdvanced.push(2);
    update(w);
    expect(near(w.civicCoverage.get('School', 10), 0.25)).toBe(true);

    house.occupancyResidents = 400;
    w.mapEditVersion += 1;
    update(w);
    expect(w.civicCoverage.get('School', 10), 'a map edit recomputes too').toBe(1);
  });
});
