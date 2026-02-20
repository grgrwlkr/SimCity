use super::generation::generate_map_into_grid;
use super::*;
use crate::game::buildings::{Building, MAX_ZONE_DEPTH, is_within_zone_depth};
use crate::game::command_history::CommandHistory;
use crate::game::commands::GameCommand;
use crate::game::intersections::IntersectionIndex;
use crate::game::roads::{RoadCell, RoadDir, RoadKind};
use crate::game::sim::City;
use crate::game::traffic::TrafficOccupancy;
use crate::game::transport::{
    GraphVersion, PathCache, PathfindingConfig, PathfindingCtx, RoadGraph, find_road_path_cached,
    rebuild_road_graph_inner,
};
use bevy::app::App;
use bevy::ecs::message::MessageWriter;

fn snapshot_cells(grid: &MapGrid) -> Vec<MapCell> {
    grid.cells.clone()
}

#[test]
fn map_generation_is_deterministic_for_seed() {
    let mut a = MapGrid::new(32, 32);
    let mut b = MapGrid::new(32, 32);

    generate_map_into_grid(&mut a, 123);
    generate_map_into_grid(&mut b, 123);

    assert_eq!(snapshot_cells(&a), snapshot_cells(&b));
}

#[test]
fn road_path_smoke_test_on_simple_line() {
    let mut grid = MapGrid::new(5, 5);
    // Build a straight horizontal road from (0,2) to (4,2)
    for x in 0..5 {
        let pos = TilePos { x, y: 2 };
        let mut c = grid.get(pos).unwrap_or_default();
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos, c);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let cfg = PathfindingConfig::default();
    let mut cache = PathCache::default();
    let mut traffic = TrafficOccupancy::default();
    traffic.ensure_len(grid.len());
    let intersections = IntersectionIndex::default();

    let mut ctx = PathfindingCtx {
        time_now_sec: 0.0,
        cfg: &cfg,
        cache: &mut cache,
        graph: &graph,
        regions: None,
        traffic: &traffic,
        grid: &grid,
        intersections: &intersections,
        max_iterations: None,
    };

    let path = find_road_path_cached(&mut ctx, TilePos { x: 0, y: 2 }, TilePos { x: 4, y: 2 });
    assert!(!path.is_empty());
    assert_eq!(path.first().copied(), Some(TilePos { x: 0, y: 2 }));
    assert_eq!(path.last().copied(), Some(TilePos { x: 4, y: 2 }));
    // Minimal length for a straight line is 5 tiles.
    assert_eq!(path.len(), 5);
}

#[derive(Resource, Default)]
struct TestCommandOnce(bool);

fn send_road_command_once(mut out: MessageWriter<GameCommand>, mut sent: ResMut<TestCommandOnce>) {
    if sent.0 {
        return;
    }
    sent.0 = true;
    out.write(GameCommand::SetRoad {
        pos: TilePos { x: 1, y: 1 },
        road: RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        },
    });
}

fn send_road_on_water_once(mut out: MessageWriter<GameCommand>, mut sent: ResMut<TestCommandOnce>) {
    if sent.0 {
        return;
    }
    sent.0 = true;
    out.write(GameCommand::SetRoad {
        pos: TilePos { x: 2, y: 2 },
        road: RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        },
    });
}

fn send_load_test_city_once(
    mut out: MessageWriter<GameCommand>,
    mut sent: ResMut<TestCommandOnce>,
) {
    if sent.0 {
        return;
    }
    sent.0 = true;
    out.write(GameCommand::LoadTestCity);
}

#[test]
fn command_apply_marks_dirty_and_bumps_graph_version_on_road_change() {
    let mut app = App::new();
    app.add_message::<GameCommand>()
        .add_message::<crate::game::sim_events::DayAdvanced>()
        .insert_resource(MapConfig {
            width: 8,
            height: 8,
            tile_size: 16.0,
        })
        .insert_resource(MapSeed(1))
        .insert_resource(MapGrid::new(8, 8))
        .insert_resource(DirtyTiles::new(64))
        .insert_resource(RoadDirtyTiles::new(64))
        .insert_resource(City::default())
        .insert_resource(GraphVersion(1))
        .insert_resource(MapEditVersion::default())
        .insert_resource(CommandHistory::new(100))
        .insert_resource(IntersectionIndex::default())
        .insert_resource(TestCommandOnce::default())
        .add_systems(
            Update,
            (send_road_command_once, apply_game_commands_to_grid).chain(),
        );

    app.update();

    let grid = app.world().resource::<MapGrid>();
    assert_eq!(
        grid.get(TilePos { x: 1, y: 1 }).unwrap().road.kind,
        RoadKind::TwoLane,
    );

    let gv = app.world().resource::<GraphVersion>();
    assert_ne!(gv.0, 1, "GraphVersion should bump on road change");

    // DirtyTiles should contain the edited index.
    let idx = grid.idx(TilePos { x: 1, y: 1 }).unwrap();
    let dirty = app.world().resource::<DirtyTiles>();
    assert!(
        dirty.is_marked(idx),
        "Dirty flag must be set for edited tile"
    );
}

