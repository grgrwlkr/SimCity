use bevy::prelude::*;
use rand::RngExt;

use super::components::*;
use crate::game::demand::RciDemand;
use crate::game::map::{BuildingKind, MapGrid};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sim::City;
use crate::game::utilities::UtilityNetwork;

#[allow(clippy::too_many_arguments)]
pub fn upgrade_buildings(
    time: Res<Time<Fixed>>,
    demand: Res<RciDemand>,
    mut rng: ResMut<BuildingGrowthRng>,
    _city: ResMut<City>,
    mut notifications: Option<ResMut<Notifications>>,
    mut upgrade_clock: ResMut<BuildingUpgradeClock>,
    mut q_buildings: Query<(&mut Building, &BuildingProfile)>,
    grid: Res<MapGrid>,
    network: Res<UtilityNetwork>,
    fields: Option<Res<crate::game::city_fields::CityFields>>,
) {
    let dt = time.delta_secs();

    upgrade_clock
        .timer
        .tick(std::time::Duration::from_secs_f32(dt.max(0.0)));
    if !upgrade_clock.timer.just_finished() {
        return;
    }

    for (mut building, profile) in q_buildings.iter_mut() {
        // Zoned buildings only, below the top level, with power, water and enough demand.
        if super::blockers::upgrade_blocker(
            &building,
            profile,
            &grid,
            &network,
            &demand,
            fields.as_deref(),
        )
        .is_some()
        {
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
        let (residents, jobs) = profile_capacity(building.kind, building.level, area, *profile);
        building.capacity_residents = residents;
        building.capacity_jobs = jobs;

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
