use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

pub mod config_loader;
pub mod custom_buildings;
pub mod persistence;
pub mod persistence_contract;
pub mod scenarios;
mod test_city;

pub use simcity_core::game::{commands, ids, roads, sets, sim_events, state, trips, ui_state};
pub use simcity_sim::game::{
    buildings, citizens, day_night, economy, emergencies, employment, intersections, map,
    pedestrians, services, sim, traffic, transport,
};

pub struct DataPlugin;

impl Plugin for DataPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((
            config_loader::ConfigLoaderPlugin,
            custom_buildings::CustomBuildingsPlugin,
            persistence::PersistencePlugin,
            persistence_contract::PersistenceContractPlugin,
            scenarios::ScenariosPlugin,
        ))
        .add_systems(
            Update,
            handle_load_test_city.in_set(sets::GameSet::CommandApply),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_load_test_city(
    mut cmd_reader: MessageReader<commands::GameCommand>,
    mut commands: Commands,
    cfg: Res<map::MapConfig>,
    mut grid: ResMut<map::MapGrid>,
    mut city: ResMut<sim::City>,
    mut intersections: ResMut<intersections::IntersectionIndex>,
    mut dirty: ResMut<map::DirtyTiles>,
    mut road_dirty: ResMut<map::RoadDirtyTiles>,
    mut graph_version: ResMut<transport::GraphVersion>,
    mut map_edit_version: ResMut<map::MapEditVersion>,
    mut day_out: bevy::ecs::message::MessageWriter<sim_events::DayAdvanced>,
) {
    for cmd in cmd_reader.read() {
        if !matches!(cmd, commands::GameCommand::LoadTestCity) {
            continue;
        }

        test_city::generate_test_city(
            &mut commands,
            &mut grid,
            &cfg,
            &mut city,
            &mut intersections,
        );
        dirty.mark_all();
        road_dirty.mark_all();
        map_edit_version.bump();
        graph_version.bump();
        day_out.write(sim_events::DayAdvanced { day: city.day });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::app::App;
    use bevy::ecs::message::MessageWriter;

    #[derive(Resource, Default)]
    struct TestCommandOnce(bool);

    fn send_load_test_city_once(
        mut out: MessageWriter<commands::GameCommand>,
        mut sent: ResMut<TestCommandOnce>,
    ) {
        if sent.0 {
            return;
        }
        sent.0 = true;
        out.write(commands::GameCommand::LoadTestCity);
    }

    #[test]
    fn load_test_city_keeps_zones_without_prebuilt_rci() {
        let cfg = map::MapConfig::default();
        let tile_count = (cfg.width as usize) * (cfg.height as usize);

        let mut app = App::new();
        app.add_message::<commands::GameCommand>()
            .add_message::<sim_events::DayAdvanced>()
            .insert_resource(cfg.clone())
            .insert_resource(map::MapSeed(1))
            .insert_resource(map::MapGrid::new(cfg.width, cfg.height))
            .insert_resource(map::DirtyTiles::new(tile_count))
            .insert_resource(map::RoadDirtyTiles::new(tile_count))
            .insert_resource(sim::City::default())
            .insert_resource(transport::GraphVersion(1))
            .insert_resource(map::MapEditVersion::default())
            .insert_resource(intersections::IntersectionIndex::default())
            .insert_resource(TestCommandOnce::default())
            .add_systems(
                Update,
                (send_load_test_city_once, handle_load_test_city).chain(),
            );

        app.update();

        let grid = app.world().resource::<map::MapGrid>();

        let residential_zone_count = grid
            .cells
            .iter()
            .filter(|cell| cell.zone == map::ZoneKind::Residential)
            .count();
        let commercial_zone_count = grid
            .cells
            .iter()
            .filter(|cell| cell.zone == map::ZoneKind::Commercial)
            .count();
        let industrial_zone_count = grid
            .cells
            .iter()
            .filter(|cell| cell.zone == map::ZoneKind::Industrial)
            .count();
        assert!(
            residential_zone_count > 0,
            "LoadTestCity should include Residential zoning"
        );
        assert!(
            commercial_zone_count > 0,
            "LoadTestCity should include Commercial zoning"
        );
        assert!(
            industrial_zone_count > 0,
            "LoadTestCity should include Industrial zoning"
        );

        let highway_y = cfg.height / 2;
        let arterial2_x = cfg.width * 3 / 4;
        let mut upper_right_commercial_count = 0usize;
        for y in (highway_y + 8)..(cfg.height - 40) {
            for x in (arterial2_x + 5)..(cfg.width - 15) {
                let pos = map::TilePos { x, y };
                if matches!(
                    grid.get(pos).map(|cell| cell.zone),
                    Some(map::ZoneKind::Commercial)
                ) {
                    upper_right_commercial_count += 1;
                }
            }
        }
        assert!(
            upper_right_commercial_count > 0,
            "LoadTestCity should place Commercial zoning in the upper-right district"
        );

        let mut dead_zone_tiles = Vec::new();
        for y in 0..grid.height {
            for x in 0..grid.width {
                let pos = map::TilePos { x, y };
                let Some(cell) = grid.get(pos) else {
                    continue;
                };
                if !matches!(
                    cell.zone,
                    map::ZoneKind::Residential
                        | map::ZoneKind::Commercial
                        | map::ZoneKind::Industrial
                ) {
                    continue;
                }
                if !buildings::is_within_zone_depth(pos, grid, buildings::MAX_ZONE_DEPTH) {
                    dead_zone_tiles.push(pos);
                }
            }
        }
        assert!(
            dead_zone_tiles.is_empty(),
            "LoadTestCity should not create dead-zoned R/C/I tiles (MAX_ZONE_DEPTH={}): found {} out-of-depth tiles, examples: {:?}",
            buildings::MAX_ZONE_DEPTH,
            dead_zone_tiles.len(),
            dead_zone_tiles.iter().take(8).collect::<Vec<_>>()
        );

        let rci_building_tile_count = grid
            .cells
            .iter()
            .filter(|cell| {
                matches!(
                    cell.building,
                    Some(
                        map::BuildingKind::Residential
                            | map::BuildingKind::Commercial
                            | map::BuildingKind::Industrial
                    )
                )
            })
            .count();
        assert_eq!(
            rci_building_tile_count, 0,
            "LoadTestCity should not preseed R/C/I building tiles"
        );

        let rci_building_entity_count = {
            let world = app.world_mut();
            let mut query = world.query::<&buildings::Building>();
            query
                .iter(world)
                .filter(|building| {
                    matches!(
                        building.kind,
                        map::BuildingKind::Residential
                            | map::BuildingKind::Commercial
                            | map::BuildingKind::Industrial
                    )
                })
                .count()
        };
        assert_eq!(
            rci_building_entity_count, 0,
            "LoadTestCity should not spawn prebuilt R/C/I building entities"
        );

        let service_building_count = {
            let world = app.world_mut();
            let mut query = world.query::<&buildings::Building>();
            query
                .iter(world)
                .filter(|building| {
                    matches!(
                        building.kind,
                        map::BuildingKind::FireStation
                            | map::BuildingKind::PoliceStation
                            | map::BuildingKind::Hospital
                    )
                })
                .count()
        };
        assert!(
            service_building_count > 0,
            "LoadTestCity should still spawn service buildings (FireStation, PoliceStation, Hospital)"
        );
    }
}
