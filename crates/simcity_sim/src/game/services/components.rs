use bevy::prelude::*;

use crate::game::map::{BuildingKind, TilePos};

/// Kind of service (which vehicles & emergencies it handles).
#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum ServiceKind {
    Fire,
    Police,
    Medical,
}

impl ServiceKind {
    pub fn from_building(kind: BuildingKind) -> Option<Self> {
        match kind {
            BuildingKind::FireStation => Some(ServiceKind::Fire),
            BuildingKind::PoliceStation => Some(ServiceKind::Police),
            BuildingKind::Hospital => Some(ServiceKind::Medical),
            _ => None,
        }
    }

    pub fn vehicle_color(self) -> Color {
        match self {
            ServiceKind::Fire => Color::srgb(0.9, 0.2, 0.1),
            ServiceKind::Police => Color::srgb(0.1, 0.3, 0.9),
            ServiceKind::Medical => Color::srgb(0.1, 0.8, 0.2),
        }
    }

    pub fn vehicle_speed(self) -> f32 {
        match self {
            ServiceKind::Fire => 90.0,
            ServiceKind::Police => 100.0,
            ServiceKind::Medical => 85.0,
        }
    }
}

/// Marker component for a service station building.
#[derive(Component, Debug, Copy, Clone)]
pub struct ServiceStation {
    pub kind: ServiceKind,
    pub pos: TilePos,
    pub total_vehicles: u8,
    pub available_vehicles: u8,
}

/// Service vehicle state machine (minimal for now; dispatch logic is 5.4+).
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ServiceVehicleState {
    AtStation,
    EnRoute,
    OnScene,
    Returning,
}

/// Service vehicle component (attached to a `Vehicle` entity).
#[derive(Component, Debug)]
pub struct ServiceVehicle {
    pub kind: ServiceKind,
    pub home_station: Entity,
    pub home_road: TilePos,
    pub mission: Option<Entity>,
    pub state: ServiceVehicleState,
}

/// Visual marker component for the colored inner sprite (child entity).
#[derive(Component)]
pub struct ServiceVehicleMarker;
