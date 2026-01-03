use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::{Rng, SeedableRng, rngs::StdRng};
use std::collections::HashSet;

use crate::game::demand::RciDemand;
use crate::game::land_value::LandValueIndex;
use crate::game::map::{BuildingKind, DirtyTiles, MapConfig, MapGrid, TilePos};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sim::City;
use crate::game::ui_state::UiState;

use super::components::*;
use super::spawn::spawn_building_entity;

#[derive(SystemParam)]
pub struct GrowBuildingsParams<'w, 's> {
    time: Res<'w, Time<Fixed>>,
    ui: Res<'w, UiState>,
    cfg: Res<'w, MapConfig>,
    grid: ResMut<'w, MapGrid>,
    demand: Res<'w, RciDemand>,
    land_value: Option<Res<'w, LandValueIndex>>,
    city: ResMut<'w, City>,
    clock: ResMut<'w, BuildingGrowthClock>,
    rng: ResMut<'w, BuildingGrowthRng>,
    dirty: ResMut<'w, DirtyTiles>,
    commands: Commands<'w, 's>,
    q_buildings: Query<'w, 's, &'static Building>,
    notifications: Option<ResMut<'w, Notifications>>,
}

pub fn grow_buildings(mut p: GrowBuildingsParams) {
    let speed = p.ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }

    p.clock
        .timer
        .tick(p.time.delta().mul_f32(speed.clamp(0.0, 8.0)));
    if !p.clock.timer.just_finished() {
        return;
    }

    // Limit growth per tick (MVP).
    let max_spawns = 6usize;
    let mut spawned = 0usize;

    // Build a quick occupancy set to avoid double-spawning if something went out of sync.
    let mut occupied = HashSet::<TilePos>::new();
    for b in &p.q_buildings {
        occupied.insert(b.pos);
    }

    let len = p.grid.len();
    if len == 0 {
        return;
    }

    // Random attempts instead of full scan (cheap + scalable).
    for _ in 0..128 {
        if spawned >= max_spawns {
            break;
        }

        let idx = p.rng.rng.random_range(0..len);
        let x = (idx % (p.grid.width as usize)) as i32;
        let y = (idx / (p.grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        if occupied.contains(&pos) {
            continue;
        }

        let Some(mut cell) = p.grid.get(pos) else {
            continue;
        };
        if cell.water || cell.road.is_some() || cell.building.is_some() {
            continue;
        }

        let Some(kind) = BuildingKind::from_zone(cell.zone) else {
            continue;
        };
        if !demand_allows_growth(&p.demand, kind) {
            continue;
        }
        if !has_adjacent_road(&p.grid, pos) {
            continue;
        }

        // Check land value requirement
        if let Some(land_val) = p.land_value.as_deref()
            && let Some(idx) = p.grid.idx(pos)
        {
            let value = land_val.get(idx);
            let min_value = match kind {
                BuildingKind::Residential => 0.3,
                BuildingKind::Commercial => 0.4,
                BuildingKind::Industrial => 0.0, // Industrial doesn't depend on land value
                _ => 0.0,
            };
            if value < min_value {
                continue;
            }
        }

        // Mark in sim state first (source of truth).
        cell.building = Some(kind);
        p.grid.set(pos, cell);
        p.dirty.mark(idx);

        // Spawn render entity.
        spawn_building_entity(&mut p.commands, &p.cfg, pos, kind);
        occupied.insert(pos);
        spawned += 1;

        // Emit notification
        if let Some(ref mut notif) = p.notifications {
            let kind_name = match kind {
                BuildingKind::Residential => "Residential",
                BuildingKind::Commercial => "Commercial",
                BuildingKind::Industrial => "Industrial",
                _ => "Building",
            };
            notif.add(
                format!("New {} building constructed", kind_name),
                NotificationKind::Info,
                3.0,
            );
        }

        // Capacity-based effects (MVP).
        if kind == BuildingKind::Residential {
            p.city.population = p
                .city
                .population
                .saturating_add(kind.capacity_residents_for_level(1) as u32);
        }
    }
}

fn demand_allows_growth(demand: &RciDemand, kind: BuildingKind) -> bool {
    match kind {
        BuildingKind::Residential => demand.residential > 0.0,
        BuildingKind::Commercial => demand.commercial > 0.0,
        BuildingKind::Industrial => demand.industrial > 0.0,
        _ => true,
    }
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    let neighbors = [
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ];

    for npos in neighbors {
        if let Some(cell) = grid.get(npos)
            && cell.road.is_some()
        {
            return true;
        }
    }
    false
}

pub fn seed_growth_rng_from_map(
    seed: Res<crate::game::map::MapSeed>,
    mut rng: ResMut<BuildingGrowthRng>,
) {
    rng.rng = StdRng::seed_from_u64(seed.0);
}

pub fn reset_growth_rng_on_new_map(
    mut reader: bevy::ecs::message::MessageReader<crate::game::commands::GameCommand>,
    seed: Res<crate::game::map::MapSeed>,
    mut rng: ResMut<BuildingGrowthRng>,
) {
    for cmd in reader.read() {
        if matches!(cmd, crate::game::commands::GameCommand::GenerateMap { .. }) {
            rng.rng = StdRng::seed_from_u64(seed.0);
        }
    }
}
