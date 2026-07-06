//! 6.5.1 Externalized configs (`.ron`) (MVP).
//!
//! Loads gameplay tuning resources from `assets/config/*.ron` if present.
//! If a file is missing or fails to parse, the built-in defaults remain in effect.

use std::fs;
use std::path::{Path, PathBuf};

use bevy::prelude::*;

use crate::game::day_night::DayNightVisualConfig;
use crate::game::economy::EconomyConfig;
use crate::game::employment::EmploymentConfig;
use crate::game::map::MapConfig;
use crate::game::pedestrians::PedestrianConfig;
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
    load::<DayNightVisualConfig>("assets/config/day_night.ron", &mut commands);
    load::<PedestrianConfig>("assets/config/pedestrians.ron", &mut commands);
}

fn workspace_path(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn load<T>(path: &str, commands: &mut Commands)
where
    T: serde::de::DeserializeOwned + Resource,
{
    let full_path = workspace_path(path);
    let Ok(text) = fs::read_to_string(&full_path) else {
        return;
    };

    match ron::from_str::<T>(&text) {
        Ok(cfg) => {
            info!("Loaded config: {}", full_path.display());
            commands.insert_resource(cfg);
        }
        Err(err) => {
            warn!("Failed to parse config {}: {err}", full_path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::game::emergencies::EmergencyStats;
    use crate::game::map::{TileKind, TilePos, ZoneKind};
    use crate::game::persistence_contract::{MapGridV1, MapTileV1, SaveGameV3};
    use crate::game::roads::RoadCell;
    use crate::game::scenarios::Scenario;
    use crate::game::sim::City;

    fn parse_required<T>(path: &str) -> T
    where
        T: serde::de::DeserializeOwned,
    {
        let full_path = workspace_path(path);
        let text = fs::read_to_string(&full_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {e}", full_path.display()));
        ron::from_str::<T>(&text).unwrap_or_else(|e| panic!("Failed to parse {path}: {e}"))
    }

    fn minimal_map() -> MapGridV1 {
        MapGridV1 {
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
        }
    }

    #[test]
    fn ron_assets_parse() {
        parse_required::<MapConfig>("assets/config/map.ron");
        parse_required::<EconomyConfig>("assets/config/economy.ron");
        parse_required::<TrafficConfig>("assets/config/traffic.ron");
        parse_required::<PathfindingConfig>("assets/config/pathfinding.ron");
        parse_required::<EmploymentConfig>("assets/config/employment.ron");
        parse_required::<DayNightVisualConfig>("assets/config/day_night.ron");
        parse_required::<PedestrianConfig>("assets/config/pedestrians.ron");

        parse_required::<Vec<Scenario>>("assets/scenarios/scenarios.ron");
    }

    #[test]
    fn savegame_v3_roundtrips_through_ron() {
        use crate::game::roads::{LaneType, RoadDir, RoadFlow, RoadKind};

        // A non-default FourLane RoadCell (the multi-lane test-city road kind): every field
        // off-default so the RON roundtrip is exercised on each of kind/dir/lane/flow/lane_type.
        let four_lane = RoadCell {
            kind: RoadKind::FourLane,
            dir: RoadDir::West,
            lane: 3,
            flow: RoadFlow::OneWay(RoadDir::West),
            lane_type: LaneType::LeftTurnOnly,
        };
        let mut map = minimal_map();
        map.width = 2;
        map.height = 1;
        map.tiles.push(MapTileV1 {
            height: 7,
            water: false,
            terrain: TileKind::Grass,
            road: four_lane,
            zone: ZoneKind::None,
            building: None,
        });

        let save = SaveGameV3 {
            save_version: 3,
            seed: 1,
            map,
            city: City::default(),
            buildings: Vec::new(),
            citizens: Vec::new(),
            next_citizen_id: 1,
            service_stations: Vec::new(),
            emergency_stats: EmergencyStats::default(),
            traffic_light_tiles: vec![TilePos { x: 3, y: 4 }],
        };

        let pretty = ron::ser::PrettyConfig::new();
        let text = ron::ser::to_string_pretty(&save, pretty).expect("serialize SaveGameV3");
        let parsed: SaveGameV3 = ron::from_str(&text).expect("deserialize SaveGameV3");
        assert_eq!(parsed.save_version, 3);
        assert_eq!(parsed.traffic_light_tiles, vec![TilePos { x: 3, y: 4 }]);
        // The FourLane cell survives the roundtrip with every field intact.
        let roundtripped = parsed.map.tiles[1].road;
        assert_eq!(roundtripped.kind, RoadKind::FourLane);
        assert_eq!(roundtripped.dir, RoadDir::West);
        assert_eq!(roundtripped.lane, 3);
        assert_eq!(roundtripped.flow, RoadFlow::OneWay(RoadDir::West));
        assert_eq!(roundtripped.lane_type, LaneType::LeftTurnOnly);
    }

    /// Old saves without the `traffic_light_tiles` field must still deserialize
    /// (additive field with `#[serde(default)]` → empty vec).
    ///
    /// We generate a V3 RON string via a shadow struct that lacks `traffic_light_tiles`,
    /// then parse it as `SaveGameV3`. This is the closest simulation of a pre-P0-7 save file.
    #[test]
    fn savegame_v3_old_save_compat_missing_traffic_lights() {
        // Shadow struct identical to SaveGameV3 but WITHOUT traffic_light_tiles.
        #[derive(serde::Serialize)]
        struct SaveGameV3Pre {
            save_version: u32,
            seed: u64,
            map: MapGridV1,
            city: City,
            buildings: Vec<crate::game::persistence_contract::BuildingSnapshot>,
            citizens: Vec<crate::game::persistence_contract::CitizenSnapshotV1>,
            next_citizen_id: u64,
            service_stations: Vec<crate::game::persistence_contract::ServiceStationSnapshot>,
            emergency_stats: EmergencyStats,
        }

        let pre_p0_7 = SaveGameV3Pre {
            save_version: 3,
            seed: 42,
            map: minimal_map(),
            city: City::default(),
            buildings: Vec::new(),
            citizens: Vec::new(),
            next_citizen_id: 1,
            service_stations: Vec::new(),
            emergency_stats: EmergencyStats::default(),
        };

        let pretty = ron::ser::PrettyConfig::new();
        let text = ron::ser::to_string_pretty(&pre_p0_7, pretty).expect("serialize pre-P0-7 save");

        let parsed: SaveGameV3 = ron::from_str(&text)
            .expect("old V3 save without traffic_light_tiles must parse successfully");
        assert_eq!(parsed.save_version, 3);
        assert!(
            parsed.traffic_light_tiles.is_empty(),
            "missing field should default to empty vec"
        );
    }
}
