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
use crate::game::pedestrians::PedestrianConfig;
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
    load::<PedestrianConfig>("assets/config/pedestrians.ron", &mut commands);
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::game::emergencies::EmergencyStats;
    use crate::game::map::{TileKind, ZoneKind};
    use crate::game::persistence_contract::{MapGridV1, MapTileV1, SaveGameV2};
    use crate::game::roads::RoadCell;
    use crate::game::scenarios::Scenario;
    use crate::game::sim::City;

    fn parse_required<T>(path: &str)
    where
        T: serde::de::DeserializeOwned,
    {
        let text =
            fs::read_to_string(path).unwrap_or_else(|e| panic!("Failed to read {path}: {e}"));
        ron::from_str::<T>(&text).unwrap_or_else(|e| panic!("Failed to parse {path}: {e}"));
    }

    #[test]
    fn ron_assets_parse() {
        parse_required::<MapConfig>("assets/config/map.ron");
        parse_required::<EconomyConfig>("assets/config/economy.ron");
        parse_required::<TrafficConfig>("assets/config/traffic.ron");
        parse_required::<PathfindingConfig>("assets/config/pathfinding.ron");
        parse_required::<EmploymentConfig>("assets/config/employment.ron");
        parse_required::<BuildingTuning>("assets/config/buildings.ron");
        parse_required::<PublicTransportConfig>("assets/config/public_transport.ron");
        parse_required::<DayNightCycle>("assets/config/day_night.ron");
        parse_required::<CustomBuildingRegistry>("assets/config/custom_buildings.ron");
        parse_required::<PedestrianConfig>("assets/config/pedestrians.ron");

        parse_required::<Vec<Scenario>>("assets/scenarios/scenarios.ron");
    }

    #[test]
    fn savegame_v2_roundtrips_through_ron() {
        let save = SaveGameV2 {
            save_version: 2,
            seed: 1,
            map: MapGridV1 {
                width: 1,
                height: 1,
                tiles: vec![MapTileV1 {
                    height: 0,
                    water: false,
                    terrain: TileKind::Grass,
                    road: RoadCell::none(),
                    zone: ZoneKind::None,
                    building: None,
                }],
            },
            city: City::default(),
            citizens: Vec::new(),
            next_citizen_id: 1,
            service_stations: Vec::new(),
            emergency_stats: EmergencyStats::default(),
        };

        let pretty = ron::ser::PrettyConfig::new();
        let text = ron::ser::to_string_pretty(&save, pretty).expect("serialize SaveGameV2");
        let parsed: SaveGameV2 = ron::from_str(&text).expect("deserialize SaveGameV2");
        assert_eq!(parsed.save_version, 2);
    }
}
