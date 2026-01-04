use crate::game::map::{MapGrid, TilePos};

/// Maximum depth for zoning from roads (GDD 10.2.2)
pub const MAX_ZONE_DEPTH: u8 = 6;

/// Check if a tile is within the maximum zone depth from a road.
/// Uses BFS to find the nearest road within max_depth tiles.
///
/// Returns `true` if a road is found within `max_depth` tiles, `false` otherwise.
pub fn is_within_zone_depth(tile: TilePos, grid: &MapGrid, max_depth: u8) -> bool {
    if max_depth == 0 {
        return false;
    }

    // If the tile itself is a road, it's valid
    if let Some(cell) = grid.get(tile) {
        if cell.road.is_some() {
            return true;
        }
    }

    // BFS to find nearest road
    use std::collections::{HashSet, VecDeque};

    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    queue.push_back((tile, 0u8));
    visited.insert(tile);

    while let Some((current_pos, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        // Check 4-neighbors (N/E/S/W)
        let neighbors = [
            TilePos {
                x: current_pos.x,
                y: current_pos.y - 1,
            },
            TilePos {
                x: current_pos.x + 1,
                y: current_pos.y,
            },
            TilePos {
                x: current_pos.x,
                y: current_pos.y + 1,
            },
            TilePos {
                x: current_pos.x - 1,
                y: current_pos.y,
            },
        ];

        for neighbor in neighbors {
            if visited.contains(&neighbor) {
                continue;
            }

            if let Some(cell) = grid.get(neighbor) {
                // Found a road!
                if cell.road.is_some() {
                    return true;
                }

                // Only continue BFS if the neighbor is not water and not a building
                // (we can traverse through zones and empty tiles)
                if !cell.water && cell.building.is_none() {
                    visited.insert(neighbor);
                    queue.push_back((neighbor, depth + 1));
                }
            }
        }
    }

    false
}

/// Check if all tiles in a footprint are within zone depth.
pub fn is_footprint_within_zone_depth(
    anchor: TilePos,
    width: u8,
    length: u8,
    grid: &MapGrid,
    max_depth: u8,
) -> bool {
    for dx in 0..(width as i32) {
        for dy in 0..(length as i32) {
            let tile = TilePos {
                x: anchor.x + dx,
                y: anchor.y + dy,
            };
            if !is_within_zone_depth(tile, grid, max_depth) {
                return false;
            }
        }
    }
    true
}
