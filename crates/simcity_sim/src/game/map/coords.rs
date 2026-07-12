use bevy::prelude::*;

// Canonical mapping lives in simcity_core; re-exported here so every map-module
// consumer (and, via mod.rs, the rest of the sim crate) shares one formula.
pub use simcity_core::game::map::coords::{
    map_origin, tile_f_to_world, tile_to_world, world_to_tile,
};

use super::{MapConfig, TilePos};

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
