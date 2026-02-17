use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::RoadDir;

use super::index::{IntersectionId, IntersectionIndex};
use super::lights::*;

/// Extra metadata for traffic light visuals so we can update colors without respawning entities.
#[derive(Component, Debug, Copy, Clone)]
pub struct TrafficLightVisualMeta {
    intersection_id: IntersectionId,
    entry_dir: RoadDir,
}

#[derive(Default)]
pub(crate) struct TrafficLightVisualLayoutState {
    intersection_version: u64,
    map_width: i32,
    map_height: i32,
    tile_size_bits: u32,
    drive_on_right: bool,
    light_count: usize,
    light_hash: u64,
}

fn traffic_light_set_signature(q_lights: &Query<&TrafficLight>) -> (usize, u64) {
    let mut count = 0usize;
    let mut hash = 0u64;
    for light in q_lights.iter() {
        count += 1;
        let id = light.intersection_id.0 as u64;
        hash = hash.wrapping_add(id.wrapping_mul(0x9E37_79B1_85EB_CA87));
        hash ^= id.rotate_left((id as u32) & 31);
    }
    (count, hash)
}

/// Synchronize traffic light visual entities (topology/layout changes only).
///
/// This system is intentionally separated from `render_traffic_lights` so we avoid
/// despawn/spawn churn every frame.
#[allow(clippy::too_many_arguments)]
pub fn sync_traffic_light_visuals(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    traffic_cfg: Res<crate::game::traffic::TrafficConfig>,
    q_lights: Query<&TrafficLight>,
    q_visuals: Query<Entity, With<TrafficLightVisual>>,
    mut layout_state: Local<TrafficLightVisualLayoutState>,
) {
    let (light_count, light_hash) = traffic_light_set_signature(&q_lights);
    let needs_rebuild = q_visuals.is_empty()
        || layout_state.intersection_version != intersections.version
        || layout_state.map_width != cfg.width
        || layout_state.map_height != cfg.height
        || layout_state.tile_size_bits != cfg.tile_size.to_bits()
        || layout_state.drive_on_right != traffic_cfg.drive_on_right
        || layout_state.light_count != light_count
        || layout_state.light_hash != light_hash;
    if !needs_rebuild {
        return;
    }

    layout_state.intersection_version = intersections.version;
    layout_state.map_width = cfg.width;
    layout_state.map_height = cfg.height;
    layout_state.tile_size_bits = cfg.tile_size.to_bits();
    layout_state.drive_on_right = traffic_cfg.drive_on_right;
    layout_state.light_count = light_count;
    layout_state.light_hash = light_hash;

    for e in &q_visuals {
        commands.entity(e).despawn();
    }

    if light_count == 0 {
        return;
    }

    let mut tiles_by_intersection: HashMap<IntersectionId, Vec<TilePos>> = HashMap::new();
    for (pos, &id) in intersections.tile_to_intersection.iter() {
        tiles_by_intersection.entry(id).or_default().push(*pos);
    }

    for light in &q_lights {
        let Some(intersection_tiles) = tiles_by_intersection.get(&light.intersection_id) else {
            continue;
        };
        let approach_tiles = find_approach_tiles(&grid, intersection_tiles, &intersections);

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
                TrafficLightVisualMeta {
                    intersection_id: light.intersection_id,
                    entry_dir,
                },
            ));
        }
    }
}

/// Update traffic light visual colors from current light phases.
///
/// Runs every frame but only updates sprite colors (no entity churn).
pub fn render_traffic_lights(
    q_lights: Query<&TrafficLight>,
    mut q_visuals: Query<(&TrafficLightVisualMeta, &mut Sprite), With<TrafficLightVisual>>,
    mut lights_by_id: Local<HashMap<IntersectionId, TrafficLight>>,
) {
    lights_by_id.clear();
    for light in q_lights.iter() {
        lights_by_id.insert(light.intersection_id, light.clone());
    }

    for (meta, mut sprite) in q_visuals.iter_mut() {
        if let Some(light) = lights_by_id.get(&meta.intersection_id) {
            sprite.color = get_light_color_for_direction(light, meta.entry_dir);
        } else {
            // Should be rare (stale visual until next sync), keep it visibly inactive.
            sprite.color = Color::srgba(0.4, 0.4, 0.4, 0.35);
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
    let intersection_set: HashSet<_> = intersection_tiles.iter().collect();

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
    let mut seen = HashSet::new();
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
