use bevy::prelude::*;

use crate::game::map::{BuildingKind, MapConfig, TilePos, tile_f_to_world};
use crate::game::render_primitives::{RenderPrimitives, layer};
use crate::game::sim::City;

use super::components::*;

/// Spawn a building entity. If `spawn_operational` is true, the building is immediately
/// Operational (used e.g. for test city so simulation can run without waiting for construction).
#[allow(clippy::too_many_arguments)]
pub fn spawn_building_entity(
    commands: &mut Commands,
    cfg: &MapConfig,
    anchor_pos: TilePos,
    footprint_width: u8,
    footprint_length: u8,
    kind: BuildingKind,
    city: &City,
    spawn_operational: bool,
    prims: &mut RenderPrimitives,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
) {
    // Position at center of footprint
    let center_x = anchor_pos.x as f32 + (footprint_width as f32 - 1.0) * 0.5;
    let center_y = anchor_pos.y as f32 + (footprint_length as f32 - 1.0) * 0.5;
    let world = tile_f_to_world(cfg, center_x, center_y);
    let mut tf = Transform::from_translation(Vec3::new(world.x, world.y, layer::BUILDING));

    // Scale sprite to match footprint size
    let sprite_size = Vec2::new(
        footprint_width as f32 * cfg.tile_size,
        footprint_length as f32 * cfg.tile_size,
    );
    // Don't apply scale - sprite_size already matches the footprint exactly
    // Scale is only used for level-based visual growth in upgrade.rs
    tf.scale = Vec3::splat(1.0);

    let level = 1; // Start at level 1
    let area = (footprint_width as u32) * (footprint_length as u32);
    let construction_days = Building::calculate_construction_days(kind, level, area);

    // Calculate parking spots inside footprint (GDD 10.3.4)
    // Number of spots: max(1, area / 9)
    let num_spots = (area / 9).max(1) as usize;
    let parking_spots =
        calculate_parking_spots(anchor_pos, footprint_width, footprint_length, num_spots);

    let phase = if spawn_operational {
        BuildingPhase::Operational
    } else {
        BuildingPhase::UnderConstruction {
            days_remaining: construction_days,
        }
    };

    let mut building = commands.spawn((
        Building {
            kind,
            anchor_pos,
            footprint_width,
            footprint_length,
            level,
            phase,
            construction_start_day: city.day,
            capacity_residents: kind.capacity_residents_for_level_area(level, area),
            capacity_jobs: kind.capacity_jobs_for_level_area(level, area),
            occupancy_residents: 0,
            occupancy_jobs: 0,
            target_occupancy_residents: 0,
            target_occupancy_jobs: 0,
            parking_spots,
        },
        // Sized mesh (scale = 1): buildings carry glyph children that must not inherit scale.
        Mesh3d(prims.quad_mesh(meshes, sprite_size)),
        MeshMaterial3d(prims.material(materials, kind.color())),
        tf,
    ));
    let glyph_quad = prims.quad.clone();
    let glyph_mat = prims.material(materials, crate::game::services::glyphs::GLYPH_COLOR);
    crate::game::services::glyphs::attach_building_glyph(
        &mut building,
        kind,
        cfg.tile_size,
        glyph_quad,
        glyph_mat,
    );
}

/// Calculate parking spot positions inside building footprint (GDD 10.3.4)
/// Distributes spots evenly across the footprint.
pub fn calculate_parking_spots(
    anchor: TilePos,
    width: u8,
    length: u8,
    num_spots: usize,
) -> Vec<TilePos> {
    if num_spots == 0 {
        return Vec::new();
    }

    // Simple distribution: place spots in a grid pattern
    // For small footprints, just use the center or a few key positions
    let mut spots = Vec::new();

    if num_spots == 1 {
        // Single spot: center of footprint
        spots.push(TilePos {
            x: anchor.x + (width as i32 - 1) / 2,
            y: anchor.y + (length as i32 - 1) / 2,
        });
    } else {
        // Multiple spots: distribute in a grid
        let cols = (num_spots as f32).sqrt().ceil() as i32;
        let rows = ((num_spots as f32) / cols as f32).ceil() as i32;

        for i in 0..num_spots {
            let row = (i as i32) / cols;
            let col = (i as i32) % cols;

            // Map to footprint coordinates (avoid edges)
            let x_offset = if cols > 1 {
                (col * (width as i32 - 2)) / (cols - 1).max(1) + 1
            } else {
                width as i32 / 2
            };
            let y_offset = if rows > 1 {
                (row * (length as i32 - 2)) / (rows - 1).max(1) + 1
            } else {
                length as i32 / 2
            };

            spots.push(TilePos {
                x: anchor.x + x_offset.min(width as i32 - 1),
                y: anchor.y + y_offset.min(length as i32 - 1),
            });
        }
    }

    spots
}
