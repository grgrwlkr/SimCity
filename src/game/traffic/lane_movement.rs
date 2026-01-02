use bevy::prelude::*;

use crate::game::traffic::{TrafficConfig, Vehicle, VehicleTrafficState};
use crate::game::transport::{LaneGraph, LaneOccupancy, LaneId, VehicleId};

/// Lane-based vehicle movement system (for 1M agent simulation).
pub fn move_vehicles_lane_based(
    time: Res<Time<Fixed>>,
    config: Res<TrafficConfig>,
    lane_graph: Res<LaneGraph>,
    mut lane_occupancy: ResMut<LaneOccupancy>,
    mut q_vehicles: Query<(Entity, &mut Vehicle, &mut VehicleTrafficState), Without<super::Parked>>,
) {
    let dt = time.delta_secs();

    for (_entity, mut vehicle, mut state) in q_vehicles.iter_mut() {
        // Get current lane
        let lane_id = vehicle.lane_id;
        if lane_id == LaneId::INVALID {
            continue; // Not on a lane yet
        }

        let Some(lane) = lane_graph.get_lane(lane_id) else {
            continue;
        };

        // Simple IDM model for lane-based movement
        let desired_speed = lane.speed_limit.min(vehicle.max_speed);
        let current_speed = vehicle.speed;

        // Find leader ahead
        let leader_gap = if let Some((leader_id, leader_s)) = lane_occupancy.get_leader(lane_id, vehicle.lane_s) {
            leader_s - vehicle.lane_s
        } else {
            // No leader, can go at desired speed
            f32::INFINITY
        };

        // IDM parameters (Intelligent Driver Model)
        let a = 1.0; // max acceleration
        let b = 2.0; // comfortable braking deceleration
        let delta = 4.0; // acceleration exponent
        let s0 = 2.0; // minimum gap
        let t = 1.5; // desired time headway

        // Calculate acceleration
        let accel = if leader_gap == f32::INFINITY {
            // Free flow
            a * (1.0 - (current_speed / desired_speed).powf(delta))
        } else {
            // Following leader
            let desired_gap = s0 + current_speed * t + (current_speed * (current_speed - 0.0)) / (2.0 * (a * b).sqrt());
            let gap_ratio = desired_gap / leader_gap.max(0.1);

            a * (1.0 - (current_speed / desired_speed).powf(delta) - gap_ratio.powf(2.0))
        };

        // Clamp acceleration
        let accel = accel.clamp(-vehicle.max_accel, vehicle.max_accel);

        // Update speed and position
        let new_speed = (current_speed + accel * dt).max(0.0);
        let distance = (current_speed + new_speed) * 0.5 * dt;

        vehicle.speed = new_speed;
        vehicle.lane_s += distance;

        // Update lane occupancy
        if let Some(vehicle_id) = Some(vehicle.vehicle_id).filter(|&id| id != VehicleId::INVALID) {
            lane_occupancy.update_vehicle_position(vehicle_id, lane_id, vehicle.lane_s);
        }

        // Check if reached end of lane
        if vehicle.lane_s >= lane.length_m {
            // Move to next connected lane
            if let Some(&next_lane_id) = lane.next_lanes.first() {
                vehicle.lane_s -= lane.length_m; // Reset position on new lane
                vehicle.lane_id = next_lane_id;

                // Update occupancy
                if let Some(vehicle_id) = Some(vehicle.vehicle_id).filter(|&id| id != VehicleId::INVALID) {
                    lane_occupancy.update_vehicle_position(vehicle_id, next_lane_id, vehicle.lane_s);
                }
            } else {
                // End of road, stop
                vehicle.speed = 0.0;
                *state = VehicleTrafficState::Stopped;
            }
        }

        // Update legacy tile_pos for compatibility
        if let Some(tile_pos) = lane_graph.lane_s_to_tile_pos(lane_id, vehicle.lane_s) {
            vehicle.tile_pos = tile_pos;
            vehicle.progress = vehicle.lane_s.fract(); // fractional part as progress
        }
    }
}

/// System to sync lane-based positions back to tile-based for rendering.
pub fn sync_lane_to_tile_positions(
    lane_graph: Res<LaneGraph>,
    mut q_vehicles: Query<&mut Vehicle, Without<super::Parked>>,
) {
    for mut vehicle in q_vehicles.iter_mut() {
        if vehicle.lane_id != LaneId::INVALID {
            if let Some(tile_pos) = lane_graph.lane_s_to_tile_pos(vehicle.lane_id, vehicle.lane_s) {
                vehicle.tile_pos = tile_pos;
                vehicle.progress = vehicle.lane_s.fract();
            }
        }
    }
}
