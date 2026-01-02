use bevy::prelude::*;

use super::{MapConfig, TilePos};

pub(super) fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

pub(super) fn world_to_tile(cfg: &MapConfig, world: Vec2) -> Option<TilePos> {
    let origin = map_origin(cfg);
    let local = world - origin;

    let x = (local.x / cfg.tile_size).round() as i32;
    let y = (local.y / cfg.tile_size).round() as i32;

    if x < 0 || y < 0 || x >= cfg.width || y >= cfg.height {
        return None;
    }

    Some(TilePos { x, y })
}

pub(super) fn cursor_tile(
    cfg: &MapConfig,
    window: &Window,
    camera: &Camera,
    cam_gt: &GlobalTransform,
) -> Option<TilePos> {
    let cursor = window.cursor_position()?;
    let world = camera.viewport_to_world_2d(cam_gt, cursor).ok()?;
    world_to_tile(cfg, world)
}
