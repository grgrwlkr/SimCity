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
use super::zone_depth::{MAX_ZONE_DEPTH, is_footprint_within_zone_depth};

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

    // Count currently under-construction buildings (GDD 10.3.3.1)
    let under_construction_count = p
        .q_buildings
        .iter()
        .filter(|b| {
            matches!(
                b.phase,
                super::components::BuildingPhase::UnderConstruction { .. }
            )
        })
        .count();

    // Limit parallel constructions (GDD 10.3.3.1: city-wide construction capacity)
    const MAX_PARALLEL_CONSTRUCTIONS: usize = 15;
    if under_construction_count >= MAX_PARALLEL_CONSTRUCTIONS {
        return; // Don't spawn new buildings if construction capacity is full
    }

    // Build a quick occupancy set to avoid double-spawning if something went out of sync.
    // Track all tiles occupied by building footprints
    let mut occupied = HashSet::<TilePos>::new();
    for b in &p.q_buildings {
        for tile in b.footprint_tiles() {
            occupied.insert(tile);
        }
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
        let seed_pos = TilePos { x, y };

        // Check if seed tile is valid for building
        let Some(cell) = p.grid.get(seed_pos) else {
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

        // Try to find a valid footprint starting from this seed position
        let Some(footprint) =
            find_best_footprint(seed_pos, kind, &p.grid, &occupied, p.land_value.as_deref())
        else {
            continue;
        };

        // Mark all footprint tiles in sim state (source of truth)
        let mut footprint_tiles = Vec::new();
        for tile in footprint.tiles.iter() {
            if let Some(mut cell) = p.grid.get(*tile) {
                cell.building = Some(kind);
                p.grid.set(*tile, cell);
                if let Some(idx) = p.grid.idx(*tile) {
                    p.dirty.mark(idx);
                }
                footprint_tiles.push(*tile);
            }
        }

        // Spawn render entity with footprint
        spawn_building_entity(
            &mut p.commands,
            &p.cfg,
            footprint.anchor,
            footprint.width,
            footprint.length,
            kind,
            &p.city,
        );

        // Mark all footprint tiles as occupied
        for tile in &footprint_tiles {
            occupied.insert(*tile);
        }
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

        // Population is now calculated from occupancy, not added here
        // Occupancy will be updated by the occupancy system when the building becomes operational
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

/// Represents a valid building footprint
struct Footprint {
    anchor: TilePos,
    width: u8,
    length: u8,
    tiles: Vec<TilePos>,
}

/// Find the best valid footprint starting from a seed position.
/// Algorithm from GDD 10.1.3: priority is area → length → width.
/// Tries footprints from 6x6 down to 3x3, checking all orientations.
fn find_best_footprint(
    seed_pos: TilePos,
    kind: BuildingKind,
    grid: &MapGrid,
    occupied: &HashSet<TilePos>,
    land_value: Option<&LandValueIndex>,
) -> Option<Footprint> {
    // Generate all possible footprints sorted by priority: area → length → width
    // GDD 10.1.3: priority is area (desc), then length (desc), then width (desc)
    // This means: 6x6, then 6x5, 5x6, then 6x4, 4x6, 5x5, then 6x3, 3x6, 5x4, 4x5, etc.
    let mut candidates = Vec::new();
    // Generate all valid (width, length) pairs where both are 3-6
    for w in 3..=6 {
        for l in 3..=6 {
            candidates.push((w as u8, l as u8));
        }
    }

    // Sort by priority: area (desc), then length (desc), then width (desc)
    candidates.sort_by(|a, b| {
        let area_a = (a.0 as u32) * (a.1 as u32);
        let area_b = (b.0 as u32) * (b.1 as u32);
        area_b
            .cmp(&area_a)
            .then_with(|| b.1.cmp(&a.1)) // length desc
            .then_with(|| b.0.cmp(&a.0)) // width desc
    });

    // Try each candidate footprint, checking if it can be placed starting from seed_pos
    for (width, length) in candidates {
        // Try placing the footprint with seed_pos as anchor
        if let Some(footprint) =
            try_footprint_at(seed_pos, width, length, kind, grid, occupied, land_value)
        {
            return Some(footprint);
        }

        // Also try placing with seed_pos at different corners of the footprint
        // This allows finding footprints that contain the seed but don't start at it
        for anchor_offset in [
            (0, 0),
            (-(width as i32 - 1), 0),
            (0, -(length as i32 - 1)),
            (-(width as i32 - 1), -(length as i32 - 1)),
        ] {
            let anchor = TilePos {
                x: seed_pos.x + anchor_offset.0,
                y: seed_pos.y + anchor_offset.1,
            };
            if let Some(footprint) =
                try_footprint_at(anchor, width, length, kind, grid, occupied, land_value)
            {
                return Some(footprint);
            }
        }
    }

    None
}

/// Try to place a footprint at a specific anchor position.
/// Returns Some(Footprint) if valid, None otherwise.
fn try_footprint_at(
    anchor: TilePos,
    width: u8,
    length: u8,
    kind: BuildingKind,
    grid: &MapGrid,
    occupied: &HashSet<TilePos>,
    land_value: Option<&LandValueIndex>,
) -> Option<Footprint> {
    let mut tiles = Vec::new();
    let required_zone = kind.as_zone();

    // Check all tiles in the footprint
    for dx in 0..(width as i32) {
        for dy in 0..(length as i32) {
            let tile = TilePos {
                x: anchor.x + dx,
                y: anchor.y + dy,
            };

            // Check if tile is valid
            let Some(cell) = grid.get(tile) else {
                return None;
            };

            // Check basic constraints
            if cell.water || cell.road.is_some() || cell.building.is_some() {
                return None;
            }

            // Check zone matches
            if cell.zone != required_zone {
                return None;
            }

            // Check not occupied by another building footprint
            if occupied.contains(&tile) {
                return None;
            }

            tiles.push(tile);
        }
    }

    // Check zone depth (GDD 10.2.2): all tiles must be within 6 tiles of a road
    if !is_footprint_within_zone_depth(anchor, width, length, grid, MAX_ZONE_DEPTH) {
        return None;
    }

    // Check road access: at least one tile must have adjacent road
    let mut has_road_access = false;
    for tile in &tiles {
        if has_adjacent_road(grid, *tile) {
            has_road_access = true;
            break;
        }
    }
    if !has_road_access {
        return None;
    }

    // Check land value requirement (use minimum value from all tiles in footprint)
    if let Some(land_val) = land_value {
        let min_value = match kind {
            BuildingKind::Residential => 0.3,
            BuildingKind::Commercial => 0.4,
            BuildingKind::Industrial => 0.0,
            _ => 0.0,
        };
        if min_value > 0.0 {
            let mut all_valid = true;
            for tile in &tiles {
                if let Some(idx) = grid.idx(*tile) {
                    let value = land_val.get(idx);
                    if value < min_value {
                        all_valid = false;
                        break;
                    }
                }
            }
            if !all_valid {
                return None;
            }
        }
    }

    Some(Footprint {
        anchor,
        width,
        length,
        tiles,
    })
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
