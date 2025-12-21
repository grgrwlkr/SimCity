//! 6.5.2 Custom building types (extensibility foundations).
//!
//! This module introduces a lightweight registry that can be populated either:
//! - via code (plugins calling `CustomBuildingRegistry::register`), or
//! - via data (`assets/config/custom_buildings.ron`) using `ConfigLoaderPlugin`.
//!
//! NOTE: Integration of custom building defs into placement/UI is intentionally minimal.
//! The goal of this milestone is to provide a stable extension point without refactoring
//! the existing `BuildingKind` enum yet.

use bevy::prelude::*;

/// A data-driven building definition that can be registered by plugins.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct CustomBuildingDef {
    /// Stable numeric id (chosen by the author of the config/mod).
    pub id: u16,
    pub name: String,

    /// Display color (sRGB).
    pub color: [f32; 3],

    /// Economic tuning (optional; depends on future integration).
    pub build_cost: i64,

    /// Optional capacities (kept for future integration).
    pub capacity_residents: u16,
    pub capacity_jobs: u16,
}

impl CustomBuildingDef {
    #[allow(dead_code)]
    pub fn color_srgb(&self) -> Color {
        Color::srgb(self.color[0], self.color[1], self.color[2])
    }
}

/// Registry for custom building definitions.
#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone, Default)]
pub struct CustomBuildingRegistry {
    pub buildings: Vec<CustomBuildingDef>,
}

impl CustomBuildingRegistry {
    #[allow(dead_code)]
    pub fn get(&self, id: u16) -> Option<&CustomBuildingDef> {
        self.buildings.iter().find(|b| b.id == id)
    }

    #[allow(dead_code)]
    pub fn register(&mut self, def: CustomBuildingDef) {
        // Replace by id if exists (id is considered stable).
        if let Some(existing) = self.buildings.iter_mut().find(|b| b.id == def.id) {
            *existing = def;
            return;
        }
        self.buildings.push(def);
        self.buildings.sort_by_key(|b| b.id);
    }
}

pub struct CustomBuildingsPlugin;

impl Plugin for CustomBuildingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CustomBuildingRegistry>();
    }
}
