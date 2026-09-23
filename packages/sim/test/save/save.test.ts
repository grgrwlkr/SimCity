// Save v1. The six Rust tests are ported from rust-final crates/simcity_data/src/game/persistence.rs
// (`budget_save_tests`) and crates/simcity_data/src/game/config_loader.rs under their names; the format is JSON, not
// RON, and where a Rust test leans on RON or on `#[serde(default)]` its comment says what stands in for it.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { monthlyPayment } from '../../src/economy/economy';
import { fingerprint, fingerprintSections } from '../../src/fingerprint';
import { SaveError, SAVE_VERSION, loadWorld, parseSave, saveWorld, worldFromSave, type SaveFile, type SaveMigration } from '../../src/save/save';
import type { SaveNode } from '../../src/save/codec';
import { LivingCityScenario } from '../../src/scenarios/livingCity';
import { requestState } from '../../src/state';
import { SECOND_NS } from '../../src/timer';
import { spawnVehicle } from '../../src/traffic/vehicles';
import { createWorld, type World } from '../../src/world';
import { SIZED_IN_TICKS } from '../scenarios/sizedInTicks';

type Fields = Record<string, SaveNode>;
type Json = Record<string, unknown> & { version: number; world: Fields };
const worldFields = (file: SaveFile): Fields => file.world as Fields;
const classFields = (node: unknown): Fields => (node as { v: Fields }).v;

