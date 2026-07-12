//! Canonical tile <-> world mapping. THE ONLY place this formula lives.
//!
//! The sim's logical world is the XY plane; the map is centered on the world
//! origin. Every producer of world positions (render sync, spawns, overlays,
//! persistence, picking) must go through these functions so the projection
//! can change in exactly one place (pseudo-3D migration, phase 2+).

use bevy::math::Vec2;

use super::{MapConfig, TilePos};

/// World-space center of tile (0,0). The map is centered on the world origin.
pub fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

/// Center of `tile` in logical world coordinates.
pub fn tile_to_world(cfg: &MapConfig, tile: TilePos) -> Vec2 {
    tile_f_to_world(cfg, tile.x as f32, tile.y as f32)
}

/// Fractional tile coordinates -> logical world (multi-tile footprint centers,
/// sub-tile offsets like lane centers and parking bays).
pub fn tile_f_to_world(cfg: &MapConfig, tile_x: f32, tile_y: f32) -> Vec2 {
    map_origin(cfg) + Vec2::new(tile_x * cfg.tile_size, tile_y * cfg.tile_size)
}

/// Inverse mapping with round-to-nearest semantics (picking). None outside the map.
pub fn world_to_tile(cfg: &MapConfig, world: Vec2) -> Option<TilePos> {
    let local = world - map_origin(cfg);
    let x = (local.x / cfg.tile_size).round() as i32;
    let y = (local.y / cfg.tile_size).round() as i32;
    if x < 0 || y < 0 || x >= cfg.width || y >= cfg.height {
        return None;
    }
    Some(TilePos { x, y })
}
