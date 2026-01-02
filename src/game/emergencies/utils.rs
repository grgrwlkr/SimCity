use bevy::prelude::*;
use crate::game::map::{MapConfig, TilePos};
use crate::game::roads::RoadDir;

/// Convert tile position to world coordinates.
pub fn tile_to_world(cfg: &MapConfig, pos: TilePos) -> Vec2 {
    let origin = map_origin(cfg);
    origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
}

/// Get the world origin for tile coordinates.
pub fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

/// Calculate desired direction from one tile to another.
pub fn desired_dir(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() > dy.abs() {
        if dx > 0 {
            RoadDir::East
        } else {
            RoadDir::West
        }
    } else if dy > 0 {
        RoadDir::North
    } else {
        RoadDir::South
    }
}

/// Find a reachable road endpoint near the given position.
pub fn pick_reachable_road_endpoint(
    grid: &crate::game::map::MapGrid,
    from: TilePos,
) -> Option<TilePos> {
    // Check adjacent tiles for road endpoints
    let candidates = [
        from,
        TilePos { x: from.x - 1, y: from.y },
        TilePos { x: from.x + 1, y: from.y },
        TilePos { x: from.x, y: from.y - 1 },
        TilePos { x: from.x, y: from.y + 1 },
    ];

    for &pos in &candidates {
        if let Some(cell) = grid.get(pos) {
            if cell.road.is_some() {
                return Some(pos);
            }
        }
    }
    None
}

/// Find any adjacent road tile.
pub fn adjacent_road_any(grid: &crate::game::map::MapGrid, pos: TilePos) -> Option<TilePos> {
    let candidates = [
        TilePos { x: pos.x - 1, y: pos.y },
        TilePos { x: pos.x + 1, y: pos.y },
        TilePos { x: pos.x, y: pos.y - 1 },
        TilePos { x: pos.x, y: pos.y + 1 },
    ];

    for candidate in candidates {
        if let Some(cell) = grid.get(candidate) {
            if cell.road.is_some() {
                return Some(candidate);
            }
        }
    }
    None
}
