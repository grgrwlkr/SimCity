use bevy::prelude::*;

use crate::game::ids::CitizenId;
use crate::game::map::TilePos;

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum TripPurpose {
    Work,
    Shop,
    ReturnHome,
}

/// Command-like message emitted by simulation (citizens) and consumed by transport (traffic).
#[derive(Message, Debug, Copy, Clone)]
pub struct TripRequested {
    pub citizen: CitizenId,
    pub from: TilePos,
    pub to: TilePos,
    pub purpose: TripPurpose,
}

/// Completion message emitted by transport (traffic) and consumed by simulation (citizens).
#[derive(Message, Debug, Copy, Clone)]
pub struct TripFinished {
    pub citizen: CitizenId,
    pub purpose: TripPurpose,
}
