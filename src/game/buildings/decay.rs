use bevy::prelude::*;

use crate::game::map::{DirtyTiles, MapGrid, TilePos};
use crate::game::sim::City;
use crate::game::ui_state::UiState;

use super::components::*;

pub fn despawn_invalid_buildings(
    mut commands: Commands,
    grid: Res<MapGrid>,
    q: Query<(Entity, &Building)>,
) {
    for (e, b) in &q {
        // Check if anchor position is valid
        let Some(cell) = grid.get(b.anchor_pos) else {
            commands.entity(e).despawn();
            continue;
        };
        let expected_zone = b.kind.as_zone();
        // Check if anchor cell matches expected building
        if cell.water || cell.zone != expected_zone || cell.building != Some(b.kind) {
            commands.entity(e).despawn();
            continue;
        }
        // Check all footprint tiles are still valid
        let mut all_valid = true;
        for tile in b.footprint_tiles() {
            if let Some(cell) = grid.get(tile) {
                if cell.water || cell.building != Some(b.kind) {
                    all_valid = false;
                    break;
                }
            } else {
                all_valid = false;
                break;
            }
        }
        if !all_valid {
            commands.entity(e).despawn();
        }
    }
}

pub fn building_decay_no_road_access(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    mut commands: Commands,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    _city: ResMut<City>,
    mut q: Query<(
        Entity,
        &Building,
        Option<&mut NoRoadAccessDecay>,
        Option<&mut Sprite>,
    )>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed.clamp(0.0, 8.0);

    for (e, b, decay, sprite) in q.iter_mut() {
        // Check if any tile in footprint has road access
        let mut has_access = false;
        for tile in b.footprint_tiles() {
            if has_adjacent_road(&grid, tile) {
                has_access = true;
                break;
            }
        }

        if has_access {
            if decay.is_some() {
                commands.entity(e).remove::<NoRoadAccessDecay>();
            }
            // Restore normal color for service buildings
            if let Some(mut sprite) = sprite {
                if matches!(
                    b.kind,
                    crate::game::map::BuildingKind::FireStation
                        | crate::game::map::BuildingKind::PoliceStation
                        | crate::game::map::BuildingKind::Hospital
                ) {
                    sprite.color = b.kind.color();
                }
            }
            continue;
        }

        // No access: start or tick countdown.
        let mut remaining = decay
            .as_deref()
            .map(|d| d.remaining_secs)
            .unwrap_or(NO_ROAD_ACCESS_GRACE_SECS);
        remaining -= dt;

        // GDD 10.5.1: Visual indicator for service buildings without road access
        if matches!(
            b.kind,
            crate::game::map::BuildingKind::FireStation
                | crate::game::map::BuildingKind::PoliceStation
                | crate::game::map::BuildingKind::Hospital
        ) {
            if let Some(mut sprite) = sprite {
                // Change color to red to indicate problem (GDD: visual marking for player)
                sprite.color = bevy::prelude::Color::srgb(1.0, 0.3, 0.3); // Red tint
            }
        }

        if remaining > 0.0 {
            commands.entity(e).insert(NoRoadAccessDecay {
                remaining_secs: remaining,
            });
            continue;
        }

        // Demolish: remove from sim state and despawn entity.
        // Clear all footprint tiles
        for tile in b.footprint_tiles() {
            if let Some(mut cell) = grid.get(tile) {
                if cell.building == Some(b.kind) {
                    cell.building = None;
                    grid.set(tile, cell);
                    if let Some(idx) = grid.idx(tile) {
                        dirty.mark(idx);
                    }
                }
            }
        }

        // Population is now calculated from occupancy, not subtracted here
        // The occupancy system will handle population changes

        commands.entity(e).despawn();
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
