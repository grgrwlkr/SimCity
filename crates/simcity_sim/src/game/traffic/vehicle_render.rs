use bevy::prelude::*;

use crate::game::traffic::Vehicle;

/// Interpolate vehicle position between simulation frames for smooth 60fps rendering.
/// This function updates the Transform component for rendering while preserving game logic.
/// Also updates vehicle rotation to show front/back direction (GDD requirement: 2 tiles long vehicles).
pub fn interpolate_vehicle_position(
    fixed_time: Res<Time<Fixed>>,
    path_pool: Res<super::super::transport::PathPool>,
    mut q_vehicles: Query<(&Vehicle, &mut Transform), Without<super::Parked>>,
) {
    // Canonical Bevy FixedUpdate->Update interpolation. move_vehicles (FixedUpdate, 10 Hz)
    // writes prev/curr world positions once per tick; here on Update we blend them by how far
    // the render clock has advanced into the current fixed step. `overstep_fraction()` is in
    // [0,1), single-clock — no hardcoded sim period, no Fixed-vs-render clock mixing.
    let interpolation_factor = fixed_time.overstep_fraction();

    for (vehicle, mut transform) in q_vehicles.iter_mut() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::transport::PathPool;
    use bevy::ecs::system::RunSystemOnce;
    use std::time::Duration;

    /// With a known fixed-step overstep the rendered Transform must equal
    /// lerp(prev, curr, overstep_fraction) — proves the interp uses the live overstep and
    /// not the old hardcoded 1/30 s period (path_handle INVALID skips the rotation branch).
    #[test]
    fn interpolates_position_at_overstep_fraction() {
        let mut world = World::new();

        // 100 ms fixed step (10 Hz) with 25 ms accumulated -> overstep_fraction == 0.25.
        let mut fixed = Time::<Fixed>::from_seconds(0.1);
        fixed.accumulate_overstep(Duration::from_secs_f64(0.025));
        assert!((fixed.overstep_fraction() - 0.25).abs() < 1e-6);
        world.insert_resource(fixed);
        world.insert_resource(PathPool::default());

        let id = world
            .spawn((
                Vehicle {
                    prev_world_pos: Vec2::new(0.0, 0.0),
                    curr_world_pos: Vec2::new(40.0, 80.0),
                    ..Default::default()
                },
                Transform::default(),
            ))
            .id();

        world
            .run_system_once(interpolate_vehicle_position)
            .expect("system runs headless");

        let tf = world.entity(id).get::<Transform>().unwrap();
        assert!(
            (tf.translation.x - 10.0).abs() < 1e-4,
            "x={}",
            tf.translation.x
        );
        assert!(
            (tf.translation.y - 20.0).abs() < 1e-4,
            "y={}",
            tf.translation.y
        );
    }
}
