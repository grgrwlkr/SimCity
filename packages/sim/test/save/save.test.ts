// Save v1. The six Rust tests are ported from rust-final crates/simcity_data/src/game/persistence.rs
// (`budget_save_tests`) and crates/simcity_data/src/game/config_loader.rs; RON gives way to JSON.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { monthlyPayment } from '../../src/economy/economy';
import { fingerprint, fingerprintSections } from '../../src/fingerprint';
import { SaveError, SAVE_VERSION, loadWorld, parseSave, saveWorld, worldFromSave, type SaveFile } from '../../src/save/save';
import type { SaveNode } from '../../src/save/codec';
import { LivingCityScenario } from '../../src/scenarios/livingCity';
import { requestState } from '../../src/state';
import { SECOND_NS } from '../../src/timer';
import { spawnVehicle } from '../../src/traffic/vehicles';
import { createWorld, type World } from '../../src/world';
import { SIZED_IN_TICKS } from '../scenarios/sizedInTicks';

type Fields = Record<string, SaveNode>;
const worldFields = (file: SaveFile): Fields => file.world as Fields;
const classFields = (node: SaveNode | undefined): Fields => (node as { v: Fields }).v;

let exercised: { readonly world: World; readonly text: string } | null = null;

/**
 * A living city an hour in, a game hour a minute long, with something in every section of the fingerprint; built
 * once, and each test takes its own copy by loading the save.
 */
function exercisedWorld(): World {
  if (exercised === null) {
    const w = createWorld({ gameHourNs: 60 * SECOND_NS });
    requestState(w, 'InGame');
    frame(w, 0);
    new LivingCityScenario(w);
    step(w, 700);
    // What a living city leaves empty between ticks: a queued command, an undo step, a micro vehicle, an event, a toast.
    w.commands.push({ kind: 'SetZone', pos: { x: 1, y: 1 }, zone: 'Residential', density: 'High' });
    w.history.push({ kind: 'SetZone', pos: { x: 0, y: 0 }, old: 'None', new: 'Residential', oldDensity: 'Medium', newDensity: 'Medium' });
    spawnVehicle(w, { route: [{ x: 0, y: 0 }] });
    w.pendingEvents.dayAdvanced.push(2);
    w.notifications.add('Fire emergency', 'Warning', 5);
    exercised = { world: w, text: saveWorld(w) };
  }
  return loadWorld(exercised.text);
}

