// The feed of crates/simcity_sim/src/game/notifications.rs (tag rust-final): its nine `mod tests` cases,
// plus the two notice pins that live with the buildings — `buildings/growth.rs` and `buildings/upgrade.rs`.
// Rust names are kept in camelCase so the pair is greppable.
import { describe, expect, it } from 'vitest';
import { CONSTRUCTION_NOTICE, growBuildings } from '../src/buildings/growth';
import { UPGRADE_NOTICE, upgradeBuildings } from '../src/buildings/upgrade';
import { simTick } from '../src/city';
import { emptyEvents } from '../src/events';
import { fingerprint } from '../src/fingerprint';
import { HISTORY_LINES, Notifications, stampAndExpire, type ShownToast } from '../src/notifications';
import { spawnBuilding } from '../src/buildings/spawn';
import { MapGrid } from '../src/map/grid';
import { createWorld, type World } from '../src/world';
import { demand, network, roadRow, station, worldOn, zoneRect } from './buildings/helpers';

const UPGRADED = 'Residential building upgraded to level II';

/** Every zone name and level marker that must never reach a feed line. */
const ZONES = ['Residential', 'Commercial', 'Industrial'] as const;
const LEVELS = ['1', '2', '3', 'I', 'II', 'III'] as const;

/** The screen after one more reading of the clock, starting from nothing on it. */
function screen(feed: Notifications, times: readonly number[]): { toasts: readonly ShownToast[]; changed: readonly boolean[] } {
  let shown: readonly ShownToast[] = [];
  const changed: boolean[] = [];
  for (const timeNow of times) {
    const next = stampAndExpire(feed.messages(), shown, timeNow);
    shown = next.toasts;
    changed.push(next.changed);
  }
  return { toasts: shown, changed };
}

