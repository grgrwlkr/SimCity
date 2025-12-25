//! Road types / lane system (MVP).
//!
//! This module is intentionally "data-only": enums + constants. Gameplay logic lives in systems.

use bevy::prelude::*;

/// Road type by lane count.
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum RoadKind {
    /// No road on this tile.
    #[default]
    None,
    /// 2 lanes — local street.
    TwoLane,
    /// 4 lanes — city road.
    FourLane,
    /// 6 lanes — highway.
    SixLane,
}

impl RoadKind {
    /// Number of lanes for this road kind.
    pub fn lanes(self) -> u8 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 2,
            RoadKind::FourLane => 4,
            RoadKind::SixLane => 6,
        }
    }

    /// Speed limit in **km/h** (also used by routing weights).
    pub fn speed_limit(self) -> f32 {
        match self {
            RoadKind::None => 0.0,
            RoadKind::TwoLane => 40.0,
            RoadKind::FourLane => 60.0,
            RoadKind::SixLane => 80.0,
        }
    }

    /// Per-tile capacity (vehicles before congestion starts).
    pub fn capacity(self) -> u16 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 4,
            RoadKind::FourLane => 8,
            RoadKind::SixLane => 14,
        }
    }

    /// Capacity per **lane tile** when lanes are represented as separate tiles.
    pub fn capacity_per_lane_tile(self) -> u16 {
        let lanes = self.lanes().max(1) as f32;
        ((self.capacity() as f32) / lanes).round().max(1.0) as u16
    }

    /// Pathfinding desirability multiplier (higher = preferred).
    pub fn desirability(self) -> f32 {
        match self {
            RoadKind::None => 0.0,
            RoadKind::TwoLane => 1.0,
            RoadKind::FourLane => 1.3,
            RoadKind::SixLane => 1.6,
        }
    }

    /// Build cost per tile.
    pub fn build_cost(self) -> i64 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 10,
            RoadKind::FourLane => 30,
            RoadKind::SixLane => 60,
        }
    }

    /// Build cost per **lane tile** (when a road occupies multiple tiles by lanes).
    pub fn build_cost_per_lane_tile(self) -> i64 {
        let lanes = self.lanes().max(1) as i64;
        (self.build_cost() / lanes).max(1)
    }

    /// Daily maintenance cost per tile (used later by economy).
    #[allow(dead_code)]
    pub fn maintenance_cost(self) -> i64 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 1,
            RoadKind::FourLane => 2,
            RoadKind::SixLane => 4,
        }
    }

    /// Daily maintenance cost per **lane tile**.
    #[allow(dead_code)]
    pub fn maintenance_cost_per_lane_tile(self) -> i64 {
        let lanes = self.lanes().max(1) as i64;
        (self.maintenance_cost() / lanes).max(1)
    }

    /// Suggested road color (base tile view).
    pub fn color(self) -> Color {
        match self {
            RoadKind::None => Color::srgb(0.0, 0.0, 0.0),
            RoadKind::TwoLane => Color::srgb(0.18, 0.18, 0.20), // ~#2E2E30
            RoadKind::FourLane => Color::srgb(0.25, 0.25, 0.27), // ~#404045
            RoadKind::SixLane => Color::srgb(0.33, 0.33, 0.38), // ~#555560
        }
    }

    /// True if the tile has any road built.
    #[allow(dead_code)]
    pub fn is_some(self) -> bool {
        self != RoadKind::None
    }

    /// Returns whether `to` is a strict upgrade over `from`.
    pub fn is_upgrade(from: RoadKind, to: RoadKind) -> bool {
        to.lanes() > from.lanes()
    }
}

/// Cardinal travel direction for a lane tile.
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum RoadDir {
    #[default]
    None,
    West,
    East,
    North,
    South,
}

/// Road flow direction (two-way or one-way)
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum RoadFlow {
    /// Two-way traffic (default)
    #[default]
    TwoWay,
    /// One-way traffic in the specified direction
    OneWay(RoadDir),
}

/// Lane type - determines allowed movements
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum LaneType {
    /// Regular lane - can go straight, change lanes, and turn at intersections
    #[default]
    Regular,
    /// Left turn only lane - must turn left at next intersection
    LeftTurnOnly,
    /// Right turn only lane - must turn right at next intersection
    RightTurnOnly,
    /// Straight only lane - cannot turn, only go straight
    StraightOnly,
}

impl RoadDir {
    #[allow(dead_code)]
    pub fn delta(self) -> IVec2 {
        match self {
            RoadDir::None => IVec2::ZERO,
            RoadDir::West => IVec2::new(-1, 0),
            RoadDir::East => IVec2::new(1, 0),
            RoadDir::North => IVec2::new(0, 1),
            RoadDir::South => IVec2::new(0, -1),
        }
    }

    pub fn opposite(self) -> RoadDir {
        match self {
            RoadDir::None => RoadDir::None,
            RoadDir::West => RoadDir::East,
            RoadDir::East => RoadDir::West,
            RoadDir::North => RoadDir::South,
            RoadDir::South => RoadDir::North,
        }
    }

    pub fn left(self) -> RoadDir {
        match self {
            RoadDir::None => RoadDir::None,
            RoadDir::East => RoadDir::North,
            RoadDir::North => RoadDir::West,
            RoadDir::West => RoadDir::South,
            RoadDir::South => RoadDir::East,
        }
    }

    pub fn right(self) -> RoadDir {
        match self {
            RoadDir::None => RoadDir::None,
            RoadDir::East => RoadDir::South,
            RoadDir::South => RoadDir::West,
            RoadDir::West => RoadDir::North,
            RoadDir::North => RoadDir::East,
        }
    }
}

/// Road data stored per map cell when lanes are modeled as separate tiles.
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub struct RoadCell {
    pub kind: RoadKind,
    /// Travel direction for this lane tile (right-hand traffic).
    pub dir: RoadDir,
    /// Lane index within the cross-section, 0..kind.lanes()-1 (rightmost to leftmost in draw dir).
    pub lane: u8,
    /// Flow direction (two-way or one-way)
    pub flow: RoadFlow,
    /// Lane type - determines allowed movements (turns, straight, etc.)
    pub lane_type: LaneType,
}

impl RoadCell {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn is_some(self) -> bool {
        self.kind != RoadKind::None
    }

    pub fn lanes_total(self) -> u8 {
        self.kind.lanes()
    }

    #[allow(dead_code)]
    pub fn half_lanes(self) -> u8 {
        self.lanes_total() / 2
    }

    /// Whether this lane is the rightmost lane for its travel direction.
    pub fn is_rightmost_for_dir(self) -> bool {
        let lanes = self.lanes_total();
        let half = lanes / 2;
        if lanes == 0 {
            return false;
        }
        if self.lane < half {
            // "forward" carriageway (paint dir)
            self.lane == 0
        } else {
            // opposite carriageway
            self.lane == lanes.saturating_sub(1)
        }
    }

    /// Whether this lane is the leftmost lane for its travel direction (closest to centerline).
    pub fn is_leftmost_for_dir(self) -> bool {
        let lanes = self.lanes_total();
        let half = lanes / 2;
        if lanes == 0 {
            return false;
        }
        if self.lane < half {
            self.lane == half.saturating_sub(1)
        } else {
            self.lane == half
        }
    }
}
