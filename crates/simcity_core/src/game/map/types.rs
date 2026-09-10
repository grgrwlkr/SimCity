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

/// How densely a zone builds (B2). `Medium` is what every zone was before densities existed, so an
/// old save and an untouched zone keep growing exactly as they did.
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum ZoneDensity {
    Low,
    #[default]
    Medium,
    High,
}

impl ZoneDensity {
    pub const ALL: [ZoneDensity; 3] = [ZoneDensity::Low, ZoneDensity::Medium, ZoneDensity::High];

    /// Shortest and longest side of a footprint that grows in this density.
    pub fn footprint_sides(self) -> (u8, u8) {
        match self {
            ZoneDensity::Low => (3, 4),
            ZoneDensity::Medium => (3, 6),
            ZoneDensity::High => (3, 6),
        }
    }

    /// Lowest and highest level a building of this density reaches.
    pub fn levels(self) -> (u8, u8) {
        match self {
            ZoneDensity::Low => (1, 2),
            ZoneDensity::Medium => (1, 3),
            ZoneDensity::High => (2, 3),
        }
    }

    /// Residents or jobs a building holds against one of the same size and level in `Medium`.
    pub fn capacity_factor(self) -> f32 {
        match self {
            ZoneDensity::Low | ZoneDensity::Medium => 1.0,
            ZoneDensity::High => 2.0,
        }
    }

    /// Height against a building of the same level in `Medium`.
    pub fn height_factor(self) -> f32 {
        match self {
            ZoneDensity::Low => 0.8,
            ZoneDensity::Medium => 1.0,
            ZoneDensity::High => 1.6,
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
    /// Supplies power along the roads it fronts.
    PowerPlant,
    /// Supplies water along the roads it fronts.
    WaterPump,
    /// Collects garbage along the roads it fronts.
    Landfill,
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
            BuildingKind::PowerPlant => Color::srgb(0.85, 0.72, 0.15),
            BuildingKind::WaterPump => Color::srgb(0.15, 0.55, 0.85),
            BuildingKind::Landfill => Color::srgb(0.45, 0.36, 0.26),
        }
    }

    pub fn as_zone(self) -> ZoneKind {
        match self {
            BuildingKind::Residential => ZoneKind::Residential,
            BuildingKind::Commercial => ZoneKind::Commercial,
            BuildingKind::Industrial => ZoneKind::Industrial,
            BuildingKind::FireStation
            | BuildingKind::PoliceStation
            | BuildingKind::Hospital
            | BuildingKind::PowerPlant
            | BuildingKind::WaterPump
            | BuildingKind::Landfill => ZoneKind::None,
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
            BuildingKind::PowerPlant => 1000,
            BuildingKind::WaterPump => 600,
            BuildingKind::Landfill => 400,
        }
    }

    pub fn capacity_residents(self) -> u16 {
        match self {
            BuildingKind::Residential => 4,
            BuildingKind::Commercial => 0,
            BuildingKind::Industrial => 0,
            BuildingKind::FireStation
            | BuildingKind::PoliceStation
            | BuildingKind::Hospital
            | BuildingKind::PowerPlant
            | BuildingKind::WaterPump
            | BuildingKind::Landfill => 0,
        }
    }

    pub fn capacity_jobs(self) -> u16 {
        match self {
            BuildingKind::Residential => 0,
            BuildingKind::Commercial => 3,
            BuildingKind::Industrial => 4,
            BuildingKind::FireStation
            | BuildingKind::PoliceStation
            | BuildingKind::Hospital
            | BuildingKind::PowerPlant
            | BuildingKind::WaterPump
            | BuildingKind::Landfill => 0,
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
