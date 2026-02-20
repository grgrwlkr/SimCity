use super::intersection::{
    IntersectionReservation, ManeuverKind, ReservationState, StreamKey, ZONE_ALL, ZONE_NW,
};
use super::*;
use crate::game::citizens::Citizen;
use crate::game::ids::CitizenId;
use crate::game::ids::CitizenIdComp;
use crate::game::intersections::{
    IntersectionId, IntersectionKey, IntersectionPriorityMarker, LightPhase,
};
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use crate::game::trips::TripPurpose;
use bevy::app::App;
use bevy::ecs::message::MessageReader;
use std::time::Duration;

#[derive(Resource, Default)]
struct FinishCount(u32);

fn count_trip_finished(mut reader: MessageReader<TripFinished>, mut cnt: ResMut<FinishCount>) {
    for _ in reader.read() {
        cnt.0 += 1;
    }
}

/// Helper function to create a Vehicle with proper PathPool integration.
/// `speed_factor` defaults to 1.0; use < KEEP_RIGHT_SPEED_THRESHOLD for slow, > for fast lane preference.
#[allow(clippy::too_many_arguments)] // Test helper with many parameters for vehicle setup
pub fn create_vehicle_with_route(
    path_pool: &mut crate::game::transport::PathPool,
    route: Vec<crate::game::map::TilePos>,
    route_idx: usize,
    progress: f32,
    speed: f32,
    max_speed: f32,
    max_accel: f32,
    speed_factor: f32,
) -> crate::game::traffic::components::Vehicle {
    use crate::game::transport::{LaneId, VehicleId};
    use bevy::prelude::*;

    let path_handle = if route.is_empty() {
        crate::game::transport::PathHandle::INVALID
    } else {
        path_pool.intern(route.clone())
    };

    let start_pos = route.get(route_idx).copied().unwrap_or_else(|| {
        route
            .first()
            .copied()
            .unwrap_or(crate::game::map::TilePos { x: 0, y: 0 })
    });

    // Calculate world position (simplified - assumes default tile_size)
    let world_pos = Vec2::new(start_pos.x as f32 * 16.0, start_pos.y as f32 * 16.0);

    crate::game::traffic::components::Vehicle {
        path_handle,
        path_cursor: route_idx,
        progress,
        speed,
        is_reversing: false,
        reverse_distance: 0.0,
        max_speed,
        speed_factor,
        max_accel,
        lane_id: LaneId::INVALID,
        lane_s: 0.0,
        vehicle_id: VehicleId::INVALID,
        tile_pos: start_pos,
        prev_world_pos: world_pos,
        curr_world_pos: world_pos,
        last_update_time: 0.0,
    }
}

// Basic vehicle behavior and trip completion
mod basic_behavior;

// Intersection reservation system
mod intersection_reservations;

// Traffic light behavior
mod traffic_lights;

// Route rewriting (overtake, stuck vehicles, U-turns)
mod route_rewriting;

// Right turn on red behavior
mod right_turn_on_red;

// Pedestrian-vehicle interactions at intersections
mod pedestrians;

// Intersection conflict zones
mod conflict_zones;

// Vehicle spawning and trip management
mod vehicle_spawning;

// Vehicle parking behavior
mod vehicle_parking;
