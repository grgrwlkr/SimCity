//! Milestones (B8): the city's population opens new buildings. A milestone once reached stays
//! reached, so a city that shrinks keeps what it opened; a new map starts over.

use bevy::prelude::*;

use crate::game::map::BuildingKind;
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

/// A population that opens a building.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Milestone {
    pub population: u32,
    pub unlocks: BuildingKind,
}

/// Every milestone, smallest population first. A building not named here is open from the start.
pub const MILESTONES: [Milestone; 2] = [
    Milestone {
        population: 250,
        unlocks: BuildingKind::School,
    },
    Milestone {
        population: 1000,
        unlocks: BuildingKind::University,
    },
];

/// How long a milestone's feed line stays up, in seconds.
const MILESTONE_LINE_SECONDS: f32 = 12.0;

/// The population `kind` opens at; 0 for a building open from the start.
pub fn unlock_population(kind: BuildingKind) -> u32 {
    MILESTONES
        .iter()
        .find(|milestone| milestone.unlocks == kind)
        .map_or(0, |milestone| milestone.population)
}

/// What the player reads on a building a milestone opens.
pub fn locked_reason(kind: BuildingKind) -> Option<&'static str> {
    match kind {
        BuildingKind::School => Some("Unlocks at 250 residents"),
        BuildingKind::University => Some("Unlocks at 1000 residents"),
        _ => None,
    }
}

fn building_name(kind: BuildingKind) -> &'static str {
    match kind {
        BuildingKind::School => "School",
        BuildingKind::University => "University",
        _ => "A building",
    }
}

/// The feed line a milestone announces itself with.
pub fn milestone_line(milestone: Milestone) -> String {
    format!(
        "{} residents: {} unlocked",
        milestone.population,
        building_name(milestone.unlocks)
    )
}

/// How far the city has come.
#[derive(
    Resource, Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize,
)]
pub struct Milestones {
    /// The largest population the city has reached.
    pub best_population: u32,
}

impl Milestones {
    /// Whether `kind` may be built.
    pub fn is_unlocked(&self, kind: BuildingKind) -> bool {
        self.best_population >= unlock_population(kind)
    }

    /// Why `kind` cannot be built yet; `None` once it is open.
    pub fn lock(&self, kind: BuildingKind) -> Option<&'static str> {
        if self.is_unlocked(kind) {
            None
        } else {
            locked_reason(kind)
        }
    }

    /// Record `population`, returning every milestone it reaches for the first time.
    pub fn reach(&mut self, population: u32) -> Vec<Milestone> {
        let reached = MILESTONES
            .into_iter()
            .filter(|milestone| {
                milestone.population > self.best_population && milestone.population <= population
            })
            .collect();
        self.best_population = self.best_population.max(population);
        reached
    }

    /// The next milestone ahead, if any is left.
    pub fn next(&self) -> Option<Milestone> {
        MILESTONES
            .into_iter()
            .find(|milestone| milestone.population > self.best_population)
    }
}

/// Follow the population to its milestones and announce each one reached.
pub(crate) fn track_milestones(
    city: Res<City>,
    mut milestones: ResMut<Milestones>,
    notifications: Option<ResMut<Notifications>>,
) {
    // Read before writing: a resource written every frame would repaint the palette every frame.
    if city.population <= milestones.best_population {
        return;
    }
    let reached = milestones.reach(city.population);
    if let Some(mut notifications) = notifications {
        for milestone in reached {
            notifications.add(
                milestone_line(milestone),
                NotificationKind::Achievement,
                MILESTONE_LINE_SECONDS,
            );
        }
    }
}

pub struct MilestonesPlugin;

impl Plugin for MilestonesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Milestones>().add_systems(
            Update,
            track_milestones
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B8: the school opens at 250 residents and the university at 1000; what is open stays open
    /// when the city shrinks.
    #[test]
    fn milestone_school_opens_at_250_residents_and_university_at_1000() {
        let mut milestones = Milestones::default();
        assert!(!milestones.is_unlocked(BuildingKind::School));
        assert!(!milestones.is_unlocked(BuildingKind::University));
        for open in [
            BuildingKind::Park,
            BuildingKind::FireStation,
            BuildingKind::PowerPlant,
        ] {
            assert!(
                milestones.is_unlocked(open),
                "{open:?} is open from the start"
            );
        }
        assert_eq!(
            milestones.lock(BuildingKind::School),
            Some("Unlocks at 250 residents")
        );

        assert!(milestones.reach(249).is_empty());
        assert!(!milestones.is_unlocked(BuildingKind::School));
        assert_eq!(milestones.reach(260), vec![MILESTONES[0]]);
        assert!(milestones.is_unlocked(BuildingKind::School));
        assert!(!milestones.is_unlocked(BuildingKind::University));
        assert_eq!(milestones.next(), Some(MILESTONES[1]));

        assert!(milestones.reach(100).is_empty());
        assert!(
            milestones.is_unlocked(BuildingKind::School),
            "a milestone once reached stays reached"
        );
        assert_eq!(milestones.reach(5000), vec![MILESTONES[1]]);
        assert_eq!(milestones.next(), None);

        for milestone in MILESTONES {
            assert_eq!(
                locked_reason(milestone.unlocks),
                Some(format!("Unlocks at {} residents", milestone.population).as_str()),
                "the words match the number"
            );
            assert_eq!(unlock_population(milestone.unlocks), milestone.population);
        }
    }

    /// The player learns about a milestone from the feed, once.
    #[test]
    fn milestone_reaching_a_milestone_puts_one_line_in_the_feed() {
        let mut app = App::new();
        app.insert_resource(City {
            population: 260,
            ..City::default()
        })
        .init_resource::<Milestones>()
        .init_resource::<Notifications>()
        .add_systems(Update, track_milestones);
        app.update();
        app.update();

        let lines = app.world().resource::<Notifications>().messages();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0].text, "250 residents: School unlocked");
        assert_eq!(lines[0].kind, NotificationKind::Achievement);
        assert_eq!(lines[0].count, 1, "announced once, not every frame");
        assert!(
            app.world()
                .resource::<Milestones>()
                .is_unlocked(BuildingKind::School)
        );
    }
}