describe('save', () => {
  it('everySectionOfTheFingerprintComesBackFromTheSave', () => {
    const back = exercisedWorld();
    const { world: w, text } = exercised!;
    const after = fingerprintSections(back);
    // The sections come from fingerprint.ts: a new one is checked here without touching this test.
    for (const [i, section] of fingerprintSections(w).entries()) {
      expect(after[i]!.name).toBe(section.name);
      expect(after[i]!.digest, `section ${section.name} differs after a save and a load`).toBe(section.digest);
    }
    expect(fingerprint(back)).toBe(fingerprint(w));
    expect(saveWorld(back) === text, 'a loaded world saves to the file it came from').toBe(true);
  }, SIZED_IN_TICKS);

  it('aSectionTheSaveDoesNotCarryFailsTheCheck', () => {
    // Mirror of `fingerprintCoversEveryStateField`. A load starts from a fresh world: a section the save lost would
    // come back as the fresh world has it. So every section of the test world must differ from the fresh one, or the
    // check above would pass on a section the file does not carry.
    const w = exercisedWorld();
    const fresh = fingerprintSections(createWorld({ gameHourNs: w.gameHourNs }));
    fingerprintSections(w).forEach((section, i) => {
      expect(fresh[i]!.name).toBe(section.name);
      expect(section.digest, `section ${section.name} is as a fresh world has it: the test world must exercise it`).not.toBe(fresh[i]!.digest);
    });
  }, SIZED_IN_TICKS);

  it('stateBeyondTheFingerprintComesBackToo', () => {
    // The fingerprint equal is the gate; the same future is the point: ten more game minutes on both.
    const w = exercisedWorld();
    const back = loadWorld(saveWorld(w));
    step(w, 600);
    step(back, 600);
    expect(fingerprint(back)).toBe(fingerprint(w));
  }, SIZED_IN_TICKS);

  it('aBrokenFileIsRejectedWithAClearError', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    const text = saveWorld(w);
    const file = JSON.parse(text) as { version: number; world: Fields };
    const broken = (edit: (f: typeof file) => void): string => {
      const copy = JSON.parse(text) as typeof file;
      edit(copy);
      return JSON.stringify(copy);
    };
    expect(file.version).toBe(SAVE_VERSION);
    expect(() => loadWorld(text.slice(0, text.length / 2))).toThrow(/^save rejected: not JSON/);
    expect(() => loadWorld(broken((f) => void (f.version = 2)))).toThrow(/^save rejected: version: /);
    expect(() => loadWorld('(save_version: 3, seed: 1)')).toThrow(SaveError);
    expect(() => loadWorld(broken((f) => void (classFields(f.world.grid).elevation = { $: 'ta', t: 'Uint9Array', v: '' } as unknown as SaveNode)))).toThrow(
      /^save rejected: world\.grid\.v\.elevation\.t: Invalid option/,
    );
    expect(() => loadWorld(broken((f) => void (classFields(f.world.grid).elevation = { $: 'ta', t: 'Uint8Array', v: 'A*==' })))).toThrow(
      /^save rejected: world\.grid\.elevation: "\*" at 1 is not base64$/,
    );
    expect(() => loadWorld(broken((f) => void ((f.world.grid as { c: string }).c = 'Grid')))).toThrow(/^save rejected: world\.grid: unknown class "Grid"$/);
    expect(() => loadWorld(broken((f) => void (f.world.tick = { $: 'ref', id: 99 })))).toThrow(/^save rejected: world\.tick: refers to object #99/);
  });

  it('whatCannotComeBackFailsTheSave', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    (w as unknown as Record<string, unknown>).stray = { cb: () => 1 };
    expect(() => saveWorld(w)).toThrow(/^world\.stray\.cb: a function cannot be saved$/);
    (w as unknown as Record<string, unknown>).stray = new (class Unlisted {})();
    expect(() => saveWorld(w)).toThrow(/^world\.stray: an instance of a class missing from SAVED_CLASSES/);
  });

  it('budgetReportTheBudgetIsPartOfTheSave', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.taxRates.set('Industrial', 'Low', 15);
    w.serviceFunding.set('Police', 70);
    w.loans.active.push({ principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 7 });
    const world = worldFields(parseSave(saveWorld(w)));
    expect(classFields(world.taxRates).percent).toEqual(w.taxRates.percent);
    expect(classFields(world.serviceFunding).percent).toEqual(w.serviceFunding.percent);
    expect(classFields(world.loans).active, 'a save that forgets the debt lets a load erase it').toEqual(w.loans.active);
  });

  it('milestoneReachedMilestonesComeBackWithASave', () => {
    // A reached milestone comes back even when the city shrank since. The Rust test's second half (a save from
    // before milestones counts its population as reached) has no v1 counterpart: every v1 save carries milestones.
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.milestones.reach(300);
    w.city.population = 120;
    const back = loadWorld(saveWorld(w));
    expect(back.milestones.bestPopulation).toBe(300);
    expect(back.city.population).toBe(120);
  });

  it('budgetReportLoadingRestoresTheBudget', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.taxRates.set('Industrial', 'Low', 15);
    w.serviceFunding.set('Police', 70);
    w.loans.active.push({ principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 7 });
    const live = loadWorld(saveWorld(w));
    expect(live.taxRates.get('Industrial', 'Low')).toBe(15);
    expect(live.taxRates.percent).toEqual(w.taxRates.percent);
    expect(live.serviceFunding.get('Police')).toBe(70);
    expect(live.loans.active).toEqual([{ principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 7 }]);
  });

  it('zoneDensitySurvivesTheSaveAndAnOldSaveZonesAtMedium', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    const pos = { x: 2, y: 1 };
    w.grid.set(pos, { ...w.grid.get(pos)!, zone: 'Residential', density: 'High' });
    const text = saveWorld(w);
    expect(loadWorld(text).grid.get(pos)!.density).toBe('High');

    // A save written before the grid had densities: the layer falls back to the fresh map's, all Medium.
    const file = parseSave(text);
    const grid = classFields(worldFields(file).grid);
    expect(grid.density, 'the saved grid names its densities').toBeDefined();
    delete grid.density;
    const legacy = worldFromSave(file);
    expect(legacy.grid.get(pos)!.zone).toBe('Residential');
    expect(legacy.grid.get(pos)!.density).toBe('Medium');
  });

  it('savegameRoundtripsThroughJson', () => {
    // A FourLane cell with every field off its default, a lit intersection, a changed rate and an open loan.
    const w = exercisedWorld();
    expect(w.trafficLights.length, 'the living city lights its crossings').toBeGreaterThan(0);
    const pos = { x: 1, y: 0 };
    const road = { kind: 'FourLane', dir: 'West', lane: 3, flow: { kind: 'OneWay', dir: 'West' }, laneType: 'LeftTurnOnly' } as const;
    w.grid.set(pos, { ...w.grid.get(pos)!, height: 7, road });
    w.taxRates.set('Commercial', 'High', 14);
    w.loans.active.push({ principal: 10_000, monthlyPayment: 889, monthsLeft: 5 });

    const back = loadWorld(saveWorld(w));
    expect(back.trafficLights).toEqual(w.trafficLights);
    expect([...back.intersections.trafficLightKeys]).toEqual([...w.intersections.trafficLightKeys]);
    expect(back.taxRates.get('Commercial', 'High')).toBe(14);
    expect(back.loans.active.length, 'open loans survive the file').toBe(w.loans.active.length);
    expect(back.grid.get(pos)!.road).toEqual(road);
    expect(back.grid.get(pos)!.height).toBe(7);
  }, SIZED_IN_TICKS);

  it('savegameOldSaveCompatMissingTrafficLights', () => {
    // A save without its traffic lights still loads, with none: an additive field takes the fresh world's value.
    const w = exercisedWorld();
    const file = parseSave(saveWorld(w));
    delete worldFields(file).trafficLights;
    delete classFields(worldFields(file).intersections).trafficLightKeys;
    const back = worldFromSave(file);
    expect(back.trafficLights).toEqual([]);
    expect(back.intersections.trafficLightKeys.size).toBe(0);
    expect(back.tick).toBe(w.tick);
  }, SIZED_IN_TICKS);
});
