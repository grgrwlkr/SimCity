use bevy::prelude::*;

use crate::game::traffic::Vehicle;
use crate::game::transport::{LaneGraph, LaneId, LaneOccupancy, VehicleId};

/// Demo system to show lane-based simulation working.
pub fn lane_based_simulation_demo(
    mut commands: Commands,
    lane_graph: Res<LaneGraph>,
    mut lane_occupancy: ResMut<LaneOccupancy>,
    mut q_vehicles: Query<(Entity, &mut Vehicle), Without<super::Parked>>,
) {
    // Convert existing vehicles to lane-based if not already
    for (entity, mut vehicle) in q_vehicles.iter_mut() {
        if vehicle.lane_id == LaneId::INVALID {
            // Try to find a lane for this vehicle
            if let Some((lane_id, s)) = lane_graph.tile_progress_to_lane_s(vehicle.tile_pos, vehicle.progress) {
                vehicle.lane_id = lane_id;
                vehicle.lane_s = s;
                vehicle.vehicle_id = lane_occupancy.add_vehicle(lane_id, s);

                info!("Vehicle {:?} assigned to lane {:?} at s={}", entity, lane_id, s);
            }
        }
    }

    // Demo: move vehicles along lanes
    for (_entity, mut vehicle) in q_vehicles.iter_mut() {
        if vehicle.lane_id != LaneId::INVALID {
            // Simple movement: advance along lane
            vehicle.lane_s += 0.1; // 0.1 units per frame

            // Update occupancy
            if let Some(vehicle_id) = Some(vehicle.vehicle_id).filter(|&id| id != VehicleId::INVALID) {
                lane_occupancy.update_vehicle_position(vehicle_id, vehicle.lane_id, vehicle.lane_s);
            }

            // Check lane end
            if let Some(lane) = lane_graph.get_lane(vehicle.lane_id) {
                if vehicle.lane_s >= lane.length_m {
                    // Loop back to start (demo)
                    vehicle.lane_s = 0.0;
                    lane_occupancy.update_vehicle_position(vehicle.vehicle_id, vehicle.lane_id, vehicle.lane_s);
                }
            }

            // Sync back to tile position for rendering
            if let Some(tile_pos) = lane_graph.lane_s_to_tile_pos(vehicle.lane_id, vehicle.lane_s) {
                vehicle.tile_pos = tile_pos;
                vehicle.progress = vehicle.lane_s.fract();
            }
        }
    }

    // Debug info
    if lane_occupancy.lane_vehicles.len() > 0 {
        info!("Lane-based vehicles: {}", lane_occupancy.vehicle_positions.len());
        for (lane_id, vehicles) in lane_occupancy.lane_vehicles.iter() {
            info!("Lane {:?}: {} vehicles", lane_id, vehicles.len());
        }
    }
}
