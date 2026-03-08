use bevy::prelude::*;

use crate::game::transport::PathPool;

use super::{
    DebugVehicleState, DebugVehicleTrafficState, Vehicle, VehicleTrafficState,
    components::DEBUG_ROUTE_SAMPLE_LEN,
};

/// Update or attach per-vehicle debug snapshots for MCP inspection.
pub(super) fn update_debug_vehicle_state(
    path_pool: Res<PathPool>,
    mut commands: Commands,
    q_vehicles: Query<(Entity, &Vehicle, Option<&VehicleTrafficState>)>,
) {
    for (e, v, state) in q_vehicles.iter() {
        let current = path_pool
            .get_tile(v.path_handle, v.path_cursor)
            .unwrap_or(v.tile_pos);
        let next = path_pool
            .get_tile(v.path_handle, v.path_cursor + 1)
            .unwrap_or(current);
        let path_len = path_pool.len(v.path_handle) as u32;
        let traffic_state = state
            .copied()
            .map(DebugVehicleTrafficState::from)
            .unwrap_or_default();

        let mut sample_x = [0; DEBUG_ROUTE_SAMPLE_LEN];
        let mut sample_y = [0; DEBUG_ROUTE_SAMPLE_LEN];
        let mut sample_len = 0u32;
        for (slot, i) in (0..DEBUG_ROUTE_SAMPLE_LEN).enumerate() {
            let idx = v.path_cursor + i;
            let Some(pos) = path_pool.get_tile(v.path_handle, idx) else {
                break;
            };
            sample_x[slot] = pos.x;
            sample_y[slot] = pos.y;
            sample_len += 1;
        }

        commands.entity(e).insert(DebugVehicleState {
            tile_x: current.x,
            tile_y: current.y,
            next_tile_x: next.x,
            next_tile_y: next.y,
            speed: v.speed,
            max_speed: v.max_speed,
            speed_factor: v.speed_factor,
            progress: v.progress,
            state: traffic_state,
            path_cursor: v.path_cursor as u32,
            path_len,
            route_sample_start: v.path_cursor as u32,
            route_sample_len: sample_len,
            route_sample_x: sample_x,
            route_sample_y: sample_y,
            is_reversing: v.is_reversing,
        });
    }
}
