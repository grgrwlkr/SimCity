use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, IntersectionKey};
use crate::game::map::TilePos;
use crate::game::transport::{LaneId, PathHandle, VehicleId};

/// Vehicle entity – stores route handle and visual offset.
/// Optimized memory layout for cache efficiency.
#[derive(Component)]
#[repr(C)]
pub struct Vehicle {
    // Hot path fields (most frequently accessed) - grouped together for cache efficiency
    /// World units per second.
    pub speed: f32,
    /// 0 = at current tile start, 1 = at next tile boundary; interpolated smoothly.
    pub progress: f32,
    /// Maximum speed for this vehicle.
    pub max_speed: f32,
    /// Maximum acceleration (world units per second squared).
    #[allow(dead_code)]
    pub max_accel: f32,

    // Position data (frequently accessed together)
    /// Current frame world position.
    pub curr_world_pos: Vec2,
    /// Previous frame world position for interpolation.
    pub prev_world_pos: Vec2,
    /// Time of last position update (seconds).
    pub last_update_time: f32,

    // Path/navigation data
    /// Handle to shared path in PathPool.
    pub path_handle: PathHandle,
    /// Current index into path (so we never modify the shared path).
    pub path_cursor: usize,

    // Lane-based positioning (for 1M agent simulation)
    /// Lane-based vehicle ID.
    pub vehicle_id: VehicleId,
    /// Lane-based positioning (for 1M agent simulation).
    pub lane_id: LaneId,
    /// Position along lane (s-coordinate in meters).
    pub lane_s: f32,

    // Legacy compatibility data (less frequently accessed)
    /// Legacy tile-based positioning (for compatibility).
    pub tile_pos: TilePos,
}

impl Default for Vehicle {
    fn default() -> Self {
        Self {
            path_handle: PathHandle::INVALID,
            path_cursor: 0,
            progress: 0.0,
            lane_id: LaneId::INVALID,
            lane_s: 0.0,
            vehicle_id: VehicleId::INVALID,
            tile_pos: TilePos { x: 0, y: 0 },
            speed: 0.0,
            max_speed: 60.0, // Default speed
            max_accel: 20.0, // Default acceleration
            prev_world_pos: Vec2::ZERO,
            curr_world_pos: Vec2::ZERO,
            last_update_time: 0.0,
        }
    }
}

/// State of vehicle relative to traffic lights / intersection admission.
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub enum VehicleTrafficState {
    /// Moving freely (no traffic light ahead)
    FreeFlow,
    /// Approaching a traffic light / stop line.
    Approaching {
        intersection: IntersectionKey,
        /// The first intersection tile on the route for this approach (used for stop-line distance).
        stop_tile: TilePos,
        distance_to_stop: f32,
    },
    /// Stopped in queue
    Stopped {
        intersection: IntersectionKey,
        stop_tile: TilePos,
        queue_position: u8,
    },
    /// Waiting for green light
    WaitingForGreen {
        intersection: IntersectionKey,
        stop_tile: TilePos,
    },
    /// Accelerating after green
    Accelerating,
    /// Crossing (or admitted to) a specific logical intersection cluster.
    ///
    /// This state is used both when a vehicle is already inside the intersection tiles (`dir=None`)
    /// and when it has been released from a stop line and is about to enter the cluster.
    CrossingIntersection { intersection: IntersectionKey },
}

/// Marker component for parked vehicles.
/// Parked vehicles are visually offset to the side of the road and do not block traffic.
#[derive(Component, Debug, Clone, Copy)]
pub struct Parked {
    /// Offset direction for visual placement (perpendicular to road, towards edge).
    /// Positive = right side of road (in travel direction).
    pub offset: f32,
}

/// A persistent, citizen-owned car entity (CarTour Variant B).
///
/// Owned cars are parked (`Parked`) when not actively driving and re-used for future car legs.
#[derive(Component, Debug, Clone, Copy)]
pub struct CarOwner {
    pub citizen: crate::game::ids::CitizenId,
}

/// Marker for vehicles currently performing a right turn on red.
/// While present, we clamp their speed to a low "turn speed" until they exit the intersection.
#[derive(Component, Debug, Clone, Copy)]
pub struct RightTurnOnRed {
    pub intersection_id: IntersectionId,
}
