use bevy::prelude::*;

use crate::game::traffic::Vehicle;
use crate::game::transport::LaneGraph;

/// Update vehicle positions for GPU interpolation.
/// This runs at simulation frequency (30fps) and stores position history.
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
            lane_graph.lane_s_to_tile_pos(vehicle.lane_id, vehicle.lane_s)
                .unwrap_or(vehicle.tile_pos)
        } else {
            // Fallback to tile-based position
            vehicle.tile_pos
        };

        // Convert tile position to world coordinates
        let world_pos = tile_to_world_pos(tile_pos, vehicle.progress);

        // Store previous position and update current
        vehicle.prev_world_pos = vehicle.curr_world_pos;
        vehicle.curr_world_pos = world_pos;
        vehicle.last_update_time = current_time;
    }
}

/// Convert tile position to world coordinates with progress interpolation.
fn tile_to_world_pos(tile_pos: crate::game::map::TilePos, progress: f32) -> Vec2 {
    // Base tile position (simplified - no progress interpolation yet)
    Vec2::new(
        tile_pos.x as f32,
        tile_pos.y as f32,
    )
}

/// Interpolate vehicle position between simulation frames for smooth 60fps rendering.
pub fn interpolate_vehicle_position(
    time: Res<Time>,
    mut q_vehicles: Query<&mut Vehicle, Without<super::Parked>>,
) {
    let current_time = time.elapsed_secs_f64() as f32;

    for mut vehicle in q_vehicles.iter_mut() {
        // Interpolate between prev and current position
        let time_since_update = current_time - vehicle.last_update_time;
        let interpolation_factor = (time_since_update / (1.0 / 30.0)).clamp(0.0, 1.0); // Assume 30fps simulation

        // Linear interpolation for smooth movement
        let interpolated_pos = vehicle.prev_world_pos.lerp(vehicle.curr_world_pos, interpolation_factor);

        // Store interpolated position (can be used by rendering systems)
        // For now, we update tile_pos as a simple approximation
        vehicle.tile_pos.x = interpolated_pos.x as i32;
        vehicle.tile_pos.y = interpolated_pos.y as i32;
        // Simplified progress calculation
        vehicle.progress = interpolated_pos.fract().x;
    }
}