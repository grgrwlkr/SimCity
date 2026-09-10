use bevy::prelude::*;
use rand::RngExt;

use super::components::*;
use crate::game::demand::RciDemand;
use crate::game::map::BuildingKind;
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sim::City;

#[allow(clippy::too_many_arguments)]
pub fn upgrade_buildings(
    time: Res<Time<Fixed>>,
    demand: Res<RciDemand>,
    mut rng: ResMut<BuildingGrowthRng>,
    _city: ResMut<City>,
    mut notifications: Option<ResMut<Notifications>>,
    mut upgrade_clock: ResMut<BuildingUpgradeClock>,
    mut q_buildings: Query<&mut Building>,
) {
    let dt = time.delta_secs();

    upgrade_clock
        .timer
        .tick(std::time::Duration::from_secs_f32(dt.max(0.0)));
    if !upgrade_clock.timer.just_finished() {
        return;
    }

    for mut building in q_buildings.iter_mut() {
        // Only upgrade residential, commercial, and industrial buildings
        if !matches!(
            building.kind,
            BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
        ) {
            continue;
        }

        // Already at max level
        if building.level >= 3 {
            continue;
        }

        // Check demand
        let demand_ok = match building.kind {
            BuildingKind::Residential => demand.residential > 0.3,
            BuildingKind::Commercial => demand.commercial > 0.3,
            BuildingKind::Industrial => demand.industrial > 0.3,
            _ => false,
        };

        if !demand_ok {
            continue;
        }

        // Random chance to upgrade (5% per check)
        if rng.rng.random_range(0.0..1.0) > 0.05 {
            continue;
        }

        // Upgrade!
        building.level += 1;

        // Update capacity
        let area = building.area();
        building.capacity_residents = building
            .kind
            .capacity_residents_for_level_area(building.level, area);
        building.capacity_jobs = building
            .kind
            .capacity_jobs_for_level_area(building.level, area);

        // Population is now calculated from occupancy, not updated here
        // The occupancy system will adjust occupancy_residents based on new capacity and demand

        // Visuals rebuild themselves: `rebuild_building_visuals` reacts to
        // Changed<Building> and swaps in the taller level mesh.

        // Emit notification
        if let Some(ref mut notif) = notifications {
            notif.add_at(
                upgrade_notice(building.kind, building.level),
                NotificationKind::Info,
                3.0,
                building.anchor_pos,
            );
        }
    }
}

/// The feed line for an upgrade. One kind of event is one line of the feed, so neither the zone
/// nor the level may enter it: those details would split one stream into several lines.
pub(crate) fn upgrade_notice(_kind: BuildingKind, _level: u8) -> String {
    "Building upgraded".to_string()
}

#[cfg(test)]
mod notice_tests {
    use super::*;

    #[test]
    fn notification_dedup_every_upgrade_is_the_same_line() {
        let line = upgrade_notice(BuildingKind::Residential, 2);
        assert!(!line.is_empty());
        for (kind, level) in [
            (BuildingKind::Residential, 3),
            (BuildingKind::Commercial, 2),
            (BuildingKind::Industrial, 3),
        ] {
            assert_eq!(
                upgrade_notice(kind, level),
                line,
                "{kind:?} to level {level}"
            );
        }
    }
}
