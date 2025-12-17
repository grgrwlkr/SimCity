//! 6.5.1 Externalized configs (`.ron`) (MVP).
//!
//! Loads gameplay tuning resources from `assets/config/*.ron` if present.
//! If a file is missing or fails to parse, the built-in defaults remain in effect.

use std::fs;

use bevy::prelude::*;

use crate::game::buildings::BuildingTuning;
use crate::game::custom_buildings::CustomBuildingRegistry;
use crate::game::day_night::DayNightCycle;
use crate::game::economy::EconomyConfig;
use crate::game::employment::EmploymentConfig;
use crate::game::map::MapConfig;
use crate::game::public_transport::PublicTransportConfig;
use crate::game::traffic::TrafficConfig;
use crate::game::transport::PathfindingConfig;

pub struct ConfigLoaderPlugin;

impl Plugin for ConfigLoaderPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, load_configs_from_ron);
    }
}

fn load_configs_from_ron(mut commands: Commands) {
    load::<MapConfig>("assets/config/map.ron", &mut commands);
    load::<EconomyConfig>("assets/config/economy.ron", &mut commands);
    load::<TrafficConfig>("assets/config/traffic.ron", &mut commands);
    load::<PathfindingConfig>("assets/config/pathfinding.ron", &mut commands);
    load::<EmploymentConfig>("assets/config/employment.ron", &mut commands);
    load::<BuildingTuning>("assets/config/buildings.ron", &mut commands);
    load::<PublicTransportConfig>("assets/config/public_transport.ron", &mut commands);
    load::<DayNightCycle>("assets/config/day_night.ron", &mut commands);
    load::<CustomBuildingRegistry>("assets/config/custom_buildings.ron", &mut commands);
}

fn load<T>(path: &str, commands: &mut Commands)
where
    T: serde::de::DeserializeOwned + Resource,
{
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };

    match ron::from_str::<T>(&text) {
        Ok(cfg) => {
            info!("Loaded config: {path}");
            commands.insert_resource(cfg);
        }
        Err(err) => {
            warn!("Failed to parse config {path}: {err}");
        }
    }
}
