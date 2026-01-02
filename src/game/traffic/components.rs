use bevy::prelude::*;

use crate::game::intersections::IntersectionKey;
use crate::game::map::TilePos;

/// Vehicle entity – stores route and visual offset.
#[derive(Component)]
pub struct Vehicle {
    /// A* route as list of tile positions (full path).
    pub route: Vec<TilePos>,
    /// Current index into `route` (so we never `remove(0)` / shift the Vec).
    pub route_idx: usize,
    /// 0 = at current tile start, 1 = at next tile boundary; interpolated smoothly.
    pub progress: f32,
    /// World units per second.
    pub speed: f32,
    /// Maximum speed for this vehicle.
    pub max_speed: f32,
    /// Maximum acceleration (world units per second squared).
    #[allow(dead_code)]
    pub max_accel: f32,
}

impl Default for Vehicle {
    fn default() -> Self {
        Self {
            route: Vec::new(),
            route_idx: 0,
            progress: 0.0,
            speed: 0.0,
            max_speed: 60.0, // Default speed
            max_accel: 20.0, // Default acceleration
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
