// Save v1. The six Rust tests are ported from rust-final crates/simcity_data/src/game/persistence.rs
// (`budget_save_tests`) and crates/simcity_data/src/game/config_loader.rs under their names; the format is JSON, not
// RON, and where a Rust test leans on RON or on `#[serde(default)]` its comment says what stands in for it.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { monthlyPayment } from '../../src/economy/economy';
import { fingerprint, fingerprintSections } from '../../src/fingerprint';
import { SaveError, SAVE_MIGRATIONS, SAVE_VERSION, loadWorld, parseSave, saveWorld, worldFromSave, type SaveFile, type SaveMigration } from '../../src/save/save';
import { base64ToBytes, bytesToBase64, type SaveNode, type TypedArrayName } from '../../src/save/codec';
import { SCENARIO_PRESETS } from '../../src/scenarios/catalogData';
import { buildCity } from '../../src/scenarios/cityGen';
import { CityCommuteScenario } from '../../src/scenarios/cityCommute';
import { LivingCityScenario } from '../../src/scenarios/livingCity';
import { MetropolisScenario } from '../../src/scenarios/metropolis';
import { SignalizedCrossScenario } from '../../src/scenarios/signalizedCross';
import { startEmergency } from '../../src/emergencies';
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
    // The scenario is the world's to keep, and the city is measured against the objectives of a preset.
    new LivingCityScenario(w);
    Object.assign(w.scenario, { activeId: 'starter', activeName: 'Starter Town', objectives: SCENARIO_PRESETS[1]!.objectives.map((o) => ({ ...o })) });
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

  it('aBrokenBuildingCitizenOrTickIsRejected', () => {
    // Review round 2's six edits that loaded and ran on: now each is refused, the running world untouched.
    exercisedWorld();
    const { text } = exercised!;
    const firstBuilding = (f: Json): Fields => {
      const node = (classFields(f.world.buildings).list as unknown as Fields[])[0]!;
      return Object.hasOwn(node, '$') ? classFields(node) : node;
    };
    const citizens = (f: Json) => classFields(f.world.citizens);
    const cases: Array<readonly [string, (f: Json) => void, RegExp]> = [
      ['a building without its anchor', (f) => void delete firstBuilding(f).anchor, /^save rejected: world\.buildings\.list\[0\]\.anchor: missing$/],
      ['a building anchored at "x"', (f) => void (firstBuilding(f).anchor = 'x'), /^save rejected: world\.buildings\.list\[0\]\.anchor: expected object, found string$/],
      ['a building with an extra field', (f) => void (firstBuilding(f).extra = 1), /^save rejected: world\.buildings\.list\[0\]\.extra: no such field in the world$/],
      [
        'a citizens layer cut short',
        (f) => void (citizens(f).alive = { ...(citizens(f).alive as object), v: 'AAAA' } as SaveNode),
        /^save rejected: world\.citizens\.alive: 3 slots, the other layers \d+$/,
      ],
      ['a billion citizens', (f) => void (citizens(f).count = 1e9), /^save rejected: world\.citizens\.count: 1000000000 above the high-water mark \d+$/],
      ['tick -5', (f) => void (f.world.tick = -5), /^save rejected: world\.tick: -5 is not a count$/],
    ];
    for (const [what, edit, message] of cases) expect(() => loadWorld(edited(text, edit)), what).toThrow(message);
  }, SIZED_IN_TICKS);

  it('aNullOfAFreshWorldBecomesOnlyItsDeclaredShape', () => {
    const text = saveWorld(createWorld({ mapWidth: 8, mapHeight: 8 }));
    expect(loadWorld(edited(text, (f) => void (f.world.nextState = { state: 'InGame', ifNeq: false }))).nextState).toEqual({ state: 'InGame', ifNeq: false });
    const cases: Array<readonly [string, (f: Json) => void, RegExp]> = [
      ['nextState a number', (f) => void (f.world.nextState = 5), /^save rejected: world\.nextState: expected object, found number$/],
      ['nextState with a stray field', (f) => void (f.world.nextState = { state: 'InGame', ifNeq: false, at: 1 }), /^save rejected: world\.nextState\.at: no such field in the world$/],
      ['a graph built for "x"', (f) => void (classFields(f.world.meso).builtFor = 'x'), /^save rejected: world\.meso\.builtFor: expected number, found string$/],
      ['a worst tile without y', (f) => void ((f.world.motionStats as Fields).worstTile = { x: 1 }), /^save rejected: world\.motionStats\.worstTile\.y: missing$/],
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
    expect(() => loadWorld(edited(text, (f) => void (f.version = SAVE_VERSION + 1)))).toThrow(/^save rejected: version: /);
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
    expect(() => loadWorld(v0), 'v1 is the first TS save: nothing migrates to it').toThrow(new RegExp(`^save rejected: version: 0 is older than ${SAVE_VERSION} and no migration takes it further$`));
    expect(() => parseSave(v0, { ...SAVE_MIGRATIONS, 0: (f) => f })).toThrow(/^save rejected: version: the migration from 0 did not raise it$/);
    // A step to v1 hands the file on to the steps after it.
    expect(worldFromSave(parseSave(v0, { ...SAVE_MIGRATIONS, 0: (f) => ({ ...f, version: 1 }) })).grid.width).toBe(4);
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
    const legacy = worldFromSave(parseSave(v0, { ...SAVE_MIGRATIONS, 0: zoneAtMedium }));
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
    const back = worldFromSave(parseSave(v0, { ...SAVE_MIGRATIONS, 0: noLights }));
    expect(back.trafficLights).toEqual([]);
    expect(back.intersections.trafficLightKeys.size).toBe(0);
    expect(back.tick).toBe(w.tick);
  }, SIZED_IN_TICKS);
});

