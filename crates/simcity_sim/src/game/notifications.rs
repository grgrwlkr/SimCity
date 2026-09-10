//! Game events for the player: grouped into lines, aged on real time, drawn by the game interface.

use std::collections::VecDeque;

use bevy::prelude::*;
use bevy::time::Real;

use crate::game::map::TilePos;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

/// One line of the feed: every occurrence of the same message, collapsed.
#[derive(Debug, Clone)]
pub struct Notification {
    pub text: String,
    pub kind: NotificationKind,
    /// How many times this message arrived while the line was alive.
    pub count: u32,
    /// Where the latest occurrence happened, for a click to take the player there.
    pub at: Option<TilePos>,
    /// Real time of the latest occurrence; `None` until the feed stamps it.
    pub last_at: Option<f64>,
    pub duration: f32, // seconds
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum NotificationKind {
    Info,
    Warning,
    Error,
    Achievement,
}

/// How many past events the feed remembers.
pub const HISTORY_LINES: usize = 30;

/// One past event: what happened and on which game day, a repeat in a row counted on its line.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryLine {
    pub day: u32,
    pub text: String,
    pub kind: NotificationKind,
    pub count: u32,
}

/// Notification system resource
#[derive(Resource, Default)]
pub struct Notifications {
    messages: Vec<Notification>,
    /// The last events, oldest first; they outlive the toasts.
    history: VecDeque<HistoryLine>,
    /// The game day new events are dated with.
    day: u32,
    /// Bumps whenever the history changes.
    history_version: u64,
}

impl Notifications {
    pub fn add(&mut self, text: String, kind: NotificationKind, duration: f32) {
        self.push(text, kind, duration, None);
    }

    /// Like [`Self::add`], for an event that happened somewhere on the map.
    pub fn add_at(&mut self, text: String, kind: NotificationKind, duration: f32, at: TilePos) {
        self.push(text, kind, duration, Some(at));
    }

    /// Same text and severity is the same line: it counts up, takes the newest place and moves
    /// to the end, and its lifetime restarts from this occurrence.
    fn push(&mut self, text: String, kind: NotificationKind, duration: f32, at: Option<TilePos>) {
        let day = self.day;
        match self.history.back_mut() {
            Some(last) if last.kind == kind && last.text == text && last.day == day => {
                last.count += 1;
            }
            _ => {
                self.history.push_back(HistoryLine {
                    day,
                    text: text.clone(),
                    kind,
                    count: 1,
                });
                if self.history.len() > HISTORY_LINES {
                    self.history.pop_front();
                }
            }
        }
        self.history_version = self.history_version.wrapping_add(1);

        let line = match self
            .messages
            .iter()
            .position(|line| line.kind == kind && line.text == text)
        {
            Some(index) => {
                let mut line = self.messages.remove(index);
                line.count += 1;
                line.at = at.or(line.at);
                line.last_at = None;
                line.duration = line.duration.max(duration);
                line
            }
            None => Notification {
                text,
                kind,
                count: 1,
                at,
                last_at: None,
                duration,
            },
        };
        self.messages.push(line);
    }

    pub fn messages(&self) -> &[Notification] {
        &self.messages
    }

    /// The last events, oldest first.
    pub fn history(&self) -> &VecDeque<HistoryLine> {
        &self.history
    }

    pub fn history_version(&self) -> u64 {
        self.history_version
    }

    /// Date the events that arrive from now on with `day`.
    pub fn set_day(&mut self, day: u32) {
        self.day = day;
    }

    /// Stamp lines that arrived since the last call and drop the ones whose time is up.
    /// Returns whether a line was stamped or dropped, so a caller can mark the feed changed only
    /// then.
    pub fn stamp_and_expire(&mut self, time_now: f64) -> bool {
        let mut stamped = false;
        for line in &mut self.messages {
            if line.last_at.is_none() {
                line.last_at = Some(time_now);
                stamped = true;
            }
        }
        let before = self.messages.len();
        self.messages.retain(|line| {
            line.last_at
                .is_some_and(|last| time_now - last < f64::from(line.duration))
        });
        stamped || self.messages.len() != before
    }
}

pub struct NotificationsPlugin;

impl Plugin for NotificationsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Notifications>().add_systems(
            Update,
            stamp_notifications
                .in_set(GameSet::RenderSync)
                .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
        );
    }
}

