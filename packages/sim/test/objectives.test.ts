// The scenario catalog of P3: rust-final crates/simcity_data/src/game/scenarios.rs (its one test is ported under its
// name) and the presets of rust-final assets/scenarios/scenarios.ron.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../src/app';
import { fingerprint } from '../src/fingerprint';
import { NEW_GAME_START_HOUR, emptyScenarioProgress, presetById, startScenario, updateScenarioProgress } from '../src/objectives';
import { SAVE_VERSION, loadWorld, saveWorld } from '../src/save/save';
import { SCENARIO_PRESETS } from '../src/scenarios/catalogData';
import { CityCommuteScenario } from '../src/scenarios/cityCommute';
import { LivingCityScenario } from '../src/scenarios/livingCity';
import { SignalizedCrossScenario } from '../src/scenarios/signalizedCross';
import { FIXED_UPDATE } from '../src/schedule';
import { requestState } from '../src/state';
import { SECOND_NS } from '../src/timer';
import { createWorld, type World } from '../src/world';

const f32 = Math.fround;

/** A small world in game with `id` started, its map generated; a game hour is a minute long. */
function started(id: string, seed?: bigint): World {
  const w = createWorld({ mapWidth: 32, mapHeight: 32, gameHourNs: 60 * SECOND_NS });
  requestState(w, 'InGame');
  startScenario(w, presetById(id)!, seed);
  frame(w, 0);
  return w;
}