let busy: ReadonlyArray<readonly [string, World, string]> | null = null;

/**
 * Worlds with something in the collections a save carries, each with its save: the living city above with an
 * emergency, a redo step, a queued command and queued trips; the `city` of commuters and a signalized crossing, which
 * drive micro traffic; a small metropolis, which drives by meso only.
 */
function busyWorlds(): ReadonlyArray<readonly [string, World, string]> {
  if (busy === null) {
    const living = exercisedWorld();
    const home = living.buildings.all().find((b) => b.kind === 'Residential')!;
    startEmergency(living, 'Fire', home.anchor, 1);
    step(living, 300);
    const road = { kind: 'TwoLane', dir: 'East', lane: 0, flow: { kind: 'OneWay', dir: 'East' }, laneType: 'Regular' } as const;
    living.history.push({ kind: 'SetRoad', pos: { x: 2, y: 2 }, old: { ...road, kind: 'None', flow: { kind: 'TwoWay' } }, new: road });
    living.history.undo();
    living.undoRedo.push(true);
    living.commands.push({ kind: 'PlaceBuilding', pos: { x: 3, y: 3 }, building: 'Park' });
    const trip = { citizen: 1, from: home.anchor, carParkedAt: null, to: home.anchor, purpose: 'Shop', mode: 'Car' } as const;
    living.tripBacklog.push(trip);
    living.mesoTraffic.pending.push({ ...trip, pocket: true, vehicle: 'Fire' });
    living.pendingEvents.hourAdvanced.push({ hour: 3, day: 1 });
    living.pendingEvents.tripFinished.push({ citizen: 1, purpose: 'Work' });
    living.systemErrors.set('growth', { system: 'growth', count: 1, firstTick: 1, lastTick: 1, message: 'x' });
    living.loans.active.push({ principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 7 });

    const city = createWorld({ gameHourNs: 60 * SECOND_NS });
    requestState(city, 'InGame');
    frame(city, 0);
    const plan = buildCity(city, { zones: false });
    new CityCommuteScenario(city, { citizens: 2000, departureWindowTicks: 3000, stayTicks: [1200, 3600], homes: plan.homes, workplaces: plan.workplaces });
    step(city, 900);
    // Reservations last a tick; one held across the save stands for them.
    const box = city.intersections.clusters[0]!.id;
    city.reservations.byIntersection.set(box, [{ vehicle: 1, state: 'Approaching', createdAtSec: 0, maneuver: 'Straight', localIdx: null, coarse: true }]);

    const cross = createWorld({ mapWidth: 32, mapHeight: 32 });
    requestState(cross, 'InGame');
    frame(cross, 0);
    new SignalizedCrossScenario(cross);
    step(cross, 600);

    const metropolis = createWorld({ mapWidth: 128, mapHeight: 128 });
    requestState(metropolis, 'InGame');
    frame(metropolis, 0);
    new MetropolisScenario(metropolis);
    step(metropolis, 600);

    busy = [
      ['livingCity', living, saveWorld(living)],
      ['city', city, saveWorld(city)],
      ['signalizedCross', cross, saveWorld(cross)],
      ['metropolis', metropolis, saveWorld(metropolis)],
    ];
  }
  return busy;
}