describe('notifications', () => {
  // rust-final crates/simcity_sim/src/game/notifications.rs:195 advisor_feed_keeps_the_last_30_events_with_their_day
  it('advisorFeedKeepsTheLast30EventsWithTheirDay', () => {
    const feed = new Notifications();
    feed.setDay(3);
    feed.add('250 residents: School unlocked', 'Achievement', 12);
    feed.setDay(4);
    for (let n = 0; n < 35; n++) feed.add(`Event ${n}`, 'Info', 3);
    feed.add('Event 34', 'Info', 3);

    const history = feed.history().map((line) => [line.day, line.text, line.count] as const);
    expect(history).toHaveLength(HISTORY_LINES);
    expect(history[0]).toEqual([4, 'Event 5', 1]); // the oldest go first
    expect(history.at(-1)).toEqual([4, 'Event 34', 2]); // a repeat in a row counts on its line

    expect(screen(feed, [0, 100]).toasts).toHaveLength(0);
    expect(feed.history()).toHaveLength(HISTORY_LINES); // the history outlives the toasts
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:237 advisor_feed_dates_events_with_the_game_day.
  // Rust ran the render-side `stamp_notifications` to copy `City::day` into the feed; in the port that copy
  // is `simTick` (packages/sim/src/city.ts:85), so the day is driven through the clock instead.
  it('advisorFeedDatesEventsWithTheGameDay', () => {
    const w = createWorld();
    w.city.day = 6;
    w.city.hour = 23;
    simTick(w, w.gameHourNs);
    expect(w.city.day).toBe(7);

    w.notifications.add('Fire emergency', 'Warning', 5);
    expect(w.notifications.history().at(-1)?.day).toBe(7);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:265 notification_dedup_identical_messages_collapse_into_one_line_with_a_count
  it('notificationDedupIdenticalMessagesCollapseIntoOneLineWithACount', () => {
    const feed = new Notifications();
    for (let i = 0; i < 8; i++) feed.add(UPGRADED, 'Info', 3);
    expect(feed.messages()).toHaveLength(1); // eight identical toasts are one line
    expect(feed.messages()[0]?.count).toBe(8);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:279 notification_dedup_different_messages_stay_apart
  it('notificationDedupDifferentMessagesStayApart', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.add('New Commercial building constructed', 'Info', 3);
    feed.add(UPGRADED, 'Warning', 3);
    // a different text or a different severity is a different line
    expect(feed.messages()).toHaveLength(3);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:296 notification_dedup_group_lifetime_counts_from_the_last_occurrence
  it('notificationDedupGroupLifetimeCountsFromTheLastOccurrence', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    let shown = stampAndExpire(feed.messages(), [], 10).toasts;
    feed.add(UPGRADED, 'Info', 3);
    shown = stampAndExpire(feed.messages(), shown, 12).toasts;

    shown = stampAndExpire(feed.messages(), shown, 14).toasts;
    // two seconds after the repeat the line is alive, though four passed since the first
    expect(shown).toHaveLength(1);
    shown = stampAndExpire(feed.messages(), shown, 15.5).toasts;
    expect(shown).toHaveLength(0); // three seconds after the last it is gone
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:317 notification_dedup_a_repeat_moves_its_line_to_the_newest_place
  it('notificationDedupARepeatMovesItsLineToTheNewestPlace', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.add('Fire emergency responded', 'Info', 3);
    feed.add(UPGRADED, 'Info', 3);
    expect(feed.messages().map((line) => line.text)).toEqual(['Fire emergency responded', UPGRADED]);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:335 notification_dedup_an_expired_line_starts_a_fresh_count.
  // Rust restarted the counter because expiry removed the line from `Notifications::messages`, which was
  // both the screen and the feed. Here expiry may not touch the feed at all — see
  // docs/oracle-deviations.md, 2026-09-21 — so the pin is the part that survives the split: the line is
  // back on screen, stamped afresh, and the feed's running count is the one thing expiry did not reset.
  it('notificationDedupAnExpiredLineStartsAFreshCount', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.add(UPGRADED, 'Info', 3);
    let shown = stampAndExpire(feed.messages(), [], 0).toasts;
    expect(shown[0]?.lastAt).toBe(0);
    shown = stampAndExpire(feed.messages(), shown, 5).toasts;
    expect(shown, 'the line left the screen').toHaveLength(0);

    feed.add(UPGRADED, 'Info', 3);
    shown = stampAndExpire(feed.messages(), shown, 5).toasts;
    expect(shown).toHaveLength(1);
    expect(shown[0]?.lastAt, 'the lifetime runs from the occurrence that brought it back').toBe(5);
    expect(feed.messages()[0]?.count, 'expiry left the feed alone').toBe(3);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:347 notification_dedup_a_line_leads_to_its_latest_place
  it('notificationDedupALineLeadsToItsLatestPlace', () => {
    const feed = new Notifications();
    feed.addAt('Fire emergency', 'Warning', 5, { x: 3, y: 4 });
    feed.addAt('Fire emergency', 'Warning', 5, { x: 9, y: 2 });
    expect(feed.messages()).toHaveLength(1);
    // a click goes where the newest occurrence happened
    expect(feed.messages()[0]?.at).toEqual({ x: 9, y: 2 });
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:370 notification_dedup_stamping_reports_whether_the_feed_changed
  it('notificationDedupStampingReportsWhetherTheFeedChanged', () => {
    const feed = new Notifications();
    let shown: readonly ShownToast[] = [];
    let step = stampAndExpire(feed.messages(), shown, 0);
    expect(step.changed).toBe(false); // an empty feed has nothing to change
    shown = step.toasts;

    feed.add(UPGRADED, 'Info', 3);
    step = stampAndExpire(feed.messages(), shown, 1);
    expect(step.changed).toBe(true); // a new line was stamped
    shown = step.toasts;

    step = stampAndExpire(feed.messages(), shown, 2);
    expect(step.changed).toBe(false); // nothing new and nothing expired
    shown = step.toasts;

    step = stampAndExpire(feed.messages(), shown, 9);
    expect(step.changed).toBe(true); // the line expired
    expect(step.toasts).toHaveLength(0);
  });

  // The reason `stampAndExpire` is pure: the toast list is hashed (packages/sim/src/fingerprint.ts:392,
  // section `notifications`), so a wall-clock reading reaching it would make the fingerprint a function
  // of real time. Stamping and expiring a full screen must leave the world byte-identical.
  it('stampAndExpireLeavesTheFingerprintAlone', () => {
    const w = createWorld();
    w.notifications.addAt('Fire emergency', 'Warning', 5, { x: 3, y: 4 });
    w.notifications.add(UPGRADED, 'Info', 3);
    w.notifications.add(UPGRADED, 'Info', 3);
    const before = fingerprint(w);

    let shown = stampAndExpire(w.notifications.messages(), [], 0).toasts;
    expect(shown, 'the whole screen is up').toHaveLength(2);
    shown = stampAndExpire(w.notifications.messages(), shown, 100).toasts;
    expect(shown, 'and then every line has expired').toHaveLength(0);

    expect(w.notifications.messages(), 'the feed keeps its lines').toHaveLength(2);
    expect(fingerprint(w)).toBe(before);
  });

  // rust-final crates/simcity_sim/src/game/buildings/growth.rs:620 notification_dedup_every_construction_is_the_same_line.
  // Rust asserted that `construction_notice(kind)` ignores the zone; the port dropped the argument for a
  // constant, so the pin is driven through the real path instead: `growBuildings`
  // (packages/sim/src/buildings/growth.ts:179) is where a zone name could be interpolated into the line.
  it('notificationDedupEveryConstructionIsTheSameLine', () => {
    const grid = new MapGrid(40, 16);
    roadRow(grid, 2, 0, 39);
    zoneRect(grid, 'Residential', 2, 12, 3, 5, 'Medium');
    zoneRect(grid, 'Commercial', 16, 26, 3, 5, 'Medium');
    station(grid, 'PowerPlant', 30, 3);
    station(grid, 'WaterPump', 34, 3);
    const w = worldOn(grid);
    w.utilityNetwork = network(grid);
    w.rciDemand = demand(1, 1);

    for (let hour = 0; hour < 200 && !bothZonesBuilt(w); hour++) {
      w.events = emptyEvents();
      w.events.hourAdvanced.push({ hour: hour % 24, day: 1 });
      growBuildings(w);
    }
    expect(bothZonesBuilt(w), 'two zones grew buildings').toBe(true);

    const built = w.buildings.all().filter((b) => b.kind === 'Residential' || b.kind === 'Commercial').length;
    expect(w.notifications.messages(), 'every zone lands on one feed line').toHaveLength(1);
    const line = w.notifications.messages()[0]!;
    expect(line.text).toBe(CONSTRUCTION_NOTICE);
    expect(line.count).toBe(built);
    for (const zone of ZONES) expect(line.text, zone).not.toContain(zone);
    for (const level of LEVELS) expect(line.text, level).not.toContain(level);
  });

  // rust-final crates/simcity_sim/src/game/buildings/upgrade.rs:91 notification_dedup_every_upgrade_is_the_same_line.
  // Same shape, same treatment: `upgradeBuildings` (packages/sim/src/buildings/upgrade.ts:23) is driven for
  // real, so neither the zone nor the level can split one stream into several lines.
  it('notificationDedupEveryUpgradeIsTheSameLine', () => {
    const grid = new MapGrid(40, 16);
    roadRow(grid, 2, 0, 39);
    zoneRect(grid, 'Residential', 2, 8, 3, 5, 'Medium');
    zoneRect(grid, 'Commercial', 12, 18, 3, 5, 'Medium');
    station(grid, 'PowerPlant', 30, 3);
    station(grid, 'WaterPump', 34, 3);
    const w = worldOn(grid);
    w.utilityNetwork = network(grid);
    w.rciDemand = demand(1, 1, 1);
    const houses = spawnBuilding(w, { x: 2, y: 3 }, 3, 3, 'Residential', false, { density: 'Medium', class: 'Middle' });
    const shops = spawnBuilding(w, { x: 12, y: 3 }, 3, 3, 'Commercial', false, { density: 'Medium', class: 'Middle' });
    const levels = () => [houses.level, shops.level] as const;
    const grown = () => levels()[0] > 1 && levels()[1] > 1;

    for (let check = 0; check < 500 && !grown(); check++) upgradeBuildings(w, 5 * w.gameHourNs);
    expect(grown(), `both zones upgraded, levels ${levels().join('/')}`).toBe(true);

    const upgrades = houses.level - 1 + (shops.level - 1);
    expect(w.notifications.messages(), 'every zone and level lands on one feed line').toHaveLength(1);
    const line = w.notifications.messages()[0]!;
    expect(line.text).toBe(UPGRADE_NOTICE);
    expect(line.count).toBe(upgrades);
    for (const zone of ZONES) expect(line.text, zone).not.toContain(zone);
    for (const level of LEVELS) expect(line.text, level).not.toContain(level);
  });
});

/** Whether the world grew at least one building in each of the two zones. */
function bothZonesBuilt(w: World): boolean {
  const kinds = new Set(w.buildings.all().map((b) => b.kind));
  return kinds.has('Residential') && kinds.has('Commercial');
}