describe('scenario catalog', () => {
  it('scenarioPresetsAreTheOnesTheGameShipped', () => {
    // rust-final assets/scenarios/scenarios.ron, whole.
    expect(SCENARIO_PRESETS).toEqual([
      { id: 'sandbox', name: 'Sandbox', seed: 1n, startingMoney: 2000, startingDay: 1, objectives: [] },
      {
        id: 'starter',
        name: 'Starter Town',
        seed: 42n,
        startingMoney: 1500,
        startingDay: 1,
        objectives: [
          { kind: 'PopulationAtLeast', target: 50 },
          { kind: 'HappinessAtLeast', target: f32(0.6) },
        ],
      },
    ]);
  });

  it('aScenarioStartsOnItsOwnSeedUnlessOneIsGiven', () => {
    expect(started('sandbox').mapSeed).toBe(1n);
    expect(started('sandbox', 987_654n).mapSeed, 'a new map is the sandbox on the seed the menu rolled').toBe(987_654n);
  });

  it('aScenarioStartsWithItsMoneyAndDayAtEightInTheMorning', () => {
    const w = started('starter');
    expect(w.mapSeed).toBe(42n);
    expect(w.mapEditVersion, 'the map is generated').toBeGreaterThan(0);
    expect([w.city.money, w.city.day, w.city.hour, w.city.minute]).toEqual([1500, 1, NEW_GAME_START_HOUR, 0]);
    expect(NEW_GAME_START_HOUR).toBe(8);
    expect(w.budget.moneyStart, 'the ledger counts from the starting funds').toBe(1500);
    expect(w.scenario).toMatchObject({ activeId: 'starter', activeName: 'Starter Town', objectives: SCENARIO_PRESETS[1]!.objectives });
    // The clock goes on from eight: an hour later it is nine on the same day.
    step(w, 600);
    expect([w.city.day, w.city.hour]).toEqual([1, NEW_GAME_START_HOUR + 1]);
  });

  it('objectivesAreMetAtLeastAtTheirTarget', () => {
    const w = started('starter');
    w.city.population = 49;
    w.city.happiness = f32(0.6);
    updateScenarioProgress(w);
    expect(w.scenario).toMatchObject({ met: [false, true], objectivesCompleted: 1, isCompleted: false });
    w.city.population = 50;
    updateScenarioProgress(w);
    expect(w.scenario).toMatchObject({ met: [true, true], objectivesCompleted: 2, isCompleted: true });
    // Not kept once met, as in Rust: progress is the city now.
    w.city.happiness = f32(0.59);
    updateScenarioProgress(w);
    expect(w.scenario).toMatchObject({ met: [true, false], objectivesCompleted: 1, isCompleted: false });
  });

  it('moneyAtLeastReadsTheTreasury', () => {
    const w = started('sandbox');
    w.scenario.objectives = [{ kind: 'MoneyAtLeast', target: 2500 }];
    w.city.money = 2499;
    updateScenarioProgress(w);
    expect(w.scenario.met).toEqual([false]);
    w.city.money = 2500;
    updateScenarioProgress(w);
    expect(w.scenario).toMatchObject({ met: [true], isCompleted: true });
  });

  it('aScenarioWithoutObjectivesIsNeverCompleted', () => {
    const w = started('sandbox');
    updateScenarioProgress(w);
    expect(w.scenario).toMatchObject({ activeId: 'sandbox', met: [], objectivesCompleted: 0, isCompleted: false });
  });

  it('progressIsCountedByTheFixedTick', () => {
    const entry = FIXED_UPDATE.find((s) => s.name === 'updateScenarioProgress');
    expect(entry, 'a system of FixedUpdate').toBeDefined();
    const names = FIXED_UPDATE.map((s) => s.name);
    // Reads the population just recomputed and the treasury and happiness after the daily economy.
    expect(names.indexOf('updateScenarioProgress')).toBeGreaterThan(names.indexOf('updateCityPopulation'));
    expect(names.indexOf('updateScenarioProgress')).toBeGreaterThan(names.indexOf('applyDailyEconomy'));
    const w = started('starter');
    w.city.population = 50;
    w.city.happiness = f32(0.7);
    step(w, 1);
    expect(w.scenario.isCompleted).toBe(true);
  });

  it('aSavedScenarioLoadsWithItsObjectivesAndProgress', () => {
    const w = started('starter');
    w.city.population = 60;
    step(w, 1);
    const back = loadWorld(saveWorld(w));
    expect(back.scenario).toEqual(w.scenario);
    expect(fingerprint(back)).toBe(fingerprint(w));
    step(w, 50);
    step(back, 50);
    expect(back.scenario).toEqual(w.scenario);
    expect(fingerprint(back)).toBe(fingerprint(w));
  });

  it('aScenarioKeepsItsRuntimeInTheWorldItIsBuiltInto', () => {
    const builds: Array<readonly [string, (w: World) => object]> = [
      ['LivingCityScenario', (w) => new LivingCityScenario(w)],
      ['CityCommuteScenario', (w) => new CityCommuteScenario(w, { citizens: 3 })],
      ['SignalizedCrossScenario', (w) => new SignalizedCrossScenario(w)],
    ];
    for (const [name, build] of builds) {
      const w = createWorld();
      expect(build(w), name).toBe(w.scenarioRuntime);
    }
  });

  it('aSaveOfVersion1LoadsWithoutAScenario', () => {
    expect(SAVE_VERSION).toBe(2);
    const w = createWorld({ mapWidth: 16, mapHeight: 16 });
    requestState(w, 'InGame');
    frame(w, 0);
    step(w, 20);
    // A save of the main branch before P3: the same world without the two fields of the scenario.
    const file = JSON.parse(saveWorld(w)) as { version: number; world: Record<string, unknown> };
    delete file.world.scenario;
    delete file.world.scenarioRuntime;
    file.version = 1;
    const back = loadWorld(JSON.stringify(file));
    expect(back.scenario).toEqual(emptyScenarioProgress());
    expect(back.scenarioRuntime).toBeNull();
    expect(fingerprint(back)).toBe(fingerprint(w));
    // Of version 2 the fields are required: a file without them is broken, not old.
    file.version = 2;
    expect(() => loadWorld(JSON.stringify(file))).toThrow(/^save rejected: world\.scenario: missing$/);
  });

  it('aSavedRuntimeIsOneOfTheScenariosOrNothing', () => {
    const w = started('starter');
    w.scenarioRuntime = new CityCommuteScenario(w, { citizens: 3 });
    const text = saveWorld(w);
    expect(loadWorld(text).scenarioRuntime).toBeInstanceOf(CityCommuteScenario);
    const edited = (edit: (world: Record<string, unknown>) => void): string => {
      const file = JSON.parse(text) as { world: Record<string, unknown> };
      edit(file.world);
      return JSON.stringify(file);
    };
    const cases: Array<readonly [string, (world: Record<string, unknown>) => void, RegExp]> = [
      ['a plain object', (f) => void (f.scenarioRuntime = { hello: 1 }), /^save rejected: world\.scenarioRuntime: expected a scenario runtime, found object$/],
      ['another saved class', (f) => void (f.scenarioRuntime = f.milestones), /^save rejected: world\.scenarioRuntime: expected a scenario runtime, found class Milestones$/],
      [
        'a runtime with a stray field',
        (f) => void ((f.scenarioRuntime as { v: Record<string, unknown> }).v.hello = 1),
        /^save rejected: world\.scenarioRuntime\.hello: no such field in the world$/,
      ],
      [
        'a runtime without its commuters',
        (f) => void delete (f.scenarioRuntime as { v: Record<string, unknown> }).v.commuters,
        /^save rejected: world\.scenarioRuntime\.commuters: missing$/,
      ],
    ];
    for (const [what, edit, message] of cases) expect(() => loadWorld(edited(edit)), what).toThrow(message);
  });
});
