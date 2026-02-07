use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::map::{DirtyTiles, MapGrid, TilePos};
use crate::game::sim::City;
use crate::game::sim_events::DayAdvanced;

use super::components::*;
use super::footprint::{all_footprint_tiles, any_footprint_tile, for_each_footprint_tile};

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
        let all_valid = all_footprint_tiles(
            b.anchor_pos,
            b.footprint_width,
            b.footprint_length,
            |tile| {
                grid.get(tile)
                    .is_some_and(|cell| !cell.water && cell.building == Some(b.kind))
            },
        );
        if !all_valid {
            commands.entity(e).despawn();
        }
    }
}

/// GDD: Buildings without road access are demolished after 1 game day
pub fn building_decay_no_road_access(
    mut day_events: MessageReader<'_, '_, DayAdvanced>,
    mut commands: Commands,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    city: Res<City>,
    mut q: Query<(
        Entity,
        &Building,
        Option<&NoRoadAccessDecay>,
        Option<&mut Sprite>,
    )>,
) {
    // Check if any days advanced (only process decay on day changes)
    let _days_advanced = day_events.read().count();
    let current_day = city.day;

    for (e, b, decay, sprite) in q.iter_mut() {
        // Check if any tile in footprint has road access
        let has_access = any_footprint_tile(
            b.anchor_pos,
            b.footprint_width,
            b.footprint_length,
            |tile| has_adjacent_road(&grid, tile),
        );

        if has_access {
            if decay.is_some() {
                commands.entity(e).remove::<NoRoadAccessDecay>();
            }
            // Restore normal color for service buildings
            if let Some(mut sprite) = sprite
                && matches!(
                    b.kind,
                    crate::game::map::BuildingKind::FireStation
                        | crate::game::map::BuildingKind::PoliceStation
                        | crate::game::map::BuildingKind::Hospital
                )
            {
                sprite.color = b.kind.color();
            }
            continue;
        }

        // No access: track when access was lost and check if grace period expired
        let access_lost_day = decay
            .as_ref()
            .map(|d| d.access_lost_day)
            .unwrap_or(current_day); // If decay component doesn't exist, start tracking now

        // Check if grace period expired (GDD: 1 game day)
        let days_without_access = current_day.saturating_sub(access_lost_day);

        // Only add/update component if not expired yet (avoid adding component to entity we're about to despawn)
        if days_without_access < NO_ROAD_ACCESS_GRACE_DAYS {
            // Verify building still exists in grid before adding component
            // (another system might have despawned it)
            let building_still_valid = grid
                .get(b.anchor_pos)
                .map(|cell| {
                    cell.building == Some(b.kind) && !cell.water && cell.zone == b.kind.as_zone()
                })
                .unwrap_or(false);

            if !building_still_valid {
                // Building was despawned by another system, skip
                continue;
            }

            // GDD 10.5.1: Visual indicator for service buildings without road access
            if matches!(
                b.kind,
                crate::game::map::BuildingKind::FireStation
                    | crate::game::map::BuildingKind::PoliceStation
                    | crate::game::map::BuildingKind::Hospital
            ) && let Some(mut sprite) = sprite
            {
                // Change color to red to indicate problem (GDD: visual marking for player)
                sprite.color = bevy::prelude::Color::srgb(1.0, 0.3, 0.3); // Red tint
            }

            // Add decay component if not present
            if decay.is_none() {
                commands.entity(e).insert(NoRoadAccessDecay {
                    access_lost_day: current_day,
                });
            }
            continue;
        }

        // Grace period expired - demolish the building
        // GDD 10.5.1: Visual indicator for service buildings without road access (already shown above)
        if matches!(
            b.kind,
            crate::game::map::BuildingKind::FireStation
                | crate::game::map::BuildingKind::PoliceStation
                | crate::game::map::BuildingKind::Hospital
        ) && let Some(mut sprite) = sprite
        {
            // Keep red color as warning (building will be demolished)
            sprite.color = bevy::prelude::Color::srgb(1.0, 0.3, 0.3);
        }

        // Demolish: remove from sim state and despawn entity.
        // Clear all footprint tiles
        for_each_footprint_tile(
            b.anchor_pos,
            b.footprint_width,
            b.footprint_length,
            |tile| {
                if let Some(mut cell) = grid.get(tile)
                    && cell.building == Some(b.kind)
                {
                    cell.building = None;
                    grid.set(tile, cell);
                    if let Some(idx) = grid.idx(tile) {
                        dirty.mark(idx);
                    }
                }
            },
        );

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
