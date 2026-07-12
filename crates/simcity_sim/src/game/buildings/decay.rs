use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::economy::EconomyConfig;
use crate::game::map::{DirtyTiles, MapGrid, TilePos};
use crate::game::sim::City;
use crate::game::sim_events::DayAdvanced;

use super::components::*;
use super::footprint::{all_footprint_tiles, any_footprint_tile, for_each_footprint_tile};
use super::visual::BuildingTint;

pub fn despawn_invalid_buildings(
    mut commands: Commands,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    q: Query<(Entity, &Building)>,
) {
    // A despawn MUST release the building's grid cells: an entity-less cell with
    // `building` still set is a phantom tile that permanently blocks zoning and
    // placement (both validators reject occupied cells) and has no owner the
    // whole-building erase could find.
    for (e, b) in &q {
        // Check if anchor position is valid
        let Some(cell) = grid.get(b.anchor_pos) else {
            clear_footprint_cells(&mut grid, &mut dirty, b);
            commands.entity(e).despawn();
            continue;
        };
        let expected_zone = b.kind.as_zone();
        // Check if anchor cell matches expected building
        if cell.water || cell.zone != expected_zone || cell.building != Some(b.kind) {
            clear_footprint_cells(&mut grid, &mut dirty, b);
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
            clear_footprint_cells(&mut grid, &mut dirty, b);
            commands.entity(e).despawn();
        }
    }
}

/// Clear the building layer of `b`'s footprint cells (only those still owned
/// by its kind — a cell already overwritten by another building is left alone).
fn clear_footprint_cells(grid: &mut MapGrid, dirty: &mut DirtyTiles, b: &Building) {
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
}

/// Insert/remove the decay warning tint only when it actually changes —
/// re-inserting an identical tint every day would retrigger
/// `Changed<BuildingTint>` and make the render side rebuild for nothing.
fn set_tint(
    commands: &mut Commands,
    e: Entity,
    current: Option<&BuildingTint>,
    want: Option<Color>,
) {
    match (current, want) {
        (Some(c), Some(w)) if c.0 == w => {}
        (None, None) => {}
        (_, Some(w)) => {
            commands.entity(e).insert(BuildingTint(w));
        }
        (Some(_), None) => {
            commands.entity(e).remove::<BuildingTint>();
        }
    }
}

