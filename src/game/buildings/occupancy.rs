use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::demand::RciDemand;
use crate::game::sim_events::DayAdvanced;

use super::components::Building;
use crate::game::map::BuildingKind;

/// Calculate pressure from demand using sigmoid function (GDD 10.3.5.1)
/// pressure(d) = 1 / (1 + e^(-k(d - d_mid)))
/// where d_mid=0.3, k=6.0
pub(crate) fn calculate_pressure(demand: f32, d_mid: f32, k: f32) -> f32 {
    let exp_arg = -k * (demand - d_mid);
    1.0 / (1.0 + exp_arg.exp())
}

/// Calculate target occupancy ratio from pressure (GDD 10.3.5.2)
/// target_ratio = clamp(2 * pressure(d), 0, 1)
pub(crate) fn calculate_target_ratio(pressure: f32) -> f32 {
    (2.0 * pressure).clamp(0.0, 1.0)
}

/// Calculate fill days based on level, area, and pressure (GDD 10.3.5.3)
pub(crate) fn calculate_fill_days(level: u8, area: u32, pressure: f32) -> f32 {
    // Base fill days for 3x3
    let base_fill_days = match level {
        1 => 1.0,
        2 => 2.0,
        3 => 3.5,
        _ => 1.0,
    };

    // Scale by area: fill_days_mid = base_fill_days * sqrt(area / 9)
    let fill_days_mid = base_fill_days * (area as f32 / 9.0).sqrt();

    // Scale by pressure: fill_days = fill_days_mid * (0.5 / max(ε, pressure))^γ
    // where γ=3, ε=0.05
    const GAMMA: f32 = 3.0;
    const EPSILON: f32 = 0.05;
    const FILL_DAYS_MAX: f32 = 60.0;

    let pressure_clamped = pressure.max(EPSILON);
    let fill_days = fill_days_mid * (0.5 / pressure_clamped).powf(GAMMA);
    fill_days.clamp(1.0, FILL_DAYS_MAX)
}

/// Update occupancy for all operational buildings (GDD 10.3.5)
/// Called when DayAdvanced event is published
pub fn update_occupancy(
    mut day_events: MessageReader<DayAdvanced>,
    demand: Res<RciDemand>,
    mut q_buildings: Query<&mut Building>,
    grid: Res<crate::game::map::MapGrid>,
) {
    // Process all DayAdvanced events (usually one per day transition)
    for _event in day_events.read() {
        for mut building in q_buildings.iter_mut() {
            // Only update occupancy for operational buildings
            if !building.is_operational() {
                continue;
            }

            // GDD 10.5.1: Buildings without road access cannot function
            let mut has_road_access = false;
            for tile in building.footprint_tiles() {
                // Check if tile has adjacent road
                for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                    let neighbor = crate::game::map::TilePos {
                        x: tile.x + dx,
                        y: tile.y + dy,
                    };
                    if let Some(cell) = grid.get(neighbor) {
                        if cell.road.is_some() {
                            has_road_access = true;
                            break;
                        }
                    }
                }
                if has_road_access {
                    break;
                }
            }

            // If no road access, set target occupancy to 0 and decrease current occupancy
            if !has_road_access {
                building.target_occupancy_residents = 0;
                building.target_occupancy_jobs = 0;
                // Gradually decrease occupancy (people/jobs leave)
                if building.occupancy_residents > 0 {
                    building.occupancy_residents = building.occupancy_residents.saturating_sub(1);
                }
                if building.occupancy_jobs > 0 {
                    building.occupancy_jobs = building.occupancy_jobs.saturating_sub(1);
                }
                continue;
            }

            // Get demand for this building type
            let demand_value = match building.kind {
                BuildingKind::Residential => demand.residential,
                BuildingKind::Commercial => demand.commercial,
                BuildingKind::Industrial => demand.industrial,
                _ => 0.0, // Services don't have occupancy based on demand
            };

            // Calculate pressure and target ratio
            const D_MID: f32 = 0.3;
            const K: f32 = 6.0;
            let pressure = calculate_pressure(demand_value, D_MID, K);
            let target_ratio = calculate_target_ratio(pressure);

            // Calculate target occupancy
            let target_residents =
                ((building.capacity_residents as f32) * target_ratio).round() as u16;
            let target_jobs = ((building.capacity_jobs as f32) * target_ratio).round() as u16;

            building.target_occupancy_residents = target_residents;
            building.target_occupancy_jobs = target_jobs;

            // Gradually move occupancy towards target
            // Calculate how much to change per day based on fill_days
            let area = building.area();
            let fill_days = calculate_fill_days(building.level, area, pressure);
            let change_per_day = 1.0 / fill_days.max(1.0);

            // Update residents
            let current_residents = building.occupancy_residents as f32;
            let target_residents_f = target_residents as f32;
            if current_residents < target_residents_f {
                let new_residents = (current_residents + change_per_day).min(target_residents_f);
                building.occupancy_residents = new_residents.round() as u16;
            } else if current_residents > target_residents_f {
                let new_residents = (current_residents - change_per_day).max(target_residents_f);
                building.occupancy_residents = new_residents.round() as u16;
            }

            // Update jobs
            let current_jobs = building.occupancy_jobs as f32;
            let target_jobs_f = target_jobs as f32;
            if current_jobs < target_jobs_f {
                let new_jobs = (current_jobs + change_per_day).min(target_jobs_f);
                building.occupancy_jobs = new_jobs.round() as u16;
            } else if current_jobs > target_jobs_f {
                let new_jobs = (current_jobs - change_per_day).max(target_jobs_f);
                building.occupancy_jobs = new_jobs.round() as u16;
            }
        }
    }
}