#[test]
fn water_tiles_are_not_buildable_by_commands() {
    let mut app = App::new();
    app.add_message::<GameCommand>()
        .add_message::<crate::game::sim_events::DayAdvanced>()
        .insert_resource(MapConfig {
            width: 8,
            height: 8,
            tile_size: 16.0,
        })
        .insert_resource(MapSeed(1))
        .insert_resource(MapGrid::new(8, 8))
        .insert_resource(DirtyTiles::new(64))
        .insert_resource(RoadDirtyTiles::new(64))
        .insert_resource(City::default())
        .insert_resource(GraphVersion(1))
        .insert_resource(MapEditVersion::default())
        .insert_resource(CommandHistory::new(100))
        .insert_resource(IntersectionIndex::default())
        .insert_resource(TestCommandOnce::default())
        .add_systems(
            Update,
            (send_road_on_water_once, apply_game_commands_to_grid).chain(),
        );

    // Mark (2,2) as water.
    {
        let mut grid = app.world_mut().resource_mut::<MapGrid>();
        let pos = TilePos { x: 2, y: 2 };
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = true;
        grid.set(pos, c);
    }

    let money_before = app.world().resource::<City>().money;
    app.update();
    let money_after = app.world().resource::<City>().money;
    assert_eq!(
        money_before, money_after,
        "Should not spend money on water tiles"
    );

    let grid = app.world().resource::<MapGrid>();
    assert_eq!(
        grid.get(TilePos { x: 2, y: 2 }).unwrap().road.kind,
        RoadKind::None,
    );

    let gv = app.world().resource::<GraphVersion>();
    assert_eq!(
        gv.0, 1,
        "GraphVersion should not bump when command is rejected"
    );
}

#[test]
fn load_test_city_keeps_zones_without_prebuilt_rci() {
    let cfg = MapConfig::default();
    let tile_count = (cfg.width as usize) * (cfg.height as usize);

    let mut app = App::new();
    app.add_message::<GameCommand>()
        .add_message::<crate::game::sim_events::DayAdvanced>()
        .insert_resource(cfg.clone())
        .insert_resource(MapSeed(1))
        .insert_resource(MapGrid::new(cfg.width, cfg.height))
        .insert_resource(DirtyTiles::new(tile_count))
        .insert_resource(RoadDirtyTiles::new(tile_count))
        .insert_resource(City::default())
        .insert_resource(GraphVersion(1))
        .insert_resource(MapEditVersion::default())
        .insert_resource(CommandHistory::new(100))
        .insert_resource(IntersectionIndex::default())
        .insert_resource(TestCommandOnce::default())
        .add_systems(
            Update,
            (send_load_test_city_once, apply_game_commands_to_grid).chain(),
        );

    app.update();

    let grid = app.world().resource::<MapGrid>();

    let residential_zone_count = grid
        .cells
        .iter()
        .filter(|cell| cell.zone == ZoneKind::Residential)
        .count();
    let commercial_zone_count = grid
        .cells
        .iter()
        .filter(|cell| cell.zone == ZoneKind::Commercial)
        .count();
    let industrial_zone_count = grid
        .cells
        .iter()
        .filter(|cell| cell.zone == ZoneKind::Industrial)
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
    // Exclude the highway commercial band, so this check targets the dedicated upper-right pass.
    for y in (highway_y + 8)..(cfg.height - 40) {
        for x in (arterial2_x + 5)..(cfg.width - 15) {
            let pos = TilePos { x, y };
            if matches!(
                grid.get(pos).map(|cell| cell.zone),
                Some(ZoneKind::Commercial)
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
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if !matches!(
                cell.zone,
                ZoneKind::Residential | ZoneKind::Commercial | ZoneKind::Industrial
            ) {
                continue;
            }
            if !is_within_zone_depth(pos, grid, MAX_ZONE_DEPTH) {
                dead_zone_tiles.push(pos);
            }
        }
    }
    assert!(
        dead_zone_tiles.is_empty(),
        "LoadTestCity should not create dead-zoned R/C/I tiles (MAX_ZONE_DEPTH={}): found {} out-of-depth tiles, examples: {:?}",
        MAX_ZONE_DEPTH,
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
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
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
        let mut query = world.query::<&Building>();
        query
            .iter(world)
            .filter(|building| {
                matches!(
                    building.kind,
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
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
        let mut query = world.query::<&Building>();
        query
            .iter(world)
            .filter(|b| {
                matches!(
                    b.kind,
                    BuildingKind::FireStation
                        | BuildingKind::PoliceStation
                        | BuildingKind::Hospital
                )
            })
            .count()
    };
    assert!(
        service_building_count > 0,
        "LoadTestCity should still spawn service buildings (FireStation, PoliceStation, Hospital)"
    );
}
