use bevy::prelude::*;

use crate::game::map::{BuildingKind, MapConfig, TilePos};

use super::components::*;

pub fn spawn_building_entity(
    commands: &mut Commands,
    cfg: &MapConfig,
    pos: TilePos,
    kind: BuildingKind,
) {
    let origin = map_origin(cfg);
    let world = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
    let mut tf = Transform::from_translation(Vec3::new(world.x, world.y, 8.0));
    tf.scale = Vec3::splat(building_visual_scale(1));

    commands.spawn((
        Building {
            kind,
            pos,
            level: 1, // Start at level 1
            capacity_residents: kind.capacity_residents_for_level(1),
            capacity_jobs: kind.capacity_jobs_for_level(1),
        },
        Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size)),
        tf,
    ));
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}
