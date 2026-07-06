use super::generation::generate_map_into_grid;
use super::*;
use crate::game::buildings::Building;
use crate::game::command_history::CommandHistory;
use crate::game::commands::{GameCommand, UndoRedoRequested};
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

#[test]
fn command_apply_marks_dirty_and_bumps_graph_version_on_road_change() {
    let mut app = App::new();
    app.add_message::<GameCommand>()
        .add_message::<UndoRedoRequested>()
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
        .add_message::<UndoRedoRequested>()
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

// ---------------------------------------------------------------------------
// Undo/redo + building placement/erase pins (audit 2026-07-06, map-zones B1-B6)
// ---------------------------------------------------------------------------

fn build_command_apply_app(width: i32, height: i32) -> App {
    let tile_count = (width as usize) * (height as usize);
    let mut app = App::new();
    app.add_message::<GameCommand>()
        .add_message::<UndoRedoRequested>()
        .add_message::<crate::game::sim_events::DayAdvanced>()
        .insert_resource(MapConfig {
            width,
            height,
            tile_size: 16.0,
        })
        .insert_resource(MapSeed(1))
        .insert_resource(MapGrid::new(width, height))
        .insert_resource(DirtyTiles::new(tile_count))
        .insert_resource(RoadDirtyTiles::new(tile_count))
        .insert_resource(City::default())
        .insert_resource(GraphVersion(1))
        .insert_resource(MapEditVersion::default())
        .insert_resource(CommandHistory::new(100))
        .insert_resource(IntersectionIndex::default())
        .add_systems(Update, apply_game_commands_to_grid);
    app
}

fn send_command(app: &mut App, cmd: GameCommand) {
    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<GameCommand>>()
        .write(cmd);
}

fn request_undo_redo(app: &mut App, redo: bool) {
    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<UndoRedoRequested>>()
        .write(UndoRedoRequested { redo });
}

fn road_cell(kind: RoadKind) -> RoadCell {
    RoadCell {
        kind,
        dir: RoadDir::East,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::Regular,
    }
}

fn road_kind_at(app: &App, pos: TilePos) -> RoadKind {
    app.world()
        .resource::<MapGrid>()
        .get(pos)
        .unwrap()
        .road
        .kind
}

fn building_entity_count(app: &mut App) -> usize {
    let world = app.world_mut();
    let mut q = world.query::<&Building>();
    q.iter(world).count()
}

/// B1 pin: undoing a road build must remove the road, and undoing an upgrade
/// must restore the previous kind. Pre-fix both were impossible: undo replayed
/// `GameCommand::SetRoad` with the old cell, which the apply handler rejects
/// for empty cells (`!road.is_some()`) and for downgrades (no-downgrade rule).
#[test]
fn undo_removes_built_road_and_restores_downgraded_kind() {
    let mut app = build_command_apply_app(8, 8);
    let pos = TilePos { x: 1, y: 1 };

    send_command(
        &mut app,
        GameCommand::SetRoad {
            pos,
            road: road_cell(RoadKind::TwoLane),
        },
    );
    app.update();
    assert_eq!(road_kind_at(&app, pos), RoadKind::TwoLane);

    request_undo_redo(&mut app, false);
    app.update();
    assert_eq!(
        road_kind_at(&app, pos),
        RoadKind::None,
        "undo of a road build must remove the road"
    );

    // Build again, upgrade, then undo the upgrade.
    send_command(
        &mut app,
        GameCommand::SetRoad {
            pos,
            road: road_cell(RoadKind::TwoLane),
        },
    );
    app.update();
    send_command(
        &mut app,
        GameCommand::SetRoad {
            pos,
            road: road_cell(RoadKind::FourLane),
        },
    );
    app.update();
    assert_eq!(road_kind_at(&app, pos), RoadKind::FourLane);

    request_undo_redo(&mut app, false);
    app.update();
    assert_eq!(
        road_kind_at(&app, pos),
        RoadKind::TwoLane,
        "undo of a road upgrade must restore the exact previous kind"
    );
}

/// B2 pin: undo/undo must walk history back to the pre-edit state (not toggle
/// the last edit), and the redo stack must survive undo. Pre-fix, undo replayed
/// history as ordinary GameCommands, which re-recorded them into the history
/// and cleared the redo stack on every Ctrl+Z.
#[test]
fn undo_undo_then_redo_redo_walks_history() {
    let mut app = build_command_apply_app(8, 8);
    let road_pos = TilePos { x: 1, y: 1 };
    let zone_pos = TilePos { x: 2, y: 1 };

    let pre_a = snapshot_cells(app.world().resource::<MapGrid>());

    // Edit A: build a road.
    send_command(
        &mut app,
        GameCommand::SetRoad {
            pos: road_pos,
            road: road_cell(RoadKind::TwoLane),
        },
    );
    app.update();
    let post_a = snapshot_cells(app.world().resource::<MapGrid>());
    assert_ne!(pre_a, post_a);

    // Edit B: zone next to the road.
    send_command(
        &mut app,
        GameCommand::SetZone {
            pos: zone_pos,
            zone: ZoneKind::Residential,
        },
    );
    app.update();
    let post_b = snapshot_cells(app.world().resource::<MapGrid>());
    assert_ne!(post_a, post_b);

    request_undo_redo(&mut app, false);
    app.update();
    assert_eq!(
        snapshot_cells(app.world().resource::<MapGrid>()),
        post_a,
        "first undo must revert edit B"
    );

    request_undo_redo(&mut app, false);
    app.update();
    assert_eq!(
        snapshot_cells(app.world().resource::<MapGrid>()),
        pre_a,
        "second undo must revert edit A (walk history, not toggle edit B)"
    );

    request_undo_redo(&mut app, true);
    app.update();
    assert_eq!(
        snapshot_cells(app.world().resource::<MapGrid>()),
        post_a,
        "redo must re-apply edit A (redo stack must survive undo)"
    );

    request_undo_redo(&mut app, true);
    app.update();
    assert_eq!(
        snapshot_cells(app.world().resource::<MapGrid>()),
        post_b,
        "second redo must re-apply edit B"
    );
}

/// B5 pin (positive): a 3x3 footprint adjacent to a road must place. Pre-fix
/// this was a guaranteed no-op: per-tile `can_zone_tile` required a road next
/// to EVERY footprint tile, unsatisfiable for the road-free interior.
#[test]
fn place_building_with_adjacent_road_spawns_entity_and_occupies_footprint() {
    let mut app = build_command_apply_app(16, 16);
    // Road row at y=1; the 3x3 footprint at (2..4, 2..4) touches it from below.
    for x in 2..5 {
        send_command(
            &mut app,
            GameCommand::SetRoad {
                pos: TilePos { x, y: 1 },
                road: road_cell(RoadKind::TwoLane),
            },
        );
    }
    app.update();

    let money_before = app.world().resource::<City>().money;
    send_command(
        &mut app,
        GameCommand::PlaceBuilding {
            pos: TilePos { x: 2, y: 2 },
            kind: BuildingKind::Hospital,
        },
    );
    app.update();

    let grid = app.world().resource::<MapGrid>();
    for dx in 0..3 {
        for dy in 0..3 {
            assert_eq!(
                grid.get(TilePos {
                    x: 2 + dx,
                    y: 2 + dy
                })
                .unwrap()
                .building,
                Some(BuildingKind::Hospital),
                "every footprint cell must be occupied"
            );
        }
    }
    assert_eq!(
        app.world().resource::<City>().money,
        money_before - BuildingKind::Hospital.build_cost()
    );
    assert_eq!(
        building_entity_count(&mut app),
        1,
        "PlaceBuilding must spawn the building entity"
    );
}

/// B5 pin (negative): without any road the footprint has no road access and
/// placement must be rejected without side effects.
#[test]
fn place_building_without_any_road_is_rejected() {
    let mut app = build_command_apply_app(16, 16);
    let money_before = app.world().resource::<City>().money;

    send_command(
        &mut app,
        GameCommand::PlaceBuilding {
            pos: TilePos { x: 5, y: 5 },
            kind: BuildingKind::Hospital,
        },
    );
    app.update();

    let grid = app.world().resource::<MapGrid>();
    assert_eq!(grid.get(TilePos { x: 5, y: 5 }).unwrap().building, None);
    assert_eq!(app.world().resource::<City>().money, money_before);
    assert_eq!(building_entity_count(&mut app), 0);
}

/// Undo of PlaceBuilding must clear the whole footprint, despawn the entity
/// and restore the zones the placement cleared.
#[test]
fn undo_place_building_clears_footprint_and_restores_zones() {
    let mut app = build_command_apply_app(16, 16);
    for x in 2..5 {
        send_command(
            &mut app,
            GameCommand::SetRoad {
                pos: TilePos { x, y: 1 },
                road: road_cell(RoadKind::TwoLane),
            },
        );
    }
    app.update();
    // Pre-existing zone inside the future footprint (adjacent to the road).
    send_command(
        &mut app,
        GameCommand::SetZone {
            pos: TilePos { x: 2, y: 2 },
            zone: ZoneKind::Residential,
        },
    );
    app.update();

    send_command(
        &mut app,
        GameCommand::PlaceBuilding {
            pos: TilePos { x: 2, y: 2 },
            kind: BuildingKind::Hospital,
        },
    );
    app.update();
    assert_eq!(building_entity_count(&mut app), 1);
    assert_eq!(
        app.world()
            .resource::<MapGrid>()
            .get(TilePos { x: 2, y: 2 })
            .unwrap()
            .zone,
        ZoneKind::None,
        "placement must clear the zone"
    );

    request_undo_redo(&mut app, false);
    app.update();

    let grid = app.world().resource::<MapGrid>();
    for dx in 0..3 {
        for dy in 0..3 {
            assert_eq!(
                grid.get(TilePos {
                    x: 2 + dx,
                    y: 2 + dy
                })
                .unwrap()
                .building,
                None,
                "undo must clear every footprint cell"
            );
        }
    }
    assert_eq!(
        grid.get(TilePos { x: 2, y: 2 }).unwrap().zone,
        ZoneKind::Residential,
        "undo must restore the zone cleared by placement"
    );
    assert_eq!(
        building_entity_count(&mut app),
        0,
        "undo must despawn the building entity"
    );
}

/// B6 pin: erasing ANY footprint cell (here a non-anchor one) must remove the
/// whole building + entity, and undo must bring all of it back. Pre-fix only
/// the erased cell was cleared: the remaining 8 cells stayed occupied forever
/// (phantom cells) and the entity survived in this schedule.
#[test]
fn erase_on_footprint_cell_removes_whole_building_and_undo_restores_it() {
    let mut app = build_command_apply_app(16, 16);
    for x in 2..5 {
        send_command(
            &mut app,
            GameCommand::SetRoad {
                pos: TilePos { x, y: 1 },
                road: road_cell(RoadKind::TwoLane),
            },
        );
    }
    app.update();
    send_command(
        &mut app,
        GameCommand::PlaceBuilding {
            pos: TilePos { x: 2, y: 2 },
            kind: BuildingKind::Hospital,
        },
    );
    app.update();
    assert_eq!(building_entity_count(&mut app), 1);

    // Erase a non-anchor footprint cell.
    send_command(
        &mut app,
        GameCommand::EraseTile {
            pos: TilePos { x: 4, y: 4 },
        },
    );
    app.update();

    {
        let grid = app.world().resource::<MapGrid>();
        for dx in 0..3 {
            for dy in 0..3 {
                assert_eq!(
                    grid.get(TilePos {
                        x: 2 + dx,
                        y: 2 + dy
                    })
                    .unwrap()
                    .building,
                    None,
                    "erasing one footprint cell must clear the WHOLE building"
                );
            }
        }
    }
    assert_eq!(
        building_entity_count(&mut app),
        0,
        "erasing a footprint cell must despawn the building entity"
    );

    // Undo restores the full footprint and the entity.
    request_undo_redo(&mut app, false);
    app.update();

    {
        let grid = app.world().resource::<MapGrid>();
        for dx in 0..3 {
            for dy in 0..3 {
                assert_eq!(
                    grid.get(TilePos {
                        x: 2 + dx,
                        y: 2 + dy
                    })
                    .unwrap()
                    .building,
                    Some(BuildingKind::Hospital),
                    "undo must restore every footprint cell"
                );
            }
        }
    }
    assert_eq!(
        building_entity_count(&mut app),
        1,
        "undo must respawn the building entity"
    );
}

/// Blocker pin (review): GenerateMap replaces the grid, so history entries
/// recorded against the OLD map must be dropped — exact-restore would stamp
/// stale cells into the new map validation-free (even roads onto water).
#[test]
fn generate_map_clears_command_history() {
    let mut app = build_command_apply_app(8, 8);
    let pos = TilePos { x: 1, y: 1 };

    send_command(
        &mut app,
        GameCommand::SetRoad {
            pos,
            road: road_cell(RoadKind::TwoLane),
        },
    );
    app.update();
    assert!(
        app.world().resource::<CommandHistory>().can_undo(),
        "road build must record history"
    );

    send_command(&mut app, GameCommand::GenerateMap { seed: 7 });
    app.update();
    let history = app.world().resource::<CommandHistory>();
    assert!(
        !history.can_undo() && !history.can_redo(),
        "GenerateMap must clear the command history"
    );
}

/// Phantom-cells pin (review): sim growth mutates cells WITHOUT history
/// entries; undoing a SetZone under a building that grew there afterwards must
/// whole-erase that building (cells + entity), not flip one zone cell and
/// leave the rest of the footprint as ownerless phantom building cells.
#[test]
fn undo_set_zone_under_grown_building_clears_whole_footprint() {
    let mut app = build_command_apply_app(8, 8);
    let anchor = TilePos { x: 2, y: 2 };

    // Zoning requires road adjacency — build the road first (history entry #1).
    send_command(
        &mut app,
        GameCommand::SetRoad {
            pos: TilePos { x: 1, y: 2 },
            road: road_cell(RoadKind::TwoLane),
        },
    );
    send_command(
        &mut app,
        GameCommand::SetZone {
            pos: anchor,
            zone: ZoneKind::Residential,
        },
    );
    app.update();
    assert_eq!(
        app.world().resource::<MapGrid>().get(anchor).unwrap().zone,
        ZoneKind::Residential,
        "test setup: SetZone must have been accepted"
    );

    // Simulate sim growth (no history entries): a 2x2 building over the zoned
    // anchor plus three neighbouring tiles.
    let footprint = [
        anchor,
        TilePos { x: 3, y: 2 },
        TilePos { x: 2, y: 3 },
        TilePos { x: 3, y: 3 },
    ];
    {
        let mut grid = app.world_mut().resource_mut::<MapGrid>();
        for tile in footprint {
            let mut cell = grid.get(tile).unwrap();
            cell.zone = ZoneKind::Residential;
            cell.building = Some(BuildingKind::Residential);
            grid.set(tile, cell);
        }
    }
    app.world_mut().spawn(Building {
        kind: BuildingKind::Residential,
        anchor_pos: anchor,
        footprint_width: 2,
        footprint_length: 2,
        level: 1,
        phase: crate::game::buildings::BuildingPhase::Operational,
        construction_start_day: 0,
        capacity_residents: 8,
        capacity_jobs: 0,
        occupancy_residents: 0,
        occupancy_jobs: 0,
        target_occupancy_residents: 0,
        target_occupancy_jobs: 0,
        parking_spots: Vec::new(),
    });

    request_undo_redo(&mut app, false);
    app.update();

    let grid = app.world().resource::<MapGrid>();
    for tile in footprint {
        assert_eq!(
            grid.get(tile).unwrap().building,
            None,
            "undo over a grown building must clear its WHOLE footprint, {tile:?} is a phantom"
        );
    }
    assert_eq!(
        building_entity_count(&mut app),
        0,
        "the grown building's entity must be despawned by the undo"
    );
}
