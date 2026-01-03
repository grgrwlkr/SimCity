use super::intersection::{
    IntersectionReservation, ManeuverKind, ReservationState, StreamKey, ZONE_ALL, ZONE_NW,
};
use super::*;
use crate::game::citizens::Citizen;
use crate::game::ids::CitizenId;
use crate::game::ids::CitizenIdComp;
use crate::game::intersections::IntersectionPriorityMarker;
use crate::game::intersections::LightPhase;
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

/// Helper function to create a Vehicle with proper PathPool integration
pub fn create_vehicle_with_route(
    path_pool: &mut crate::game::transport::PathPool,
    route: Vec<crate::game::map::TilePos>,
    route_idx: usize,
    progress: f32,
    speed: f32,
    max_speed: f32,
    max_accel: f32,
) -> crate::game::traffic::components::Vehicle {
    use crate::game::map::MapConfig;
    use crate::game::transport::{LaneId, VehicleId};
    use bevy::prelude::*;

    let path_handle = if route.is_empty() {
        crate::game::transport::PathHandle::INVALID
    } else {
        path_pool.intern(route.clone())
    };

    let start_pos = route.get(route_idx).copied().unwrap_or_else(|| {
        route.first().copied().unwrap_or(crate::game::map::TilePos { x: 0, y: 0 })
    });
    
    // Calculate world position (simplified - assumes default tile_size)
    let world_pos = Vec2::new(
        start_pos.x as f32 * 16.0,
        start_pos.y as f32 * 16.0,
    );

    crate::game::traffic::components::Vehicle {
        path_handle,
        path_cursor: route_idx,
        progress,
        speed,
        max_speed,
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

mod part_01;
mod part_02;
mod part_03;
mod part_04;
mod part_05;
mod part_06;
mod part_07;
mod part_08;
mod part_09;