/// GDD: Buildings without road access are demolished after 1 game day
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
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
        Option<&BuildingTint>,
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
            if matches!(
                b.kind,
                crate::game::map::BuildingKind::FireStation
                    | crate::game::map::BuildingKind::PoliceStation
                    | crate::game::map::BuildingKind::Hospital
            ) {
                set_tint(&mut commands, e, sprite, None);
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
            ) {
                // Change color to red to indicate problem (GDD: visual marking for player)
                set_tint(&mut commands, e, sprite, Some(Color::srgb(1.0, 0.3, 0.3)));
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
        ) {
            // Keep red color as warning (building will be demolished)
            set_tint(&mut commands, e, sprite, Some(Color::srgb(1.0, 0.3, 0.3)));
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

/// Track and process building decay due to low happiness.
///
/// Buildings with average happiness below LOW_HAPPINESS_THRESHOLD for LOW_HAPPINESS_GRACE_DAYS
/// become abandoned and are demolished.
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
pub fn building_decay_low_happiness(
    mut day_events: MessageReader<'_, '_, DayAdvanced>,
    mut commands: Commands,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    city: Res<City>,
    economy_cfg: Res<EconomyConfig>,
    mut q: Query<(
        Entity,
        &Building,
        Option<&LowHappinessDecay>,
        Option<&BuildingTint>,
    )>,
) {
    let _days_advanced = day_events.read().count();
    let current_day = city.day;

    // Calculate target happiness based on economy config
    let _target_happiness = economy_cfg.happiness_target;

    for (e, b, decay, sprite) in q.iter_mut() {
        // Only residential and commercial buildings have happiness
        if !matches!(
            b.kind,
            crate::game::map::BuildingKind::Residential
                | crate::game::map::BuildingKind::Commercial
        ) {
            continue;
        }

        // Skip buildings under construction
        if !b.is_operational() {
            continue;
        }

        // Calculate approximate happiness based on occupancy vs target
        // This is a simplified model - real happiness would come from citizen simulation
        let occupancy_ratio = if b.kind == crate::game::map::BuildingKind::Residential {
            b.occupancy_residents as f32 / b.capacity_residents as f32
        } else {
            b.occupancy_jobs as f32 / b.capacity_jobs as f32
        };

        // Happiness is high when occupancy is close to target
        let estimated_happiness = occupancy_ratio.clamp(0.0, 1.0);

        if estimated_happiness >= LOW_HAPPINESS_THRESHOLD {
            // Happiness recovered - remove decay component
            if decay.is_some() {
                commands.entity(e).remove::<LowHappinessDecay>();
                // Restore normal sprite color
                {
                    set_tint(&mut commands, e, sprite, None);
                }
            }
            continue;
        }

        // Low happiness detected
        let decay_start_day = decay
            .as_ref()
            .map(|d| d.decay_start_day)
            .unwrap_or(current_day);

        let days_with_low_happiness = current_day.saturating_sub(decay_start_day);

        // Visual indicator: yellow/orange tint for struggling buildings
        if days_with_low_happiness < LOW_HAPPINESS_GRACE_DAYS {
            {
                // Yellow tint to indicate problems
                set_tint(&mut commands, e, sprite, Some(Color::srgb(1.0, 0.8, 0.3)));
            }

            // Add decay component if not present
            if decay.is_none() {
                commands.entity(e).insert(LowHappinessDecay {
                    decay_start_day: current_day,
                    avg_happiness: estimated_happiness,
                });
            }
            continue;
        }

        // Grace period expired - abandon building
        demolish_building(e, b, &mut commands, &mut grid, &mut dirty);
    }
}

/// Track and process building decay due to economic losses.
///
/// Buildings with cumulative losses below ECONOMIC_LOSSES_THRESHOLD are abandoned.
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
pub fn building_decay_economic(
    mut day_events: MessageReader<'_, '_, DayAdvanced>,
    mut commands: Commands,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    city: Res<City>,
    mut q: Query<(
        Entity,
        &Building,
        Option<&EconomicDecay>,
        Option<&BuildingTint>,
    )>,
) {
    let _days_advanced = day_events.read().count();
    let current_day = city.day;

    for (e, b, decay, sprite) in q.iter_mut() {
        // Only commercial and industrial buildings have economic concerns
        if !matches!(
            b.kind,
            crate::game::map::BuildingKind::Commercial | crate::game::map::BuildingKind::Industrial
        ) {
            continue;
        }

        // Skip buildings under construction
        if !b.is_operational() {
            continue;
        }

        // Calculate economic performance based on occupancy
        // Low occupancy = low income = losses
        let occupancy_ratio = b.occupancy_jobs as f32 / b.capacity_jobs as f32;

        // Estimate daily loss based on low occupancy
        // This is simplified - real economy would track actual money flow
        let estimated_daily_loss = if occupancy_ratio < 0.5 {
            -(((0.5 - occupancy_ratio) * 20.0) as i64) // Up to -10 per day
        } else {
            0
        };

        if estimated_daily_loss == 0 {
            // Economic recovery
            if decay.is_some() {
                commands.entity(e).remove::<EconomicDecay>();
                {
                    set_tint(&mut commands, e, sprite, None);
                }
            }
            continue;
        }

        let decay_start_day = decay
            .as_ref()
            .map(|d| d.decay_start_day)
            .unwrap_or(current_day);

        let days_with_losses = current_day.saturating_sub(decay_start_day);
        let cumulative_losses = (days_with_losses as i64) * estimated_daily_loss;

        if cumulative_losses > ECONOMIC_LOSSES_THRESHOLD {
            // Add/update decay component
            if decay.is_none() {
                commands.entity(e).insert(EconomicDecay {
                    decay_start_day: current_day,
                    cumulative_losses,
                });
            }

            // Visual indicator: purple tint for economic trouble
            {
                set_tint(&mut commands, e, sprite, Some(Color::srgb(0.8, 0.5, 1.0)));
            }
            continue;
        }

        // Economic losses exceeded threshold - abandon building
        demolish_building(e, b, &mut commands, &mut grid, &mut dirty);
    }
}

/// Helper function to demolish a building
fn demolish_building(
    e: Entity,
    b: &Building,
    commands: &mut Commands,
    grid: &mut ResMut<MapGrid>,
    dirty: &mut ResMut<DirtyTiles>,
) {
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

    commands.entity(e).despawn();
}
