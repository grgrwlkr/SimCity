use bevy::prelude::*;

use crate::game::ids::CitizenId;
use crate::game::map::TilePos;

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum TripPurpose {
    Work,
    Shop,
    ReturnHome,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum TripMode {
    Walk,
    Car,
    Transit,
}

/// Command-like message emitted by simulation (citizens) and consumed by transport (traffic).
#[derive(Message, Debug, Copy, Clone)]
pub struct TripRequested {
    pub citizen: CitizenId,
    pub from: TilePos,
    /// For car trips: where the citizen's car is currently parked (building tile).
    ///
    /// This is carried in the message to avoid a hot-path lookup of `Citizen` state inside
    /// `spawn_trip_vehicles` (keeps trip spawning O(1) w.r.t. citizen count).
    pub car_parked_at: Option<TilePos>,
    pub to: TilePos,
    pub purpose: TripPurpose,
    pub mode: TripMode,
}

/// Completion message emitted by transport (traffic) and consumed by simulation (citizens).
#[derive(Message, Debug, Copy, Clone)]
pub struct TripFinished {
    pub citizen: CitizenId,
    pub purpose: TripPurpose,
}
