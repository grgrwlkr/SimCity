// The worker's side of `observe` (E3): the sections of the city a live check judges a run by, read from one tick of the
// world. Carries the tests of rust-final crates/simcity_debug/src/game/live/observe.rs that apply to the port: the
// sections the snapshot does not already carry, the tile the pointer rests on given as `at` (the pointer lives on the
// main thread), and the refusal of a malformed parameter instead of a silent default.
import {
  CIVIC_KINDS,
  UtilitySupply,
  createWorld,
  fingerprint,
  newBuilding,
  tileDiagnosis,
  toHex64,
  utilityMask,
  type World,
} from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { profileHeight } from '../../render/src/buildingLook';
import { OBSERVE_SECTIONS, observeWorld } from '../src/requests/observe';

const at = (x: number, y: number) => ({ x, y });

function world(size = 24): World {
  return createWorld({ mapWidth: size, mapHeight: size });
}

describe('observe request', () => {
  /** A section asked for is always there: a caller never has to guess whether the city has none or the call forgot. */
  it('theAnswerAlwaysCarriesEverySection', () => {
    const w = world();
    const reply = observeWorld(w, { sections: OBSERVE_SECTIONS, at: at(3, 3), tool: { kind: 'Park' }, region: [0, 0, 5, 5] });
    for (const section of OBSERVE_SECTIONS) expect(reply[section], section).toBeDefined();
    expect([reply.tick, reply.day, reply.hour, reply.minute]).toEqual([w.tick, 1, 0, 0]);
    // Only what was asked: the metropolis's building list is not copied for a budget check.
    expect(Object.keys(observeWorld(w, { sections: ['budget'] })).filter((k) => (OBSERVE_SECTIONS as readonly string[]).includes(k))).toEqual(['budget']);
  });

  /** The main menu's empty world answers every section without failing; with no tile named, the per-tile parts are null. */
  it('aWorldWithoutTheGameReportsNullsRatherThanFailing', () => {
    const w = world();
    const before = toHex64(fingerprint(w));
    const reply = observeWorld(w, { sections: OBSERVE_SECTIONS });
    expect(reply.fields!.at).toBeNull();
    expect(reply.supply!.at).toBeNull();
    expect(reply.coverage!.at).toBeNull();
    expect(reply.preview, 'no tile, no preview').toBeNull();
    expect(reply.buildings!.inRegion, 'no region, no listing').toBeNull();
    expect(toHex64(fingerprint(w)), 'observing reads, never writes').toBe(before);
  });

  /** A parameter of the wrong shape is refused, named, rather than dropped into a default the caller did not ask for. */
  it('aMalformedParameterIsRefusedRatherThanIgnored', () => {
    const w = world();
    const bad = (req: unknown) => () => observeWorld(w, req as Parameters<typeof observeWorld>[1]);
    expect(bad({ sections: ['budget', 'weather'] })).toThrow(/weather/);
    expect(bad({ sections: 'budget' })).toThrow(/`sections`/);
    expect(bad({ sections: ['fields'], at: 'here' })).toThrow(/`at`/);
    expect(bad({ sections: ['fields'], at: { x: 1.5, y: 2 } })).toThrow(/`at`/);
    expect(bad({ sections: ['buildings'], region: [1, 2, 3] })).toThrow(/`region`/);
    expect(bad({ sections: ['preview'], at: at(2, 2) })).toThrow(/`tool`/);
    expect(bad({ sections: ['preview'], at: at(2, 2), tool: { kind: 'Teleporter' } })).toThrow(/Teleporter/);
  });

  it('theBudgetIsReportedSoATaxRunCanBeJudged', () => {
    const w = world();
    w.taxRates.set('Residential', 'High', 20);
    w.rciDemand = { residential: -0.3, commercial: 0.2, industrial: 0.1 };
    w.city.money = 1000;
    w.budget.restart(1000);
    w.budget.post('Construction', -40, w.city);
    w.budget.endOfDay(1, w.city);
    w.budget.post('ResidentialTax', 25, w.city);

    const budget = observeWorld(w, { sections: ['budget'] }).budget!;
    expect(budget.taxRates.Residential.High).toBe(20);
    expect(budget.taxRates.Commercial.Low).toBe(w.taxRates.get('Commercial', 'Low'));
    expect(budget.demand.residential).toBeCloseTo(-0.3, 6);
    expect(typeof budget.classDemand.Residential.High).toBe('number');
    expect(budget.month).toBe(1);
    expect(budget.current.ResidentialTax).toBe(25);
    expect(budget.last).toEqual({ month: 0, moneyStart: 1000, moneyEnd: 960, lines: { Construction: -40 } });
  });

  it('utilityNetworkIsReportedSoASupplyRunCanBeJudged', () => {
    const w = world();
    const g = w.grid;
    const served = new Uint8Array(g.len());
    for (let x = 0; x < 24; x++) {
      g.roadKind[g.idx(at(x, 2))!] = 1;
      served[g.idx(at(x, 2))!] = utilityMask('Water');
    }
    // Water reaches the zoned block behind the road, power reaches nothing.
    for (let x = 4; x <= 12; x++) {
      for (let y = 3; y <= 5; y++) {
        g.set(at(x, y), { ...g.get(at(x, y))!, zone: 'Residential' });
        served[g.idx(at(x, y))!] = utilityMask('Water');
      }
    }
    w.utilityNetwork.served = served;
    w.utilityNetwork.version = 3;
    w.rciDemand = { residential: 1, commercial: 0, industrial: 0 };
    w.buildings.add(newBuilding({ kind: 'Residential', anchor: at(4, 3), capacityResidents: 12, occupancyResidents: 4 }));

    const supply = observeWorld(w, { sections: ['supply'], at: at(8, 4) }).supply!;
    expect(supply.version).toBe(3);
    expect(supply.servedTiles).toEqual({ Power: 0, Water: 24 + 27, Garbage: 0 });
    expect(supply.buildingsWithout).toEqual({ Power: 1, Water: 0 });
    expect(supply.at).toEqual({
      tile: at(8, 4),
      built: false,
      blockers: ['NoPower'],
      diagnosis: tileDiagnosis(g, w.utilityNetwork, w.rciDemand, at(8, 4), w.cityFields),
    });
    expect(supply.at!.diagnosis).toEqual(['Residential zone', "Won't grow: No power"]);

    // Over a standing building growth blockers would describe an empty zone the tile is not: only the diagnosis.
    g.set(at(5, 4), { ...g.get(at(5, 4))!, building: 'Residential' });
    const built = observeWorld(w, { sections: ['supply'], at: at(5, 4) }).supply!.at!;
    expect(built.built).toBe(true);
    expect(built.blockers).toBeNull();
    expect(built.diagnosis).toEqual(['Residential zone', 'No power: occupants are leaving']);
  });

  it('utilityNetworkSupplyAndDemandAreReportedSoAShortageRunCanBeJudged', () => {
    const w = world();
    w.utilitySupply.components = UtilitySupply.of([
      { kind: 'Water', supply: 5000, demand: 6200, supplied: 4900 },
      { kind: 'Power', supply: 5000, demand: 1200, supplied: 1200 },
    ]).components;
    const supply = observeWorld(w, { sections: ['supply'] }).supply!.supply;
    expect(supply.Water).toEqual({ supply: 5000, demand: 6200, supplied: 4900, short: true });
    expect(supply.Power.short).toBe(false);
    expect(supply.Garbage).toEqual({ supply: 0, demand: 0, supplied: 0, short: false });
  });

  it('cityFieldsAreReportedSoAGrowthRunCanBeJudged', () => {
    const w = world(2);
    w.cityFields.layOver(4);
    w.cityFields.setValues('Crime', Float32Array.from([0.1, 0.2, 0.3, 0.4]));
    w.landValue.values = Float32Array.from([0.5, 0.6, 0.7, 0.8]);

    const fields = observeWorld(w, { sections: ['fields'], at: at(1, 1) }).fields!;
    expect(fields.coversMap).toBe(true);
    expect(fields.fields.Crime!.min).toBeCloseTo(0.1, 6);
    expect(fields.fields.Crime!.mean).toBeCloseTo(0.25, 6);
    expect(fields.fields.Crime!.max).toBeCloseTo(0.4, 6);
    expect(fields.at!.tile).toEqual(at(1, 1));
    expect(fields.at!.values.Crime).toBeCloseTo(0.4, 6);
    expect(fields.at!.landValue, 'the tile carries its land value').toBeCloseTo(0.8, 6);
    expect(observeWorld(world(2), { sections: ['fields'], at: at(1, 1) }).fields!.at, 'fields not computed yet read as absent').toBeNull();
  });

  /** A placement run reads the verdict for a tile before it sends the command, rather than trying tiles blind. */
  it('toolPreviewIsReportedSoAPlacementRunCanChooseItsTile', () => {
    const w = world(16);
    for (let x = 0; x < 16; x++) w.grid.roadKind[w.grid.idx(at(x, 4))!] = 1;
    w.city.money = 5000;
    const preview = (x: number, y: number) => observeWorld(w, { sections: ['preview'], at: at(x, y), tool: { kind: 'School' } }).preview!;

    const locked = preview(2, 5);
    expect(locked.tool).toEqual({ kind: 'School' });
    expect(locked.tile).toEqual(at(2, 5));
    expect(locked.verdict).toBe('Unlocks at 250 residents');
    expect(locked.cost).toBe(700);
    expect(locked.radius).toBe(18);

    w.milestones.reach(300);
    expect(preview(2, 5).verdict).toBe('ok');
    const onRoad = preview(2, 4).verdict;
    expect(typeof onRoad === 'string' && onRoad !== 'ok', `a road tile is refused with its reason: ${String(onRoad)}`).toBe(true);
    expect(observeWorld(w, { sections: ['preview'], at: at(2, 5), tool: { kind: 'Inspect' } }).preview!.verdict, 'inspect edits nothing').toBeNull();
  });

  it('advisorProblemsAreReportedSoAShortageRunCanBeJudged', () => {
    const w = world();
    w.advisor.version = 4;
    w.advisor.problems = [{ kind: 'WaterShortage', severity: 0.75, text: 'Water shortage', at: at(9, 4) }, { kind: 'NoPower', severity: 0.5, text: 'x', at: null }, { kind: 'NoWater', severity: 0.4, text: 'y', at: null }, { kind: 'Crime', severity: 0.3, text: 'z', at: null }] as World['advisor']['problems'];
    const advisor = observeWorld(w, { sections: ['advisor'] }).advisor!;
    expect(advisor.version).toBe(4);
    expect(advisor.problems[0]).toEqual({ kind: 'WaterShortage', severity: 0.75, text: 'Water shortage', at: at(9, 4) });
    expect(advisor.problems, 'every problem, where the snapshot carries the first three').toHaveLength(4);
  });

  it('milestoneProgressIsReportedSoAnUnlockRunCanBeJudged', () => {
    const w = world();
    w.milestones.reach(300);
    const milestones = observeWorld(w, { sections: ['milestones'] }).milestones!;
    expect(milestones).toEqual({ bestPopulation: 300, next: { population: 1000, unlocks: 'University' }, unlocked: ['School'], locked: ['University'] });
  });

  it('serviceBuildingCivicCoverageIsReportedSoASchoolRunCanBeJudged', () => {
    const w = world(2);
    const civic = w.civicCoverage;
    civic.strength = CIVIC_KINDS.map(() => new Float32Array(4));
    civic.strength[CIVIC_KINDS.indexOf('School')]!.set([1, 0.5]);
    civic.strength[CIVIC_KINDS.indexOf('Park')]![0] = 1;
    civic.sources = [{ kind: 'School', anchor: at(0, 0), capacity: 400, residents: 800, strength: 0.5 }];
    civic.version = 2;

    const coverage = observeWorld(w, { sections: ['coverage'], at: at(1, 0) }).coverage!;
    expect(coverage.version).toBe(2);
    expect(coverage.coversMap).toBe(true);
    expect(coverage.coveredTiles).toEqual({ School: 2, University: 0, Park: 1 });
    expect(coverage.sources).toEqual([{ kind: 'School', anchor: at(0, 0), capacity: 400, residents: 800, strength: 0.5 }]);
    expect(coverage.at).toEqual({ tile: at(1, 0), values: { School: 0.5, University: 0, Park: 0 } });
  });

  it('zoneDensityBuildingsInARegionAreReportedSoADensityRunCanBeJudged', () => {
    const w = world(80);
    const tall = { density: 'High', class: 'High' } as const;
    const house = (x: number, y: number, level: number, profile: typeof tall | { readonly density: 'Low'; readonly class: 'Middle' }) =>
      newBuilding({ kind: 'Residential', anchor: at(x, y), width: 4, length: 4, level, capacityResidents: 30, occupancyResidents: 20, profile });
    w.buildings.add(house(10, 10, 2, tall));
    w.buildings.add(house(40, 10, 1, { density: 'Low', class: 'Middle' }));
    w.buildings.add(newBuilding({ kind: 'PowerPlant', anchor: at(60, 60), width: 4, length: 4 }));

    const buildings = observeWorld(w, { sections: ['buildings'], region: [20, 20, 8, 8] }).buildings!;
    expect(buildings.stations).toEqual([{ kind: 'PowerPlant', anchor: at(60, 60), size: [4, 4] }]);
    expect(buildings.inRegion, 'corners in either order').toHaveLength(1);
    const listed = buildings.inRegion![0]!;
    expect(listed).toMatchObject({ kind: 'Residential', anchor: at(10, 10), size: [4, 4], level: 2, phase: 'Operational', density: 'High', class: 'High', capacityResidents: 30, occupancyResidents: 20 });
    expect(listed.height).toBeCloseTo(profileHeight('Residential', 2, tall), 4);
  });
});