/** The text of `text` after `edit`, on a copy. */
const edited = (text: string, edit: (file: Json) => void): string => {
  const file = JSON.parse(text) as Json;
  edit(file);
  return JSON.stringify(file);
};

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
    // Mirror of `fingerprintCoversEveryStateField`. A section is only checked above if the test world has moved it off
    // a fresh world's value; a field the save lost is caught below whatever its value (a load is strict).
    const w = exercisedWorld();
    const fresh = fingerprintSections(createWorld({ gameHourNs: w.gameHourNs }));
    fingerprintSections(w).forEach((section, i) => {
      expect(fresh[i]!.name).toBe(section.name);
      expect(section.digest, `section ${section.name} is as a fresh world has it: the test world must exercise it`).not.toBe(fresh[i]!.digest);
    });
  }, SIZED_IN_TICKS);

  it('aSaveMissingAFieldOrWithAWrongOneIsRejectedWithItsPath', () => {
    // A field at its fresh value (`citizens.jobSeekers` is empty in the test world) would pass the section check: the
    // strict load catches it instead, as any missing, extra or mistyped field of the world and its resources.
    const text = saveWorld(createWorld({ mapWidth: 8, mapHeight: 8 }));
    const cases: Array<readonly [string, (f: Json) => void, RegExp]> = [
      ['no citizens.jobSeekers', (f) => void delete classFields(f.world.citizens).jobSeekers, /^save rejected: world\.citizens\.jobSeekers: missing$/],
      ['no citizens', (f) => void delete f.world.citizens, /^save rejected: world\.citizens: missing$/],
      ['no buildings', (f) => void delete f.world.buildings, /^save rejected: world\.buildings: missing$/],
      ['an empty world', (f) => void (f.world = {}), /^save rejected: world\.\w+: missing$/],
      ['tick a string', (f) => void (f.world.tick = 'abc'), /^save rejected: world\.tick: expected number, found string$/],
      ['an extra field', (f) => void (f.world.extra = 1), /^save rejected: world\.extra: no such field in the world$/],
      ['the grid a Timer', (f) => void ((f.world.grid as { c: string }).c = 'Timer'), /^save rejected: world\.grid: expected class MapGrid, found class Timer$/],
      ['the grid a number', (f) => void (f.world.grid = 5), /^save rejected: world\.grid: expected class MapGrid, found number$/],
      [
        'a layer the wrong type',
        (f) => void (classFields(f.world.grid).elevation = { $: 'ta', t: 'Int8Array', v: '' }),
        /^save rejected: world\.grid\.elevation: expected Uint8Array, found Int8Array$/,
      ],
      ['a layer of 3 tiles', (f) => void (classFields(f.world.grid).elevation = { $: 'ta', t: 'Uint8Array', v: 'AAAA' }), /^save rejected: world\.grid: a layer of 3 tiles on a map of 64$/],
      ['options for another map', (f) => void ((f.options as { mapWidth: number }).mapWidth = 16), /^save rejected: options\.mapWidth: 16, but the world saved has 8$/],
    ];
    for (const [what, edit, message] of cases) expect(() => loadWorld(edited(text, edit)), what).toThrow(message);
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
    const text = saveWorld(createWorld({ mapWidth: 8, mapHeight: 8 }));
    expect((JSON.parse(text) as Json).version).toBe(SAVE_VERSION);
    expect(() => loadWorld(text.slice(0, text.length / 2))).toThrow(/^save rejected: not JSON/);
    expect(() => loadWorld(edited(text, (f) => void (f.version = 2)))).toThrow(/^save rejected: version: /);
    expect(() => loadWorld('(save_version: 3, seed: 1)')).toThrow(SaveError);
    expect(() => loadWorld(edited(text, (f) => void (classFields(f.world.grid).elevation = { $: 'ta', t: 'Uint9Array', v: '' })))).toThrow(
      /^save rejected: world\.grid\.elevation\.t: Invalid option/,
    );
    expect(() => loadWorld(edited(text, (f) => void (classFields(f.world.grid).elevation = { $: 'ta', t: 'Uint8Array', v: 'A*==' })))).toThrow(
      /^save rejected: world\.grid\.elevation: "\*" at 1 is not base64$/,
    );
    expect(() => loadWorld(edited(text, (f) => void ((f.world.grid as { c: string }).c = 'Grid')))).toThrow(/^save rejected: world\.grid: unknown class "Grid"$/);
    expect(() => loadWorld(edited(text, (f) => void (f.world.tick = { $: 'ref', id: 99 })))).toThrow(/^save rejected: world\.tick: refers to object #99/);
  }, SIZED_IN_TICKS);

  it('whatCannotComeBackFailsTheSave', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    (w as unknown as Record<string, unknown>).stray = { cb: () => 1 };
    expect(() => saveWorld(w)).toThrow(/^world\.stray\.cb: a function cannot be saved$/);
    (w as unknown as Record<string, unknown>).stray = new (class Unlisted {})();
    expect(() => saveWorld(w)).toThrow(/^world\.stray: an instance of a class missing from SAVED_CLASSES/);
  }, SIZED_IN_TICKS);

  it('anOlderVersionLoadsOnlyThroughItsMigration', () => {
    const text = saveWorld(createWorld({ mapWidth: 4, mapHeight: 4 }));
    const v0 = edited(text, (f) => void (f.version = 0));
    expect(() => loadWorld(v0), 'v1 is the first TS save: nothing migrates to it yet').toThrow(/^save rejected: version: 0 is older than 1 and no migration takes it further$/);
    expect(() => parseSave(v0, { 0: (f) => f })).toThrow(/^save rejected: version: the migration from 0 did not raise it$/);
    expect(worldFromSave(parseSave(v0, { 0: (f) => ({ ...f, version: 1 }) })).grid.width).toBe(4);
  }, SIZED_IN_TICKS);

  it('budgetReportTheBudgetIsPartOfTheSave', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.taxRates.set('Industrial', 'Low', 15);
    w.serviceFunding.set('Police', 70);
    w.loans.active.push({ principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 7 });
    const world = worldFields(parseSave(saveWorld(w)));
    expect(classFields(world.taxRates).percent).toEqual(w.taxRates.percent);
    expect(classFields(world.serviceFunding).percent).toEqual(w.serviceFunding.percent);
    expect(classFields(world.loans).active, 'a save that forgets the debt lets a load erase it').toEqual(w.loans.active);
  }, SIZED_IN_TICKS);

  it('milestoneReachedMilestonesComeBackWithASave', () => {
    // A reached milestone comes back even when the city shrank since. The Rust test's second half, a save from before
    // milestones counting its population as reached, would be a migration step; v1 has no older save, and a v1 save
    // without milestones is refused.
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    w.milestones.reach(300);
    w.city.population = 120;
    const text = saveWorld(w);
    const back = loadWorld(text);
    expect(back.milestones.bestPopulation).toBe(300);
    expect(back.city.population).toBe(120);
    expect(() => loadWorld(edited(text, (f) => void delete f.world.milestones))).toThrow(/^save rejected: world\.milestones: missing$/);
  }, SIZED_IN_TICKS);

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
  }, SIZED_IN_TICKS);

  it('zoneDensitySurvivesTheSaveAndAnOldSaveZonesAtMedium', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    const pos = { x: 2, y: 1 };
    w.grid.set(pos, { ...w.grid.get(pos)!, zone: 'Residential', density: 'High' });
    const text = saveWorld(w);
    expect(loadWorld(text).grid.get(pos)!.density).toBe('High');

    // Rust parsed a tile saved before densities with `#[serde(default)]` Medium. In v1 a grid without its densities is
    // refused, and an older save gets them from its migration step: here a v0 fixture and a step that zones it Medium.
    expect(() => loadWorld(edited(text, (f) => void delete classFields(f.world.grid).density))).toThrow(/^save rejected: world\.grid\.density: missing$/);
    const v0 = edited(text, (f) => {
      f.version = 0;
      delete classFields(f.world.grid).density;
    });
    const mediumLayer = classFields(worldFields(parseSave(saveWorld(createWorld({ mapWidth: 4, mapHeight: 4 })))).grid).density!;
    const zoneAtMedium: SaveMigration = (f) => {
      const file = f as Json;
      classFields(file.world.grid).density = mediumLayer;
      return { ...file, version: 1 };
    };
    const legacy = worldFromSave(parseSave(v0, { 0: zoneAtMedium }));
    expect(legacy.grid.get(pos)!.zone).toBe('Residential');
    expect(legacy.grid.get(pos)!.density).toBe('Medium');
  }, SIZED_IN_TICKS);

  it('savegameV3RoundtripsThroughRon', () => {
    // RON is JSON here. A FourLane cell with every field off its default, a lit intersection, a changed rate and a loan.
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

  it('savegameV3OldSaveCompatMissingTrafficLights', () => {
    // Rust took a V3 save without `traffic_light_tiles` through `#[serde(default)]`. In v1 the same file is refused;
    // an older version without lights loads through its migration step, which gives it none.
    const w = exercisedWorld();
    const text = saveWorld(w);
    const unlit = (f: Json) => {
      delete f.world.trafficLights;
      delete classFields(f.world.intersections).trafficLightKeys;
    };
    expect(() => loadWorld(edited(text, unlit))).toThrow(/^save rejected: world\.trafficLights: missing$/);
    const v0 = edited(text, (f) => {
      unlit(f);
      f.version = 0;
    });
    const noLights: SaveMigration = (f) => {
      const file = f as Json;
      classFields(file.world.intersections).trafficLightKeys = { $: 'set', v: [] };
      return { ...file, version: 1, world: { ...file.world, trafficLights: [] } };
    };
    const back = worldFromSave(parseSave(v0, { 0: noLights }));
    expect(back.trafficLights).toEqual([]);
    expect(back.intersections.trafficLightKeys.size).toBe(0);
    expect(back.tick).toBe(w.tick);
  }, SIZED_IN_TICKS);
});