/// Stamp new lines and drop expired ones on real time, so the feed ages while the game is paused
/// as it always has. The feed is drawn by the game interface, not here.
fn stamp_notifications(
    time: Res<Time<Real>>,
    city: Option<Res<City>>,
    mut notifications: ResMut<Notifications>,
) {
    // The day dates the events that arrive next; it changes nothing on screen by itself.
    if let Some(city) = city.as_deref() {
        notifications.bypass_change_detection().set_day(city.day);
    }
    if notifications
        .bypass_change_detection()
        .stamp_and_expire(time.elapsed_secs_f64())
    {
        notifications.set_changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPGRADED: &str = "Residential building upgraded to level II";

    /// B8: the feed remembers the last 30 events with the day they happened, oldest first, a repeat
    /// in a row counted on its line, long after the toasts are gone.
    #[test]
    fn advisor_feed_keeps_the_last_30_events_with_their_day() {
        let mut feed = Notifications::default();
        feed.set_day(3);
        feed.add(
            "250 residents: School unlocked".to_string(),
            NotificationKind::Achievement,
            12.0,
        );
        feed.set_day(4);
        for n in 0..35 {
            feed.add(format!("Event {n}"), NotificationKind::Info, 3.0);
        }
        feed.add("Event 34".to_string(), NotificationKind::Info, 3.0);

        let history: Vec<(u32, &str, u32)> = feed
            .history()
            .iter()
            .map(|line| (line.day, line.text.as_str(), line.count))
            .collect();
        assert_eq!(history.len(), HISTORY_LINES);
        assert_eq!(
            history.first(),
            Some(&(4, "Event 5", 1)),
            "the oldest go first"
        );
        assert_eq!(
            history.last(),
            Some(&(4, "Event 34", 2)),
            "a repeat in a row counts on its line"
        );

        feed.stamp_and_expire(0.0);
        feed.stamp_and_expire(100.0);
        assert!(feed.messages().is_empty());
        assert_eq!(
            feed.history().len(),
            HISTORY_LINES,
            "the history outlives the toasts"
        );
    }

    #[test]
    fn advisor_feed_dates_events_with_the_game_day() {
        use crate::game::sim::City;

        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(City {
                day: 7,
                ..City::default()
            })
            .init_resource::<Notifications>()
            .add_systems(Update, stamp_notifications);
        app.update();
        app.world_mut().resource_mut::<Notifications>().add(
            "Fire emergency".to_string(),
            NotificationKind::Warning,
            5.0,
        );
        assert_eq!(
            app.world()
                .resource::<Notifications>()
                .history()
                .back()
                .map(|line| line.day),
            Some(7)
        );
    }

    #[test]
    fn notification_dedup_identical_messages_collapse_into_one_line_with_a_count() {
        let mut feed = Notifications::default();
        for _ in 0..8 {
            feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        }
        assert_eq!(
            feed.messages().len(),
            1,
            "eight identical toasts are one line"
        );
        assert_eq!(feed.messages()[0].count, 8);
    }

    #[test]
    fn notification_dedup_different_messages_stay_apart() {
        let mut feed = Notifications::default();
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        feed.add(
            "New Commercial building constructed".to_string(),
            NotificationKind::Info,
            3.0,
        );
        feed.add(UPGRADED.to_string(), NotificationKind::Warning, 3.0);
        assert_eq!(
            feed.messages().len(),
            3,
            "a different text or a different severity is a different line"
        );
    }

    #[test]
    fn notification_dedup_group_lifetime_counts_from_the_last_occurrence() {
        let mut feed = Notifications::default();
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        feed.stamp_and_expire(10.0);
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        feed.stamp_and_expire(12.0);

        feed.stamp_and_expire(14.0);
        assert_eq!(
            feed.messages().len(),
            1,
            "two seconds after the repeat the line is alive, though four passed since the first"
        );
        feed.stamp_and_expire(15.5);
        assert!(
            feed.messages().is_empty(),
            "three seconds after the last it is gone"
        );
    }

    #[test]
    fn notification_dedup_a_repeat_moves_its_line_to_the_newest_place() {
        let mut feed = Notifications::default();
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        feed.add(
            "Fire emergency responded".to_string(),
            NotificationKind::Info,
            3.0,
        );
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        let texts: Vec<&str> = feed
            .messages()
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(texts, vec!["Fire emergency responded", UPGRADED]);
    }

    #[test]
    fn notification_dedup_an_expired_line_starts_a_fresh_count() {
        let mut feed = Notifications::default();
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        feed.stamp_and_expire(0.0);
        feed.stamp_and_expire(5.0);
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        assert_eq!(feed.messages().len(), 1);
        assert_eq!(feed.messages()[0].count, 1);
    }

    #[test]
    fn notification_dedup_a_line_leads_to_its_latest_place() {
        let mut feed = Notifications::default();
        feed.add_at(
            "Fire emergency".to_string(),
            NotificationKind::Warning,
            5.0,
            TilePos { x: 3, y: 4 },
        );
        feed.add_at(
            "Fire emergency".to_string(),
            NotificationKind::Warning,
            5.0,
            TilePos { x: 9, y: 2 },
        );
        assert_eq!(feed.messages().len(), 1);
        assert_eq!(
            feed.messages()[0].at,
            Some(TilePos { x: 9, y: 2 }),
            "a click goes where the newest occurrence happened"
        );
    }

    #[test]
    fn notification_dedup_stamping_reports_whether_the_feed_changed() {
        let mut feed = Notifications::default();
        assert!(
            !feed.stamp_and_expire(0.0),
            "an empty feed has nothing to change"
        );
        feed.add(UPGRADED.to_string(), NotificationKind::Info, 3.0);
        assert!(feed.stamp_and_expire(1.0), "a new line was stamped");
        assert!(
            !feed.stamp_and_expire(2.0),
            "nothing new and nothing expired"
        );
        assert!(feed.stamp_and_expire(9.0), "the line expired");
    }
}
