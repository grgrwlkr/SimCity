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

    // Check if notifications are available once
    let has_notifications = notifications.is_some();

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
        if has_notifications {
            let level_name = match building.level {
                1 => "I",
                2 => "II",
                3 => "III",
                _ => "?",
            };
            let kind_name = match building.kind {
                BuildingKind::Residential => "Residential",
                BuildingKind::Commercial => "Commercial",
                BuildingKind::Industrial => "Industrial",
                _ => "Building",
            };
            if let Some(ref mut notif) = notifications {
                notif.add(
                    format!("{} building upgraded to level {}", kind_name, level_name),
                    NotificationKind::Info,
                    3.0,
                );
            }
        }
    }
}
