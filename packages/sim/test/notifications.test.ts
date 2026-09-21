// The feed of crates/simcity_sim/src/game/notifications.rs (tag rust-final): its nine `mod tests` cases,
// plus the two notice pins that live with the buildings — `buildings/growth.rs` and `buildings/upgrade.rs`.
// Rust names are kept in camelCase so the pair is greppable.
import { describe, expect, it } from 'vitest';
import { CONSTRUCTION_NOTICE } from '../src/buildings/growth';
import { UPGRADE_NOTICE } from '../src/buildings/upgrade';
import { simTick } from '../src/city';
import { HISTORY_LINES, Notifications } from '../src/notifications';
import { createWorld } from '../src/world';

const UPGRADED = 'Residential building upgraded to level II';

describe('notifications', () => {
  // rust-final crates/simcity_sim/src/game/notifications.rs:191 advisor_feed_keeps_the_last_30_events_with_their_day
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

    feed.stampAndExpire(0);
    feed.stampAndExpire(100);
    expect(feed.messages()).toHaveLength(0);
    expect(feed.history()).toHaveLength(HISTORY_LINES); // the history outlives the toasts
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:228 advisor_feed_dates_events_with_the_game_day.
  // Rust ran the render-side `stamp_notifications` to copy `City::day` into the feed; in the port that copy
  // is `simTick` (packages/sim/src/city.ts), so the day is driven through the clock instead.
  it('advisorFeedDatesEventsWithTheGameDay', () => {
    const w = createWorld();
    w.city.day = 6;
    w.city.hour = 23;
    simTick(w, w.gameHourNs);
    expect(w.city.day).toBe(7);

    w.notifications.add('Fire emergency', 'Warning', 5);
    expect(w.notifications.history().at(-1)?.day).toBe(7);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:252 notification_dedup_identical_messages_collapse_into_one_line_with_a_count
  it('notificationDedupIdenticalMessagesCollapseIntoOneLineWithACount', () => {
    const feed = new Notifications();
    for (let i = 0; i < 8; i++) feed.add(UPGRADED, 'Info', 3);
    expect(feed.messages()).toHaveLength(1); // eight identical toasts are one line
    expect(feed.messages()[0]?.count).toBe(8);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:266 notification_dedup_different_messages_stay_apart
  it('notificationDedupDifferentMessagesStayApart', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.add('New Commercial building constructed', 'Info', 3);
    feed.add(UPGRADED, 'Warning', 3);
    // a different text or a different severity is a different line
    expect(feed.messages()).toHaveLength(3);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:283 notification_dedup_group_lifetime_counts_from_the_last_occurrence
  it('notificationDedupGroupLifetimeCountsFromTheLastOccurrence', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.stampAndExpire(10);
    feed.add(UPGRADED, 'Info', 3);
    feed.stampAndExpire(12);

    feed.stampAndExpire(14);
    // two seconds after the repeat the line is alive, though four passed since the first
    expect(feed.messages()).toHaveLength(1);
    feed.stampAndExpire(15.5);
    expect(feed.messages()).toHaveLength(0); // three seconds after the last it is gone
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:303 notification_dedup_a_repeat_moves_its_line_to_the_newest_place
  it('notificationDedupARepeatMovesItsLineToTheNewestPlace', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.add('Fire emergency responded', 'Info', 3);
    feed.add(UPGRADED, 'Info', 3);
    expect(feed.messages().map((line) => line.text)).toEqual(['Fire emergency responded', UPGRADED]);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:320 notification_dedup_an_expired_line_starts_a_fresh_count
  it('notificationDedupAnExpiredLineStartsAFreshCount', () => {
    const feed = new Notifications();
    feed.add(UPGRADED, 'Info', 3);
    feed.add(UPGRADED, 'Info', 3);
    feed.stampAndExpire(0);
    feed.stampAndExpire(5);
    feed.add(UPGRADED, 'Info', 3);
    expect(feed.messages()).toHaveLength(1);
    expect(feed.messages()[0]?.count).toBe(1);
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:332 notification_dedup_a_line_leads_to_its_latest_place
  it('notificationDedupALineLeadsToItsLatestPlace', () => {
    const feed = new Notifications();
    feed.addAt('Fire emergency', 'Warning', 5, { x: 3, y: 4 });
    feed.addAt('Fire emergency', 'Warning', 5, { x: 9, y: 2 });
    expect(feed.messages()).toHaveLength(1);
    // a click goes where the newest occurrence happened
    expect(feed.messages()[0]?.at).toEqual({ x: 9, y: 2 });
  });

  // rust-final crates/simcity_sim/src/game/notifications.rs:354 notification_dedup_stamping_reports_whether_the_feed_changed
  it('notificationDedupStampingReportsWhetherTheFeedChanged', () => {
    const feed = new Notifications();
    expect(feed.stampAndExpire(0)).toBe(false); // an empty feed has nothing to change
    feed.add(UPGRADED, 'Info', 3);
    expect(feed.stampAndExpire(1)).toBe(true); // a new line was stamped
    expect(feed.stampAndExpire(2)).toBe(false); // nothing new and nothing expired
    expect(feed.stampAndExpire(9)).toBe(true); // the line expired
  });

  // rust-final crates/simcity_sim/src/game/buildings/growth.rs:620 notification_dedup_every_construction_is_the_same_line.
  // Rust asserted `construction_notice(kind)` ignores the zone; the port dropped the argument and kept one
  // constant (packages/sim/src/buildings/growth.ts:26), so the pin is what that buys: every zone's
  // construction lands on a single feed line.
  it('notificationDedupEveryConstructionIsTheSameLine', () => {
    expect(CONSTRUCTION_NOTICE).not.toBe('');
    for (const zone of ['Residential', 'Commercial', 'Industrial']) {
      expect(CONSTRUCTION_NOTICE).not.toContain(zone);
    }
    const feed = new Notifications();
    for (let zones = 0; zones < 3; zones++) feed.addAt(CONSTRUCTION_NOTICE, 'Info', 3, { x: zones, y: 0 });
    expect(feed.messages()).toHaveLength(1);
    expect(feed.messages()[0]?.count).toBe(3);
  });

  // rust-final crates/simcity_sim/src/game/buildings/upgrade.rs:91 notification_dedup_every_upgrade_is_the_same_line.
  // Same shape: `upgrade_notice(kind, level)` became the constant at packages/sim/src/buildings/upgrade.ts:8,
  // so neither the zone nor the level can split one stream into several lines.
  it('notificationDedupEveryUpgradeIsTheSameLine', () => {
    expect(UPGRADE_NOTICE).not.toBe('');
    for (const zone of ['Residential', 'Commercial', 'Industrial']) {
      expect(UPGRADE_NOTICE).not.toContain(zone);
    }
    for (const level of ['2', '3', 'II', 'III']) expect(UPGRADE_NOTICE).not.toContain(level);
    const feed = new Notifications();
    for (const level of [2, 3, 2, 3]) feed.addAt(UPGRADE_NOTICE, 'Info', 3, { x: level, y: 0 });
    expect(feed.messages()).toHaveLength(1);
    expect(feed.messages()[0]?.count).toBe(4);
  });
});