/** What a node holds: the `v` of a tagged node, the node itself otherwise. */
const inner = (node: unknown): Record<string | number, SaveNode> => {
  const n = node as Record<string, unknown>;
  return (!Array.isArray(n) && Object.hasOwn(n, '$') ? n.v : n) as Record<string | number, SaveNode>;
};
const items = (node: unknown): SaveNode[] => inner(node) as unknown as SaveNode[];

/** `text` with the node at `path` (keys and indices, tagged nodes looked through) replaced by `edit` of it; `undefined` drops it. */
const at = (text: string, path: ReadonlyArray<string | number>, edit: (node: SaveNode) => SaveNode | undefined): string =>
  edited(text, (f) => {
    let parent = inner(f);
    for (const key of path.slice(0, -1)) parent = inner(parent[key]);
    const last = path.at(-1)!;
    parent[last] = edit(parent[last]!) as SaveNode;
  });

const TYPED_ARRAY_BYTES: Readonly<Record<TypedArrayName, number>> = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
  BigInt64Array: 8,
  BigUint64Array: 8,
};
const lengthOf = (node: SaveNode): number => {
  const ta = node as { t: TypedArrayName; v: string };
  return base64ToBytes(ta.v, 'test').length / TYPED_ARRAY_BYTES[ta.t];
};
/** A typed array node cut to its first `keep` elements, or grown by zeros to them. */
const resized = (node: SaveNode, keep: number): SaveNode => {
  const ta = node as { $: 'ta'; t: TypedArrayName; v: string };
  const bytes = new Uint8Array(keep * TYPED_ARRAY_BYTES[ta.t]);
  bytes.set(base64ToBytes(ta.v, 'test').subarray(0, bytes.length));
  return { ...ta, v: bytesToBase64(bytes) };
};

/** Each broken file is refused with its message; the world the file came from is as it was and loads as before. */
function expectRefused(world: World, text: string, cases: ReadonlyArray<readonly [string, string, RegExp]>): void {
  const before = fingerprint(world);
  for (const [what, broken, message] of cases) expect(() => loadWorld(broken), what).toThrow(message);
  expect(fingerprint(world), 'a refused load leaves the world as it was').toBe(before);
  expect(fingerprint(loadWorld(text))).toBe(before);
}

