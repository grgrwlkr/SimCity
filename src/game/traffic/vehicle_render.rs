use bevy::prelude::*;

use crate::game::traffic::Vehicle;
use crate::game::transport::LaneGraph;

/// Update vehicle positions for GPU interpolation.
/// This runs at simulation frequency (30fps) and stores position history.
#[allow(dead_code)] // Reserved for future GPU interpolation feature
pub fn update_vehicle_positions_for_interpolation(
    time: Res<Time>,
    lane_graph: Res<LaneGraph>,
    mut q_vehicles: Query<&mut Vehicle, Without<super::Parked>>,
) {
    let current_time = time.elapsed_secs_f64() as f32;

    for mut vehicle in q_vehicles.iter_mut() {
        // Calculate current world position
        let tile_pos = if vehicle.lane_id != crate::game::transport::LaneId::INVALID {
            // Use lane-based position
            lane_graph
                .lane_s_to_tile_pos(vehicle.lane_id, vehicle.lane_s)
                .unwrap_or(vehicle.tile_pos)
        } else {
            // Fallback to tile-based position
            vehicle.tile_pos
        };

        // Convert tile position to world coordinates with progress interpolation
        let world_pos = tile_to_world_pos(tile_pos, vehicle.progress);

        // Store previous position and update current
        vehicle.prev_world_pos = vehicle.curr_world_pos;
        vehicle.curr_world_pos = world_pos;
        vehicle.last_update_time = current_time;
    }
}

/// Convert tile position to world coordinates with progress interpolation.
#[allow(dead_code)] // Used by update_vehicle_positions_for_interpolation
fn tile_to_world_pos(tile_pos: crate::game::map::TilePos, _progress: f32) -> Vec2 {
    // Base tile position (simplified - no progress interpolation yet)
    Vec2::new(tile_pos.x as f32, tile_pos.y as f32)
}

/// Interpolate vehicle position between simulation frames for smooth 60fps rendering.
/// This function updates the Transform component for rendering while preserving game logic.
/// Also updates vehicle rotation to show front/back direction (GDD requirement: 2 tiles long vehicles).
pub fn interpolate_vehicle_position(
    time: Res<Time>,
    path_pool: Res<super::super::transport::PathPool>,
    mut q_vehicles: Query<(&Vehicle, &mut Transform), Without<super::Parked>>,
) {
    let current_time = time.elapsed_secs_f64() as f32;

    for (vehicle, mut transform) in q_vehicles.iter_mut() {
        // Interpolate between prev and current position
        let time_since_update = current_time - vehicle.last_update_time;
        let interpolation_factor = (time_since_update / (1.0 / 30.0)).clamp(0.0, 1.0); // Assume 30fps simulation

        // Linear interpolation for smooth movement
        let interpolated_pos = vehicle
            .prev_world_pos
            .lerp(vehicle.curr_world_pos, interpolation_factor);

        // Update only the Transform for rendering - don't touch Vehicle game logic
        transform.translation.x = interpolated_pos.x;
        transform.translation.y = interpolated_pos.y;
        // Keep Z coordinate as-is (for layering)

        // Calculate direction from current tile to next tile for rotation
        // GDD requirement: vehicles should visually show front/back
        if let Some(current_tile) = path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor) {
            if let Some(next_tile) =
                path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor + 1)
            {
                let dx = next_tile.x as f32 - current_tile.x as f32;
                let dy = next_tile.y as f32 - current_tile.y as f32;
                // Calculate angle in radians (0 = right, PI/2 = up, PI = left, -PI/2 = down)
                let angle = dy.atan2(dx);
                transform.rotation = bevy::math::Quat::from_rotation_z(angle);
            } else if vehicle.path_cursor > 0 {
                // If at the end of path, use direction from previous tile
                if let Some(prev_tile) =
                    path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor - 1)
                {
                    let dx = current_tile.x as f32 - prev_tile.x as f32;
                    let dy = current_tile.y as f32 - prev_tile.y as f32;
                    let angle = dy.atan2(dx);
                    transform.rotation = bevy::math::Quat::from_rotation_z(angle);
                }
            }
        }
    }
}
