use bevy::prelude::*;
use rand::Rng;

use crate::game::demand::RciDemand;
use crate::game::map::{BuildingKind, MapConfig};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sim::City;
use crate::game::ui_state::UiState;

use super::components::*;

pub fn upgrade_buildings(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    demand: Res<RciDemand>,
    mut rng: ResMut<BuildingGrowthRng>,
    mut city: ResMut<City>,
    mut notifications: Option<ResMut<Notifications>>,
    mut upgrade_clock: ResMut<BuildingUpgradeClock>,
    cfg: Res<MapConfig>,
    mut q_buildings: Query<(&mut Building, &mut Transform, &mut Sprite)>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }

    let dt = time.delta_secs() * speed.clamp(0.0, 8.0);

    upgrade_clock
        .timer
        .tick(std::time::Duration::from_secs_f32(dt.max(0.0)));
    if !upgrade_clock.timer.just_finished() {
        return;
    }

    // Check if notifications are available once
    let has_notifications = notifications.is_some();

    for (mut building, mut transform, mut sprite) in q_buildings.iter_mut() {
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
        let old_residents = building.capacity_residents;

        building.capacity_residents = building.kind.capacity_residents_for_level(building.level);
        building.capacity_jobs = building.kind.capacity_jobs_for_level(building.level);

        // Update population if residential
        if building.kind == BuildingKind::Residential {
            let delta = building.capacity_residents.saturating_sub(old_residents);
            city.population = city.population.saturating_add(delta as u32);
        }

        // Visual change: size grows with level.
        // Sprite size is based on tile_size; Transform scale carries the level factor.
        sprite.custom_size = Some(Vec2::splat(cfg.tile_size));
        transform.scale = Vec3::splat(building_visual_scale(building.level));

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
