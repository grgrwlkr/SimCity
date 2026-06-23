use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, IntersectionKey};
use crate::game::map::TilePos;
use crate::game::roads::RoadDir;
use crate::game::transport::{LaneId, LaneletId, PathHandle, VehicleId};

/// Per-vehicle lanelet plan (Phase-2 sidecar to the `Vec<TilePos>` route). Each entry pairs the
/// route cursor offset where a lanelet's internal path begins with that lanelet's identity, for the
/// Phase-3 intersection arbiter to consume. Empty when the lanelet flag is off or the route fell
/// back to road-level pathfinding. Cleared on any mid-trip reroute (the offsets are absolute).
#[derive(Component, Default)]
pub struct VehicleLaneletPlan {
    pub entries: Vec<(usize, IntersectionId, LaneletId)>,
}

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
    /// Driver speed profile multiplier applied to road speed limits.
    /// `1.0` = typical flow, `<1.0` = cautious, `>1.0` = aggressive.
    pub speed_factor: f32,
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

    // Reverse movement (GDD: vehicles can reverse slowly when stuck)
    /// Flag indicating if vehicle is currently reversing (GDD: max 10 km/h, only when stuck)
    pub is_reversing: bool,
    /// Distance reversed in tiles (limited to 2-3 tiles max)
    pub reverse_distance: f32,
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
            speed_factor: 1.0,
            max_accel: 20.0, // Default acceleration
            prev_world_pos: Vec2::ZERO,
            curr_world_pos: Vec2::ZERO,
            last_update_time: 0.0,
            is_reversing: false,
            reverse_distance: 0.0,
        }
    }
}

/// State of vehicle relative to traffic lights / intersection admission.
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub enum VehicleTrafficState {
    /// Moving freely (no traffic light ahead)
    FreeFlow,
    /// Approaching a traffic light / stop line.
    #[allow(dead_code)] // Reserved for future use
    Approaching {
        intersection: IntersectionKey,
        /// The first intersection tile on the route for this approach (used for stop-line distance).
        stop_tile: TilePos,
        distance_to_stop: f32,
    },
    /// Stopped in queue
    #[allow(dead_code)] // Reserved for future use
    Stopped {
        intersection: IntersectionKey,
        stop_tile: TilePos,
        queue_position: u8,
    },
    /// Waiting for green light
    #[allow(dead_code)] // Reserved for future use
    WaitingForGreen {
        intersection: IntersectionKey,
        stop_tile: TilePos,
    },
    /// Accelerating after green
    #[allow(dead_code)] // Reserved for future use
    Accelerating,
    /// Crossing (or admitted to) a specific logical intersection cluster.
    ///
    /// This state is used both when a vehicle is already inside the intersection tiles (`dir=None`)
    /// and when it has been released from a stop line and is about to enter the cluster.
    #[allow(dead_code)] // Reserved for future use
    CrossingIntersection { intersection: IntersectionKey },
}

/// Lightweight reflected traffic state for MCP inspection.
#[derive(Reflect, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DebugVehicleTrafficState {
    /// Vehicle is free-flowing.
    #[default]
    FreeFlow,
    /// Vehicle is approaching a stop line.
    Approaching,
    /// Vehicle is stopped in a queue.
    Stopped,
    /// Vehicle is waiting for green.
    WaitingForGreen,
    /// Vehicle is accelerating after release.
    Accelerating,
    /// Vehicle is crossing or admitted to an intersection.
    CrossingIntersection,
}

impl From<VehicleTrafficState> for DebugVehicleTrafficState {
    fn from(state: VehicleTrafficState) -> Self {
        match state {
            VehicleTrafficState::FreeFlow => Self::FreeFlow,
            VehicleTrafficState::Approaching { .. } => Self::Approaching,
            VehicleTrafficState::Stopped { .. } => Self::Stopped,
            VehicleTrafficState::WaitingForGreen { .. } => Self::WaitingForGreen,
            VehicleTrafficState::Accelerating => Self::Accelerating,
            VehicleTrafficState::CrossingIntersection { .. } => Self::CrossingIntersection,
        }
    }
}

/// Number of upcoming route tiles sampled in `DebugVehicleState`.
pub(crate) const DEBUG_ROUTE_SAMPLE_LEN: usize = 8;