describe('save schemas', () => {
  it('everyCollectionOfASaveHasItsShape', () => {
    // Mirror of `fingerprintCoversEveryStateField`: every array, map, set, object and class instance a load meets is held
    // to a template, so a new collection or union fails here until `save/rules.ts` gives it a shape.
    const unchecked = new Set<string>();
    for (const [name, , text] of busyWorlds()) {
      worldFromSave(parseSave(text), (path) => void unchecked.add(`${name}: ${path.replace(/\[\d+\]/g, '[]').replace(/\{(?:key )?\d+\}/g, '{}')}`));
    }
    expect([...unchecked].sort()).toEqual([]);
  }, SIZED_IN_TICKS);

  it('everyUnionInASaveIsHeldToItsVariant', () => {
    const [, living, text] = busyWorlds()[0]!;
    const tile = { x: 1, y: 1 };
    const world = inner(parseSave(text).world);
    const zoneStep = items(inner(world.history).undoStack).findIndex((n) => inner(n).kind === 'SetZone');
    expect(zoneStep, 'the undo stack holds a SetZone').toBeGreaterThanOrEqual(0);
    // A tile the file shares: the anchor of the first building refers to one defined before it.
    const anchor = inner(items(inner(world.buildings).list)[0]).anchor as { $: string; id: number };
    expect(anchor.$).toBe('ref');
    const state = ['world', 'vehicles', 'trafficState', 3] as const;
    expectRefused(living, text, [
      ['a traffic state of no kind', at(text, state, () => ({ kind: 'Parked' })), /^save rejected: world\.vehicles\.trafficState\[3\]\.kind: expected one of FreeFlow \| Approaching \| Stopped \| WaitingForGreen \| Accelerating \| CrossingIntersection, found "Parked"$/],
      ['a Stopped state without its queue position', at(text, state, () => ({ kind: 'Stopped', intersection: 'a', stopTile: tile })), /^save rejected: world\.vehicles\.trafficState\[3\]\.queuePosition: missing$/],
      ['a FreeFlow state with a stop tile', at(text, state, () => ({ kind: 'FreeFlow', stopTile: tile })), /^save rejected: world\.vehicles\.trafficState\[3\]\.stopTile: no such field in the world$/],
      ['a traffic state that is a tile', at(text, state, () => ({ $: 'ref', id: anchor.id })), /^save rejected: world\.vehicles\.trafficState\[3\]: refers to object #\d+, which is not of the shape this place holds$/],
      ['a queued command of no kind', at(text, ['world', 'commands', 0], () => ({ kind: 'Nuke', pos: tile })), /^save rejected: world\.commands\[0\]\.kind: expected one of GenerateMap \| SetRoad \| .* \| TakeLoan, found "Nuke"$/],
      ['a PlaceBuilding command without its building', at(text, ['world', 'commands', 0, 'building'], () => undefined), /^save rejected: world\.commands\[0\]\.building: missing$/],
      ['an undo step of no kind', at(text, ['world', 'history', 'undoStack', 0], () => ({ kind: 'LoadGame', slot: 1 })), /^save rejected: world\.history\.undoStack\[0\]\.kind: expected one of SetRoad \| SetZone \| PlaceBuilding \| EraseTile, found "LoadGame"$/],
      ['a SetZone undo step without its old density', at(text, ['world', 'history', 'undoStack', zoneStep, 'oldDensity'], () => undefined), new RegExp(`^save rejected: world\\.history\\.undoStack\\[${zoneStep}\\]\\.oldDensity: missing$`)],
      ['a one-way road of no direction', at(text, ['world', 'history', 'redoStack', 0, 'new', 'flow'], () => ({ kind: 'OneWay' })), /^save rejected: world\.history\.redoStack\[0\]\.new\.flow\.dir: missing$/],
      ['a road flow of no kind', at(text, ['world', 'history', 'redoStack', 0, 'old', 'flow'], () => ({ kind: 'Roundabout' })), /^save rejected: world\.history\.redoStack\[0\]\.old\.flow\.kind: expected one of TwoWay \| OneWay, found "Roundabout"$/],
      ['a building in no phase', at(text, ['world', 'buildings', 'list', 0, 'phase'], () => ({ kind: 'Ruined' })), /^save rejected: world\.buildings\.list\[0\]\.phase\.kind: expected one of UnderConstruction \| Operational, found "Ruined"$/],
      ['a building under construction for no hours', at(text, ['world', 'buildings', 'list', 0, 'phase'], () => ({ kind: 'UnderConstruction' })), /^save rejected: world\.buildings\.list\[0\]\.phase\.hoursRemaining: missing$/],
      ['a trip by bike', at(text, ['world', 'tripBacklog', 0, 'mode'], () => 'Bike'), /^save rejected: world\.tripBacklog\[0\]\.mode: expected one of Walk \| Car, found "Bike"$/],
      ['a pending trip in a tank', at(text, ['world', 'mesoTraffic', 'pending', 0, 'vehicle'], () => 'Tank'), /^save rejected: world\.mesoTraffic\.pending\[0\]\.vehicle: expected one of Truck \| Bus \| Fire \| Police \| Ambulance, found "Tank"$/],
      ['a trip finished for no purpose', at(text, ['world', 'pendingEvents', 'tripFinished', 0, 'purpose'], () => 'Joyride'), /^save rejected: world\.pendingEvents\.tripFinished\[0\]\.purpose: expected one of Work \| .* \| Transit, found "Joyride"$/],
      ['a flood', at(text, ['world', 'emergencies', 'active', 0, 'kind'], () => 'Flood'), /^save rejected: world\.emergencies\.active\[0\]\.kind: expected one of Fire \| Crime \| Medical, found "Flood"$/],
      ['an emergency without the stations it tried', at(text, ['world', 'emergencies', 'active', 0, 'triedStations'], () => undefined), /^save rejected: world\.emergencies\.active\[0\]\.triedStations: missing$/],
      ['a service vehicle in flight', at(text, ['world', 'fleet', 'services', 0, 'state'], () => 'Flying'), /^save rejected: world\.fleet\.services\[0\]\.state: expected one of AtStation \| EnRoute \| OnScene \| Returning, found "Flying"$/],
      ['a bus parked', at(text, ['world', 'fleet', 'buses', 0, 'state'], () => 'Parked'), /^save rejected: world\.fleet\.buses\[0\]\.state: expected one of Driving \| Dwelling \| Waiting, found "Parked"$/],
      ['a light in no phase', at(text, ['world', 'trafficLights', 0, 'phase'], () => 'Blue'), /^save rejected: world\.trafficLights\[0\]\.phase: expected one of .*, found "Blue"$/],
    ]);
    const [, city, cityText] = busyWorlds()[1]!;
    expectRefused(city, cityText, [
      [
        'a reservation neither approaching nor inside',
        at(cityText, ['world', 'reservations', 'byIntersection', 0, 1, 0, 'state'], () => 'Parked'),
        /^save rejected: world\.reservations\.byIntersection\{0\}\[0\]\.state: expected one of Approaching \| Inside, found "Parked"$/,
      ],
    ]);
  }, SIZED_IN_TICKS);

  it('mesoLengthsMatchTheGraphAndTheCars', () => {
    const [, w, text] = busyWorlds()[3]!;
    const world = inner(parseSave(text).world);
    const meso = inner(world.meso);
    const traffic = inner(world.mesoTraffic);
    const links = meso.linkCount as number;
    const cars = lengthOf(traffic.citizen!);
    const tiles = (meso.width as number) * (meso.height as number);
    const successors = lengthOf(meso.succLink!);
    expect(links, 'the metropolis has links').toBeGreaterThan(0);
    expect(traffic.linksFor, 'its traffic is sized for its graph').toBe(meso.builtFor);
    const cut = (resource: string, field: string, keep: number) => at(text, ['world', resource, field], (n) => resized(n, keep));
    expectRefused(w, text, [
      ['a graph layer a link short', cut('meso', 'lanes', links - 1), new RegExp(`^save rejected: world\\.meso\\.lanes: ${links - 1} links, the graph has ${links}$`)],
      ['a graph layer a link long', cut('meso', 'startX', links + 1), new RegExp(`^save rejected: world\\.meso\\.startX: ${links + 1} links, the graph has ${links}$`)],
      ['successor starts one short', cut('meso', 'succStart', links), new RegExp(`^save rejected: world\\.meso\\.succStart: ${links} entries for ${links} links$`)],
      ['successors cut short', cut('meso', 'succCluster', successors - 1), new RegExp(`^save rejected: world\\.meso\\.succCluster: ${successors - 1} successors, succStart ends at ${successors}$`)],
      ['a tile layer cut short', cut('meso', 'tileOffset', tiles - 1), new RegExp(`^save rejected: world\\.meso\\.tileOffset: ${tiles - 1} tiles on a graph of ${tiles}$`)],
      ['a link layer of traffic a link short', cut('mesoTraffic', 'head', links - 1), new RegExp(`^save rejected: world\\.mesoTraffic\\.head: ${links - 1} links, the graph has ${links}$`)],
      ['link times cut short', cut('mesoTraffic', 'linkSeconds', 3), new RegExp(`^save rejected: world\\.mesoTraffic\\.linkSeconds: 3 links, the graph has ${links}$`)],
      ['a car layer cut short', cut('mesoTraffic', 'next', cars - 1), new RegExp(`^save rejected: world\\.mesoTraffic\\.next: ${cars - 1} cars, the other car layers ${cars}$`)],
      [
        'more routes than cars',
        at(text, ['world', 'mesoTraffic', 'routes'], (n) => [...items(n), ...Array.from({ length: cars }, () => ({ $: 'ta', t: 'Int32Array', v: '' }) as SaveNode)]),
        new RegExp(`^save rejected: world\\.mesoTraffic\\.routes: \\d+ routes for ${cars} cars$`),
      ],
      ['a high-water mark past the cars', at(text, ['world', 'mesoTraffic', 'highWater'], () => cars + 1), new RegExp(`^save rejected: world\\.mesoTraffic\\.highWater: ${cars + 1} in ${cars} cars$`)],
      ['more cars than ever came', at(text, ['world', 'mesoTraffic', 'count'], () => (traffic.highWater as number) + 1), /^save rejected: world\.mesoTraffic\.count: \d+ above the high-water mark \d+$/],
      ['a due heap with a key too many', at(text, ['world', 'mesoTraffic', 'due', 'keys'], (n) => [...items(n), 1]), /^save rejected: world\.mesoTraffic\.due: \d+ keys for \d+ links$/],
    ]);
  }, SIZED_IN_TICKS);
});
