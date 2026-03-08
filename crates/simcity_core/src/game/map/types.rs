use bevy::prelude::*;

/// Map rendering/config constants.
#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct MapConfig {
    pub width: i32,
    pub height: i32,
    pub tile_size: f32,
}

impl Default for MapConfig {
    fn default() -> Self {
        Self {
            width: 128,
            height: 128,
            tile_size: 16.0,
        }
    }
}

#[derive(
    serde::Serialize, serde::Deserialize, Component, Debug, Copy, Clone, Eq, PartialEq, Hash,
)]
#[repr(C)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

#[derive(
    serde::Serialize,
    serde::Deserialize,
    Component,
    Debug,
    Copy,
    Clone,
    Eq,
    PartialEq,
    Hash,
    Default,
)]
pub enum TileKind {
    Water,
    #[default]
    Grass,
    Road,
    Residential,
    Commercial,
    Industrial,
}

impl TileKind {
    pub fn color(self) -> Color {
        match self {
            TileKind::Water => Color::srgb(0.08, 0.28, 0.78),
            TileKind::Grass => Color::srgb(0.15, 0.42, 0.18),
            TileKind::Road => Color::srgb(0.18, 0.18, 0.20),
            TileKind::Residential => Color::srgb(0.18, 0.65, 0.22),
            TileKind::Commercial => Color::srgb(0.18, 0.36, 0.72),
            TileKind::Industrial => Color::srgb(0.72, 0.56, 0.12),
        }
    }
}

/// Zoning layer (separate from roads/terrain).
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum ZoneKind {
    #[default]
    None,
    Residential,
    Commercial,
    Industrial,
}

impl ZoneKind {
    pub fn as_tile_kind(self) -> Option<TileKind> {
        match self {
            ZoneKind::None => None,
            ZoneKind::Residential => Some(TileKind::Residential),
            ZoneKind::Commercial => Some(TileKind::Commercial),
            ZoneKind::Industrial => Some(TileKind::Industrial),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum BuildingKind {
    Residential,
    Commercial,
    Industrial,
    FireStation,
    PoliceStation,
    Hospital,
}

impl BuildingKind {
    pub fn color(self) -> Color {
        match self {
            BuildingKind::Residential => Color::srgb(0.10, 0.55, 0.18),
            BuildingKind::Commercial => Color::srgb(0.10, 0.22, 0.55),
            BuildingKind::Industrial => Color::srgb(0.65, 0.45, 0.08),
            BuildingKind::FireStation => Color::srgb(0.75, 0.15, 0.12),
            BuildingKind::PoliceStation => Color::srgb(0.12, 0.22, 0.75),
            BuildingKind::Hospital => Color::srgb(0.12, 0.75, 0.22),
        }
    }

    pub fn as_zone(self) -> ZoneKind {
        match self {
            BuildingKind::Residential => ZoneKind::Residential,
            BuildingKind::Commercial => ZoneKind::Commercial,
            BuildingKind::Industrial => ZoneKind::Industrial,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => {
                ZoneKind::None
            }
        }
    }

    pub fn from_zone(zone: ZoneKind) -> Option<Self> {
        match zone {
            ZoneKind::Residential => Some(BuildingKind::Residential),
            ZoneKind::Commercial => Some(BuildingKind::Commercial),
            ZoneKind::Industrial => Some(BuildingKind::Industrial),
            ZoneKind::None => None,
        }
    }

    pub fn service_radius(self) -> Option<u16> {
        match self {
            BuildingKind::FireStation => Some(20),
            BuildingKind::PoliceStation => Some(25),
            BuildingKind::Hospital => Some(30),
            _ => None,
        }
    }

    pub fn vehicle_capacity(self) -> u8 {
        match self {
            BuildingKind::FireStation => 3,
            BuildingKind::PoliceStation => 4,
            BuildingKind::Hospital => 2,
            _ => 0,
        }
    }

    pub fn build_cost(self) -> i64 {
        match self {
            BuildingKind::Residential => 50,
            BuildingKind::Commercial => 60,
            BuildingKind::Industrial => 80,
            BuildingKind::FireStation => 500,
            BuildingKind::PoliceStation => 400,
            BuildingKind::Hospital => 800,
        }
    }

    pub fn capacity_residents(self) -> u16 {
        match self {
            BuildingKind::Residential => 4,
            BuildingKind::Commercial => 0,
            BuildingKind::Industrial => 0,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => 0,
        }
    }

    pub fn capacity_jobs(self) -> u16 {
        match self {
            BuildingKind::Residential => 0,
            BuildingKind::Commercial => 3,
            BuildingKind::Industrial => 4,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => 0,
        }
    }

    pub fn capacity_residents_for_level(self, level: u8) -> u16 {
        match (self, level) {
            (BuildingKind::Residential, 1) => 4,
            (BuildingKind::Residential, 2) => 12,
            (BuildingKind::Residential, 3) => 30,
            _ => self.capacity_residents(),
        }
    }

    pub fn capacity_residents_for_level_area(self, level: u8, area: u32) -> u16 {
        let base = self.capacity_residents_for_level(level) as f32;
        let factor = (area as f32) / 9.0;
        (base * factor).round().clamp(0.0, u16::MAX as f32) as u16
    }

    pub fn capacity_jobs_for_level(self, level: u8) -> u16 {
        match (self, level) {
            (BuildingKind::Commercial, 1) => 3,
            (BuildingKind::Commercial, 2) => 10,
            (BuildingKind::Commercial, 3) => 25,
            (BuildingKind::Industrial, 1) => 4,
            (BuildingKind::Industrial, 2) => 15,
            (BuildingKind::Industrial, 3) => 40,
            _ => self.capacity_jobs(),
        }
    }

    pub fn capacity_jobs_for_level_area(self, level: u8, area: u32) -> u16 {
        let base = self.capacity_jobs_for_level(level) as f32;
        let factor = (area as f32) / 9.0;
        (base * factor).round().clamp(0.0, u16::MAX as f32) as u16
    }
}