/// Reflected per-vehicle snapshot for MCP inspection tools.
#[derive(Component, Reflect, Debug, Clone, Copy, Default)]
#[reflect(Component)]
pub struct DebugVehicleState {
    /// Current tile x.
    pub tile_x: i32,
    /// Current tile y.
    pub tile_y: i32,
    /// Next tile x (or current if none).
    pub next_tile_x: i32,
    /// Next tile y (or current if none).
    pub next_tile_y: i32,
    /// Vehicle speed in world units per second.
    pub speed: f32,
    /// Vehicle maximum speed cap in world units per second.
    pub max_speed: f32,
    /// Driver speed profile multiplier.
    pub speed_factor: f32,
    /// Vehicle progress along the current tile (0..1).
    pub progress: f32,
    /// Current traffic state.
    pub state: DebugVehicleTrafficState,
    /// Current path cursor (index in route).
    pub path_cursor: u32,
    /// Current path length in tiles.
    pub path_len: u32,
    /// Path index that the route sample starts from.
    pub route_sample_start: u32,
    /// Number of valid entries in the route sample arrays.
    pub route_sample_len: u32,
    /// X coordinates of upcoming route tiles starting at `route_sample_start`.
    pub route_sample_x: [i32; DEBUG_ROUTE_SAMPLE_LEN],
    /// Y coordinates of upcoming route tiles starting at `route_sample_start`.
    pub route_sample_y: [i32; DEBUG_ROUTE_SAMPLE_LEN],
    /// Whether the vehicle is currently reversing.
    pub is_reversing: bool,
}

/// Reflected road direction for MCP inspection.
#[derive(Reflect, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DebugRoadDir {
    /// No direction (non-lane tile).
    #[default]
    None,
    /// West-bound direction.
    West,
    /// East-bound direction.
    East,
    /// North-bound direction.
    North,
    /// South-bound direction.
    South,
}

impl From<RoadDir> for DebugRoadDir {
    fn from(dir: RoadDir) -> Self {
        match dir {
            RoadDir::None => Self::None,
            RoadDir::West => Self::West,
            RoadDir::East => Self::East,
            RoadDir::North => Self::North,
            RoadDir::South => Self::South,
        }
    }
}

/// Reflected maneuver classification for intersection connectors.
#[derive(Reflect, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DebugManeuverKind {
    /// No maneuver (inactive).
    #[default]
    None,
    /// Straight through intersection.
    Straight,
    /// Right turn.
    RightTurn,
    /// Left turn.
    LeftTurn,
    /// Other (U-turn or custom logic).
    Other,
}

/// Reflected snapshot of intersection connector rewriting for MCP inspection.
#[derive(Component, Reflect, Debug, Clone, Copy, Default)]
#[reflect(Component)]
pub struct DebugIntersectionConnectorState {
    /// Whether a connector analysis was performed this frame.
    pub active: bool,
    /// Whether a connector path could be built.
    pub has_connector: bool,
    /// Whether the route segment was rewritten.
    pub was_rewritten: bool,
    /// Maneuver classification for the connector.
    pub maneuver: DebugManeuverKind,
    /// Entry travel direction at the intersection.
    pub entry_dir: DebugRoadDir,
    /// Exit travel direction from the intersection.
    pub exit_dir: DebugRoadDir,
    /// Remaining route length (from current cursor).
    pub route_len: u32,
    /// Start index of the intersection segment (relative to remaining route).
    pub segment_start: u32,
    /// End index (exclusive) of the intersection segment (relative to remaining route).
    pub segment_end: u32,
    /// Length of the existing intersection segment.
    pub existing_len: u32,
    /// Length of the computed connector path.
    pub connector_len: u32,
    /// Approach tile x (before entry).
    pub approach_x: i32,
    /// Approach tile y (before entry).
    pub approach_y: i32,
    /// Entry tile x.
    pub entry_x: i32,
    /// Entry tile y.
    pub entry_y: i32,
    /// Exit tile x (last intersection tile).
    pub exit_x: i32,
    /// Exit tile y (last intersection tile).
    pub exit_y: i32,
    /// Exit lane tile x (first non-intersection tile).
    pub exit_lane_x: i32,
    /// Exit lane tile y (first non-intersection tile).
    pub exit_lane_y: i32,
    /// Selected anchor tile x.
    pub anchor_x: i32,
    /// Selected anchor tile y.
    pub anchor_y: i32,
    /// Intersection id for the connector (0 when inactive).
    pub intersection_id: u32,
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
