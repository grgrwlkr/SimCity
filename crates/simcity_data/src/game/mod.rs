use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

pub mod config_loader;
#[cfg(test)]
mod determinism;
#[cfg(test)]
mod headless_sim;
pub mod persistence;
pub mod persistence_contract;
pub mod scenarios;
#[cfg(test)]
mod soak;
mod test_city;

pub use simcity_core::game::{commands, ids, roads, sets, sim_events, state, trips, ui_state};
pub use simcity_sim::game::{
    buildings, citizens, command_history, day_night, economy, emergencies, employment,
    intersections, land_value, map, pedestrians, pollution, services, sim, traffic, transport,
};

pub struct DataPlugin;

impl Plugin for DataPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((
            config_loader::ConfigLoaderPlugin,
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
    mut history: ResMut<command_history::CommandHistory>,
    mut pollution_idx: Option<ResMut<pollution::PollutionIndex>>,
    mut land_value_idx: Option<ResMut<land_value::LandValueIndex>>,
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
        // Undo entries reference tile state from the previous map; replaying
        // them into the freshly generated city would corrupt it.
        history.clear();
        // Same rule for derived environment fields: stale pollution/land value
        // from the previous city would feed growth and overlays for a whole
        // recompute pass (~51 s) after load.
        if let Some(p) = pollution_idx.as_mut() {
            p.reset_values();
        }
        if let Some(lv) = land_value_idx.as_mut() {
            lv.reset_values();
        }
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
            .insert_resource(command_history::CommandHistory::new(100))
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

    /// B3 pin: `CommandHistory` must not survive `LoadTestCity` — stale entries
    /// would let Ctrl+Z write tile state from the PREVIOUS map into the freshly
    /// loaded one. Pre-fix this fails: the handler never touched the history.
    #[test]
    fn load_test_city_clears_command_history() {
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
            .insert_resource(command_history::CommandHistory::new(100))
            .insert_resource(intersections::IntersectionIndex::default())
            .insert_resource(TestCommandOnce::default())
            .add_systems(
                Update,
                (send_load_test_city_once, handle_load_test_city).chain(),
            );

        // Prefill both stacks: two edits, then one undo (moves an entry to redo).
        {
            let mut history = app
                .world_mut()
                .resource_mut::<command_history::CommandHistory>();
            for _ in 0..2 {
                history.push(command_history::UndoableCommand::SetZone {
                    pos: map::TilePos { x: 1, y: 1 },
                    old: map::ZoneKind::None,
                    new: map::ZoneKind::Residential,
                });
            }
            let _ = history.undo();
            assert!(history.can_undo() && history.can_redo());
        }

        app.update();

        let history = app.world().resource::<command_history::CommandHistory>();
        assert!(
            !history.can_undo(),
            "LoadTestCity must clear the undo stack (stale entries reference the old map)"
        );
        assert!(
            !history.can_redo(),
            "LoadTestCity must clear the redo stack (stale entries reference the old map)"
        );
    }

    /// Smoke test for the multi-lane (FourLane) conversion: loading the test city and building the
    /// intersection clusters + lane graph + lanelet graph on the resulting 4x4/mixed-width boxes must
    /// NOT panic and must produce lanelets. If the FourLane boxes collapsed (e.g. `build_internal_path`
    /// dropped every connector), the lanelet graph would be empty — this guards against that.
    #[test]
    fn load_test_city_builds_lanelet_graph_without_panic() {
        use transport::{
            GraphVersion, LaneGraph, LaneletConflictMatrices, LaneletGraph, build_lane_graph,
            build_lanelet_graph,
        };

        // Rebuild intersection clusters for the freshly generated grid (mirrors what
        // `detect_intersections` does at runtime; that system isn't re-exported from the crate root).
        fn rebuild_clusters(
            grid: Res<map::MapGrid>,
            gv: Res<GraphVersion>,
            mut index: ResMut<intersections::IntersectionIndex>,
        ) {
            let (clusters, tile_to_intersection) =
                intersections::build_intersection_clusters(&grid);
            index.clusters = clusters;
            index.tile_to_intersection = tile_to_intersection;
            index.version = gv.0;
        }

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
            .insert_resource(GraphVersion(1))
            .insert_resource(map::MapEditVersion::default())
            .insert_resource(command_history::CommandHistory::new(100))
            .insert_resource(intersections::IntersectionIndex::default())
            .insert_resource(LaneGraph::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default())
            .insert_resource(traffic::TrafficConfig::default())
            .insert_resource(TestCommandOnce::default())
            .add_systems(
                Update,
                (
                    send_load_test_city_once,
                    handle_load_test_city,
                    // Rebuild clusters for the freshly generated grid, then the lane + lanelet graphs.
                    rebuild_clusters,
                    build_lane_graph,
                    build_lanelet_graph,
                )
                    .chain(),
            );

        // If any FourLane box construction panics (oncoming routing, degenerate geometry), this
        // update unwinds the test.
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        assert!(
            !graph.lanelets.is_empty(),
            "the FourLane test city must produce lanelets (4x4/mixed boxes did not collapse)"
        );

        let matrices = app.world().resource::<LaneletConflictMatrices>();
        assert!(
            !matrices.by_intersection.is_empty(),
            "conflict matrices must be built for the FourLane intersections"
        );
    }
}
