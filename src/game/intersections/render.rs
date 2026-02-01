use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::RoadDir;

use super::index::IntersectionIndex;
use super::lights::*;

/// Render traffic light visuals
/// GDD requirement: light should be displayed at each entrance to an intersection (on the right side of the road),
/// showing the correct phase for each direction.
pub fn render_traffic_lights(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    traffic_cfg: Res<crate::game::traffic::TrafficConfig>,
    q_lights: Query<&TrafficLight>,
    q_visuals: Query<Entity, With<TrafficLightVisual>>,
) {
    // Clear old visuals.
    for e in &q_visuals {
        commands.entity(e).despawn();
    }

    for light in &q_lights {
        // Find all approach tiles (road tiles adjacent to intersection that lead into it)
        // Build intersection tiles set from tile_to_intersection map
        let intersection_tiles: Vec<TilePos> = intersections
            .tile_to_intersection
            .iter()
            .filter_map(|(pos, &id)| {
                if id == light.intersection_id {
                    Some(*pos)
                } else {
                    None
                }
            })
            .collect();
        let approach_tiles = find_approach_tiles(&grid, &intersection_tiles, &intersections);

        // Create a light visual for each approach
        for (approach_tile, entry_dir) in approach_tiles {
            // Calculate position on the right side of the road (GDD requirement)
            let light_pos = calculate_light_position(&cfg, approach_tile, entry_dir, &traffic_cfg);

            // Determine phase color for this direction
            let color = get_light_color_for_direction(light, entry_dir);

            commands.spawn((
                Sprite::from_color(color, Vec2::splat(cfg.tile_size * 0.25)),
                Transform::from_translation(Vec3::new(light_pos.x, light_pos.y, 12.0)),
                TrafficLightVisual,
            ));
        }
    }
}

/// Find all approach tiles (road tiles that lead into the intersection)
fn find_approach_tiles(
    grid: &MapGrid,
    intersection_tiles: &[TilePos],
    intersections: &IntersectionIndex,
) -> Vec<(TilePos, RoadDir)> {
    let mut approaches = Vec::new();
    let intersection_set: std::collections::HashSet<_> = intersection_tiles.iter().collect();

    // Check all 4 neighbors of each intersection tile
    for &intersection_tile in intersection_tiles {
        for (dx, dy, dir) in [
            (0, 1, RoadDir::North),
            (0, -1, RoadDir::South),
            (1, 0, RoadDir::East),
            (-1, 0, RoadDir::West),
        ] {
            let neighbor = TilePos {
                x: intersection_tile.x + dx,
                y: intersection_tile.y + dy,
            };

            // Check if this neighbor is a road tile (not intersection) that points toward the intersection
            if let Some(cell) = grid.get(neighbor)
                && cell.road.is_some()
                && cell.road.dir != RoadDir::None
                && !intersection_set.contains(&neighbor)
                && intersections.intersection_id_at(neighbor).is_none()
            {
                // Check if the road direction points toward the intersection
                let road_dir = cell.road.dir;
                let points_toward = match (road_dir, dir) {
                    (RoadDir::North, RoadDir::South) => true, // Road goes north, intersection is south
                    (RoadDir::South, RoadDir::North) => true, // Road goes south, intersection is north
                    (RoadDir::East, RoadDir::West) => true, // Road goes east, intersection is west
                    (RoadDir::West, RoadDir::East) => true, // Road goes west, intersection is east
                    _ => false,
                };

                if points_toward {
                    approaches.push((neighbor, road_dir));
                }
            }
        }
    }

    // Remove duplicates (same tile might be found from multiple intersection tiles)
    // Use HashSet to deduplicate since TilePos doesn't implement Ord
    let mut seen = std::collections::HashSet::new();
    let mut unique_approaches = Vec::new();
    for (pos, dir) in approaches {
        if seen.insert(pos) {
            unique_approaches.push((pos, dir));
        }
    }
    unique_approaches
}

/// Calculate light position on the right side of the road
fn calculate_light_position(
    cfg: &MapConfig,
    approach_tile: TilePos,
    entry_dir: RoadDir,
    traffic_cfg: &crate::game::traffic::TrafficConfig,
) -> Vec2 {
    let origin = map_origin(cfg);
    let tile_center = origin
        + Vec2::new(
            approach_tile.x as f32 * cfg.tile_size,
            approach_tile.y as f32 * cfg.tile_size,
        );

    // Offset to the right side of the road (relative to direction of travel)
    // For right-hand traffic: right side is to the right when facing the direction of travel
    let offset = if traffic_cfg.drive_on_right {
        match entry_dir {
            RoadDir::North => Vec2::new(cfg.tile_size * 0.35, 0.0), // Right side when going north
            RoadDir::South => Vec2::new(-cfg.tile_size * 0.35, 0.0), // Right side when going south
            RoadDir::East => Vec2::new(0.0, -cfg.tile_size * 0.35), // Right side when going east
            RoadDir::West => Vec2::new(0.0, cfg.tile_size * 0.35),  // Right side when going west
            RoadDir::None => Vec2::ZERO,
        }
    } else {
        // Left-hand traffic: mirror the offsets
        match entry_dir {
            RoadDir::North => Vec2::new(-cfg.tile_size * 0.35, 0.0),
            RoadDir::South => Vec2::new(cfg.tile_size * 0.35, 0.0),
            RoadDir::East => Vec2::new(0.0, cfg.tile_size * 0.35),
            RoadDir::West => Vec2::new(0.0, -cfg.tile_size * 0.35),
            RoadDir::None => Vec2::ZERO,
        }
    };

    tile_center + offset
}

/// Get light color for a specific direction based on current phase
fn get_light_color_for_direction(light: &TrafficLight, entry_dir: RoadDir) -> Color {
    // Determine if this direction can proceed based on phase
    let is_green = light.is_green(entry_dir);
    let is_yellow = light.is_yellow(entry_dir);

    if is_green {
        Color::srgba(0.2, 0.9, 0.2, 0.8) // Green
    } else if is_yellow {
        Color::srgba(0.9, 0.9, 0.2, 0.8) // Yellow
    } else {
        Color::srgba(0.9, 0.2, 0.2, 0.8) // Red
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}
