//! Canonical tile <-> world mapping. THE ONLY place this formula lives.
//!
//! The sim's logical world is the XY plane; the map is centered on the world
//! origin. Every producer of world positions (render sync, spawns, overlays,
//! persistence, picking) must go through these functions so the projection
//! can change in exactly one place (pseudo-3D migration, phase 2+).

use bevy::math::{Vec2, Vec3};
use bevy::prelude::{Camera, GlobalTransform};

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

/// Ray parameter `t` where `origin + t*dir` crosses the ground plane (z = 0).
/// None if the ray is parallel to the ground or points away from it.
pub fn ray_ground_t(origin: Vec3, dir: Vec3) -> Option<f32> {
    if dir.z.abs() < 1e-6 {
        return None;
    }
    let t = -origin.z / dir.z;
    (t >= 0.0).then_some(t)
}

/// Viewport point -> logical ground plane (the sim's XY world at z = 0).
/// The pseudo-3D counterpart of `viewport_to_world_2d`: valid for any camera.
pub fn viewport_to_ground(
    camera: &Camera,
    cam_gt: &GlobalTransform,
    viewport: Vec2,
) -> Option<Vec2> {
    let ray = camera.viewport_to_world(cam_gt, viewport).ok()?;
    let t = ray_ground_t(ray.origin, *ray.direction)?;
    Some((ray.origin + *ray.direction * t).truncate())
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
