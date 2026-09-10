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
    crate::game::render_primitives::init_for_test(&mut app);
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
    crate::game::render_primitives::init_for_test(&mut app);
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
    crate::game::render_primitives::init_for_test(&mut app);
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

mod core_coords {
    use bevy::math::Vec2;
    use simcity_core::game::map::coords::{
        map_origin, tile_f_to_world, tile_to_world, world_to_tile,
    };
    use simcity_core::game::map::{MapConfig, TilePos};

    fn cfg() -> MapConfig {
        MapConfig {
            width: 8,
            height: 6,
            tile_size: 16.0,
        }
    }

    /// Every tile survives tile -> world -> tile with round-to-nearest picking semantics.
    #[test]
    fn roundtrip_all_tiles() {
        let cfg = cfg();
        for x in 0..cfg.width {
            for y in 0..cfg.height {
                let t = TilePos { x, y };
                assert_eq!(world_to_tile(&cfg, tile_to_world(&cfg, t)), Some(t));
            }
        }
    }

    /// Sub-tile offsets below half a tile snap back to the same tile (picking contract).
    #[test]
    fn roundtrip_survives_subtile_offsets() {
        let cfg = cfg();
        let t = TilePos { x: 3, y: 2 };
        for (dx, dy) in [(7.9, 0.0), (-7.9, 0.0), (0.0, 7.9), (-7.9, -7.9)] {
            let w = tile_to_world(&cfg, t) + Vec2::new(dx, dy);
            assert_eq!(world_to_tile(&cfg, w), Some(t), "offset ({dx},{dy})");
        }
    }

    #[test]
    fn outside_map_is_none() {
        let cfg = cfg();
        let beyond = tile_to_world(
            &cfg,
            TilePos {
                x: cfg.width - 1,
                y: cfg.height - 1,
            },
        ) + Vec2::splat(cfg.tile_size);
        assert_eq!(world_to_tile(&cfg, beyond), None);
        assert_eq!(world_to_tile(&cfg, Vec2::splat(-1e6)), None);
    }

    /// The map is centered on the world origin: opposite corners mirror each other.
    #[test]
    fn map_is_centered_on_origin() {
        let cfg = cfg();
        let a = tile_to_world(&cfg, TilePos { x: 0, y: 0 });
        let b = tile_to_world(
            &cfg,
            TilePos {
                x: cfg.width - 1,
                y: cfg.height - 1,
            },
        );
        assert!((a + b).length() < 1e-4);
        assert_eq!(map_origin(&cfg), a);
    }

    /// tile_f_to_world at integer coordinates equals tile_to_world (footprint-center contract).
    #[test]
    fn fractional_matches_integer_at_whole_tiles() {
        let cfg = cfg();
        let t = TilePos { x: 5, y: 1 };
        assert_eq!(tile_f_to_world(&cfg, 5.0, 1.0), tile_to_world(&cfg, t));
        // 2x2 footprint anchored at (2,2): center is halfway between tiles (2,2) and (3,3).
        let c = tile_f_to_world(&cfg, 2.5, 2.5);
        let expect = (tile_to_world(&cfg, TilePos { x: 2, y: 2 })
            + tile_to_world(&cfg, TilePos { x: 3, y: 3 }))
            / 2.0;
        assert!((c - expect).length() < 1e-4);
    }
}

mod core_coords_ray {
    use bevy::math::Vec3;
    use simcity_core::game::map::coords::ray_ground_t;

    #[test]
    fn straight_down_hits_at_camera_height() {
        assert_eq!(
            ray_ground_t(Vec3::new(3.0, 4.0, 10.0), Vec3::NEG_Z),
            Some(10.0)
        );
    }

    /// A 45-degree tilted ray from (0,-10,10) toward +Y/-Z lands exactly at the origin.
    #[test]
    fn tilted_ray_lands_on_expected_ground_point() {
        let origin = Vec3::new(0.0, -10.0, 10.0);
        let dir = Vec3::new(0.0, 1.0, -1.0).normalize();
        let t = ray_ground_t(origin, dir).expect("ray must hit the ground");
        let hit = origin + dir * t;
        assert!(hit.z.abs() < 1e-4);
        assert!(
            (hit.truncate() - bevy::math::Vec2::ZERO).length() < 1e-4,
            "{hit}"
        );
    }

    #[test]
    fn parallel_and_backward_rays_miss() {
        assert_eq!(ray_ground_t(Vec3::new(0.0, 0.0, 10.0), Vec3::X), None);
        assert_eq!(ray_ground_t(Vec3::new(0.0, 0.0, 10.0), Vec3::Z), None);
    }
}

/// Picking must survive the projection switch of phase 2. These call sites are
/// where `viewport_to_world_2d` used to return garbage without saying so, and a
/// perspective camera is exactly the case that would expose it.
mod core_coords_projection {
    use bevy::camera::RenderTargetInfo;
    use bevy::camera::{Camera, OrthographicProjection, PerspectiveProjection, Projection};
    use bevy::math::{UVec2, Vec2, Vec3};
    use bevy::transform::components::GlobalTransform;
    use simcity_core::game::map::coords::{tile_to_world, viewport_to_ground, world_to_tile};
    use simcity_core::game::map::{MapConfig, TilePos};

    const VIEWPORT: Vec2 = Vec2::new(1600.0, 1000.0);

    fn cfg() -> MapConfig {
        MapConfig {
            width: 128,
            height: 128,
            tile_size: 16.0,
        }
    }

    /// World origin sits on a tile corner, where rounding can go either way, so
    /// the camera aims at a tile centre instead.
    fn focus() -> Vec3 {
        tile_to_world(&cfg(), TilePos { x: 64, y: 64 }).extend(0.0)
    }

    /// The game's rig: a boom over the focus, looking back down at it.
    fn camera_at(distance: f32) -> GlobalTransform {
        let (yaw, pitch) = (-std::f32::consts::FRAC_PI_4, 0.96_f32);
        let offset = Vec3::new(
            yaw.cos() * pitch.cos(),
            yaw.sin() * pitch.cos(),
            pitch.sin(),
        ) * distance;
        GlobalTransform::from(
            bevy::transform::components::Transform::from_translation(focus() + offset)
                .looking_at(focus(), Vec3::Z),
        )
    }

    fn camera_with(projection: Projection) -> Camera {
        let mut camera = Camera::default();
        camera.computed.clip_from_view = projection.get_clip_from_view();
        camera.computed.target_info = Some(RenderTargetInfo {
            physical_size: UVec2::new(VIEWPORT.x as u32, VIEWPORT.y as u32),
            scale_factor: 1.0,
        });
        camera
    }

    fn orthographic(scale: f32) -> Projection {
        let mut ortho = OrthographicProjection::default_3d();
        ortho.scale = scale;
        let mut projection = Projection::Orthographic(ortho);
        projection.update(VIEWPORT.x, VIEWPORT.y);
        projection
    }

    /// Framed to show the same ground height as `orthographic(scale)` would.
    fn perspective(visible_height: f32, distance: f32) -> Projection {
        let mut projection = Projection::Perspective(PerspectiveProjection {
            fov: 2.0 * (visible_height / (2.0 * distance)).atan(),
            aspect_ratio: VIEWPORT.x / VIEWPORT.y,
            near: 0.1,
            far: distance * 4.0,
            ..Default::default()
        });
        projection.update(VIEWPORT.x, VIEWPORT.y);
        projection
    }

    /// Tile -> screen -> tile must be the identity, or picking lies.
    fn assert_round_trip(label: &str, camera: &Camera, transform: &GlobalTransform) {
        let cfg = cfg();
        for tile in [
            TilePos { x: 64, y: 64 },
            TilePos { x: 62, y: 66 },
            TilePos { x: 66, y: 62 },
            TilePos { x: 60, y: 60 },
        ] {
            let world = tile_to_world(&cfg, tile);
            let screen = camera
                .world_to_viewport(transform, world.extend(0.0))
                .unwrap_or_else(|e| panic!("{label}: tile {tile:?} is off screen: {e:?}"));
            let back = viewport_to_ground(camera, transform, screen)
                .unwrap_or_else(|| panic!("{label}: no ground under {screen:?}"));
            assert_eq!(
                world_to_tile(&cfg, back),
                Some(tile),
                "{label}: {tile:?} came back as {:?} (world {world:?} -> {back:?})",
                world_to_tile(&cfg, back)
            );
        }
    }

    #[test]
    fn picking_round_trips_in_both_projections() {
        let scale = 0.2;
        let visible_height = VIEWPORT.y * scale;
        let ortho_distance = 900.0;
        let perspective_distance = 300.0;

        assert_round_trip(
            "orthographic",
            &camera_with(orthographic(scale)),
            &camera_at(ortho_distance),
        );
        assert_round_trip(
            "perspective",
            &camera_with(perspective(visible_height, perspective_distance)),
            &camera_at(perspective_distance),
        );
    }

    #[test]
    fn the_frame_centre_picks_the_same_tile_in_both_projections() {
        let scale = 0.2;
        let visible_height = VIEWPORT.y * scale;
        let centre = VIEWPORT * 0.5;

        let ortho_transform = camera_at(900.0);
        let ortho_tile =
            viewport_to_ground(&camera_with(orthographic(scale)), &ortho_transform, centre)
                .and_then(|w| world_to_tile(&cfg(), w));

        let perspective_transform = camera_at(300.0);
        let perspective_tile = viewport_to_ground(
            &camera_with(perspective(visible_height, 300.0)),
            &perspective_transform,
            centre,
        )
        .and_then(|w| world_to_tile(&cfg(), w));

        assert!(ortho_tile.is_some(), "orthographic centre found no ground");
        assert_eq!(
            ortho_tile, perspective_tile,
            "the two projections look at the same focus, so the centre pixel is the same tile"
        );
        assert_eq!(
            ortho_tile,
            Some(TilePos { x: 64, y: 64 }),
            "and that tile is the one the camera is aimed at"
        );
    }
}

/// `simcity_core` holds no tests of its own (see CLAUDE.md), so its types are
/// pinned from here like the coords ones above.
mod core_overlay_names {
    use simcity_core::game::ui_state::OverlayMode;

    #[test]
    fn every_overlay_the_toolbar_offers_can_be_named() {
        for (name, mode) in [
            ("None", OverlayMode::None),
            ("Water", OverlayMode::Water),
            ("Height", OverlayMode::Height),
            ("Zones", OverlayMode::Zones),
            ("Roads", OverlayMode::Roads),
            ("Traffic", OverlayMode::Traffic),
            ("Path", OverlayMode::Path),
            ("Service", OverlayMode::ServiceCoverage),
            ("Land Value", OverlayMode::LandValue),
            ("Pollution", OverlayMode::Pollution),
        ] {
            assert_eq!(OverlayMode::from_name(name), Some(mode), "{name}");
        }
    }

    #[test]
    fn names_are_forgiving_about_case_and_spacing_but_not_about_nonsense() {
        assert_eq!(
            OverlayMode::from_name("  land_value "),
            Some(OverlayMode::LandValue)
        );
        assert_eq!(
            OverlayMode::from_name("SERVICECOVERAGE"),
            Some(OverlayMode::ServiceCoverage)
        );
        assert_eq!(OverlayMode::from_name("smog"), None);
        assert_eq!(OverlayMode::from_name(""), None);
    }
}

/// `SimSpeed` is named from scripts for the same reason overlays are: a
/// daylight screenshot needs the clock stopped, and entering `AppState::Paused`
/// runs the end-of-game path, which resets the day and hour — so every frame
/// frozen that way is night. Stopping virtual time instead keeps the hour.
mod core_sim_speed_names {
    use simcity_core::game::ui_state::SimSpeed;

    #[test]
    fn every_speed_the_toolbar_offers_can_be_named() {
        for (name, speed) in [
            ("Paused", SimSpeed::Paused),
            ("x1", SimSpeed::X1),
            ("x2", SimSpeed::X2),
            ("x3", SimSpeed::X3),
        ] {
            assert_eq!(SimSpeed::from_name(name), Some(speed), "{name}");
        }
    }

    #[test]
    fn names_are_forgiving_about_case_and_spacing_but_not_about_nonsense() {
        assert_eq!(SimSpeed::from_name("  PAUSE "), Some(SimSpeed::Paused));
        assert_eq!(SimSpeed::from_name("1"), Some(SimSpeed::X1));
        assert_eq!(SimSpeed::from_name("fast"), None);
        assert_eq!(SimSpeed::from_name(""), None);
    }
}

/// Where street furniture lands. Placement is a pure function of the grid and
/// the map seed, like the trees before it: props are spawned once per map, so a
/// roll that drifted between runs would be a save-load difference nobody sees
/// until the city reloads wrong.
mod props_placement {
    use bevy::prelude::IVec2;

    use crate::game::map::props::{
        kerb_side, kerbside_side, prop_roll, road_side, wants_streetlight,
    };
    use crate::game::map::{MapGrid, TileKind, TilePos};
    use crate::game::roads::{RoadCell, RoadKind};
    use simcity_core::game::props_config::StreetlightConfig;

    fn road_row(len: i32) -> MapGrid {
        let mut grid = MapGrid::new(len + 4, 5);
        for x in 0..len {
            let pos = TilePos { x, y: 2 };
            let mut cell = grid.get(pos).unwrap_or_default();
            cell.terrain = TileKind::Road;
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                ..RoadCell::none()
            };
            grid.set(pos, cell);
        }
        grid
    }

    #[test]
    fn a_lamp_stands_on_the_kerb_and_never_mid_carriageway() {
        let grid = road_row(12);
        // The road runs along y = 2, so every road tile has a non-road
        // neighbour above and below: that is a kerb.
        assert!(kerb_side(TilePos { x: 4, y: 2 }, &grid).is_some());
        // A tile off the road is not a lamp site at all.
        assert!(kerb_side(TilePos { x: 4, y: 0 }, &grid).is_none());
    }

    #[test]
    fn lamps_keep_the_configured_spacing() {
        let grid = road_row(16);
        let cfg = StreetlightConfig {
            spacing_tiles: 4,
            ..StreetlightConfig::default()
        };
        let lit: Vec<i32> = (0..16)
            .filter(|&x| wants_streetlight(TilePos { x, y: 2 }, &grid, &cfg))
            .collect();
        assert!(
            lit.len() >= 3,
            "a 16-tile street should carry lamps: {lit:?}"
        );
        for pair in lit.windows(2) {
            assert_eq!(
                pair[1] - pair[0],
                4,
                "lamps must sit exactly spacing_tiles apart: {lit:?}"
            );
        }
    }

    #[test]
    fn switching_lamps_off_in_the_config_leaves_the_street_bare() {
        let grid = road_row(16);
        let cfg = StreetlightConfig {
            enabled: false,
            ..StreetlightConfig::default()
        };
        assert!(
            (0..16).all(|x| !wants_streetlight(TilePos { x, y: 2 }, &grid, &cfg)),
            "a disabled knob must actually disable"
        );
    }

    /// Shop furniture needs a shop, and "is there a building here" cannot be
    /// read off the grid: `MapCell::building` is written for service buildings
    /// and hand-placed ones only, while R/C/I grown by the simulation leaves it
    /// `None`. Trusting it found 15 tiles in a whole city and put signs nowhere.
    #[test]
    fn shop_furniture_needs_a_shop_and_takes_that_from_the_caller() {
        let grid = road_row(8);
        let lot = TilePos { x: 3, y: 3 };
        // The tile faces the road either way — that part is geometry.
        assert_eq!(road_side(lot, &grid), Some(IVec2::new(0, -1)));
        // Whether a shop stands on it is the caller's to say.
        assert!(
            kerbside_side(lot, &grid, false).is_none(),
            "no shop, no sign"
        );
        assert_eq!(
            kerbside_side(lot, &grid, true),
            Some(IVec2::new(0, -1)),
            "with a shop, the furniture faces the road"
        );
    }

    /// Parked cars come from a fixed palette, not from a free hash.
    ///
    /// The first version keyed the car mesh on a continuous tint and blew the
    /// distinct-mesh count from 44 to 139 — the phase-7 "material per colour"
    /// lesson, wearing a mesh instead of a material.
    #[test]
    fn parked_cars_draw_from_a_small_fixed_palette() {
        use crate::game::map::props::{PARKED_CAR_TINTS, parked_car_tint};

        assert!(
            PARKED_CAR_TINTS.len() <= 4,
            "a bigger palette is a bigger batch count"
        );
        let mut seen = std::collections::HashSet::new();
        for i in 0..400 {
            let pos = TilePos {
                x: i % 20,
                y: i / 20,
            };
            let tint = parked_car_tint(pos, 42);
            assert!(
                PARKED_CAR_TINTS.contains(&tint),
                "{tint:?} is not in the palette"
            );
            seen.insert(tint.map(f32::to_bits));
        }
        assert!(seen.len() > 1, "one colour for every car is not a palette");
    }

    #[test]
    fn a_roll_is_stable_for_a_tile_and_spread_across_the_map() {
        let pos = TilePos { x: 7, y: 9 };
        let first = prop_roll(pos, 42, 1, 50);
        assert_eq!(first, prop_roll(pos, 42, 1, 50), "same tile, same answer");
        // Different salts are different props on the same tile; they must not
        // all land together.
        let bins = (0..400).filter(|i| {
            let p = TilePos {
                x: i % 20,
                y: i / 20,
            };
            prop_roll(p, 42, 1, 25)
        });
        let hits = bins.count();
        assert!(
            (60..=140).contains(&hits),
            "25% of 400 tiles should be roughly 100, got {hits}"
        );
        assert!(
            (0..400).all(|i| !prop_roll(
                TilePos {
                    x: i % 20,
                    y: i / 20
                },
                42,
                1,
                0
            )),
            "a zero chance must place nothing"
        );
    }
}

// ---------------------------------------------------------------------------
// Ф0: keyboard hotkeys stand down while a UI widget owns the keyboard.
//
// Before `InputFocus` existed, only the POINTER was guarded: typing into any text field
// also drove the game, so entering a map seed switched tools under the player's hands.
// These pin the keyboard half at the consumer, which is what the player feels.
// ---------------------------------------------------------------------------

use crate::game::ui_state::{InputFocus, ToolMode, UiState};

/// Drive one hotkey system over a world with the given focus and key held down.
fn run_build_hotkeys(captured: bool, key: KeyCode) -> UiState {
    let mut app = App::new();
    app.init_resource::<UiState>();
    app.insert_resource(InputFocus {
        keyboard_captured: captured,
    });

    let mut keys = ButtonInput::<KeyCode>::default();
    keys.press(key);
    app.insert_resource(keys);

    app.add_systems(Update, super::input::build_mode_hotkeys);
    app.update();

    app.world().resource::<UiState>().clone()
}

#[test]
fn build_mode_hotkey_switches_tool_when_keyboard_is_free() {
    let ui = run_build_hotkeys(false, KeyCode::Digit2);
    assert_eq!(
        ui.tool,
        ToolMode::Residential,
        "with no widget focused, a digit must still pick its tool"
    );
}

#[test]
fn build_mode_hotkey_is_ignored_while_keyboard_is_captured() {
    let before = UiState::default();
    let ui = run_build_hotkeys(true, KeyCode::Digit2);
    assert_eq!(
        ui.tool, before.tool,
        "typing into a text field must not switch the active tool"
    );
}

#[test]
fn one_way_hotkey_toggles_the_mode() {
    let ui = run_build_hotkeys(false, KeyCode::KeyO);
    assert!(
        ui.one_way_mode,
        "one-way had full support downstream but no way to reach it from input"
    );
}

#[test]
fn one_way_hotkey_is_ignored_while_keyboard_is_captured() {
    let ui = run_build_hotkeys(true, KeyCode::KeyO);
    assert!(
        !ui.one_way_mode,
        "typing the letter O into a field must not flip road direction"
    );
}

#[test]
fn undo_hotkey_is_ignored_while_keyboard_is_captured() {
    let mut app = App::new();
    app.add_message::<UndoRedoRequested>();
    app.insert_resource(InputFocus {
        keyboard_captured: true,
    });

    let mut keys = ButtonInput::<KeyCode>::default();
    keys.press(KeyCode::ControlLeft);
    keys.press(KeyCode::KeyZ);
    app.insert_resource(keys);

    app.add_systems(Update, super::input::handle_undo_redo);
    app.update();

    let messages = app.world().resource::<Messages<UndoRedoRequested>>();
    assert_eq!(
        messages.len(),
        0,
        "Ctrl+Z inside a text field belongs to the field, not to the map history"
    );
}

// ---------------------------------------------------------------------------
// A2: the road tool driven by tiles issues exactly what two clicks issue.
//
// In-game automation has no pointer, so it drives the road tool through tile coordinates.
// These pin that a one-way stroke really produces one-way lanes, the property a player
// relies on when the O key is on, without anything having to move a real cursor.
// ---------------------------------------------------------------------------

#[test]
fn road_segment_one_way_stroke_makes_every_lane_flow_one_way() {
    let start = TilePos { x: 10, y: 20 };
    let end = TilePos { x: 14, y: 20 };
    let tiles = super::input::compute_road_line(start, end);
    let commands = road_segment_commands(start, end, RoadKind::FourLane, true, true);

    assert_eq!(
        commands.len(),
        tiles.len() * usize::from(RoadKind::FourLane.lanes()),
        "one SetRoad per lane per tile, exactly as the cursor path writes them"
    );
    for command in &commands {
        let GameCommand::SetRoad { road, .. } = command else {
            panic!("the road tool issued a non-road command: {command:?}");
        };
        assert_eq!(
            road.flow,
            crate::game::roads::RoadFlow::OneWay(RoadDir::East),
            "a one-way stroke drawn west to east must make every lane flow East"
        );
        assert_eq!(road.kind, RoadKind::FourLane);
    }
}

#[test]
fn road_segment_two_way_stroke_keeps_lanes_two_way() {
    let start = TilePos { x: 10, y: 20 };
    let end = TilePos { x: 14, y: 20 };
    let commands = road_segment_commands(start, end, RoadKind::TwoLane, true, false);

    assert!(
        !commands.is_empty(),
        "a five-tile stroke must produce road commands"
    );
    for command in &commands {
        let GameCommand::SetRoad { road, .. } = command else {
            panic!("the road tool issued a non-road command: {command:?}");
        };
        assert_eq!(
            road.flow,
            crate::game::roads::RoadFlow::TwoWay,
            "with one-way off, no lane of the stroke may come out one-way"
        );
    }
}

// ---------------------------------------------------------------------------
// A2 root cause: a one-way road has no oncoming carriageway.
//
// The builder used to lay a one-way segment with the two-way layout — half the lanes pointing
// back against the flow. The route graph reads `flow` and treats those lanes as nonexistent,
// while route validation and the wrong-way audit read `dir` and treat them as legal road in the
// other direction. So a westbound route planned before a road was made one-way East survived
// the edit, vehicles standing on the back half stranded with no edges, and no audit saw a car
// driving against the flow. Found live: a car drove 28 tiles west on a "one-way East" block.
// ---------------------------------------------------------------------------

#[test]
fn road_segment_one_way_stroke_points_every_lane_the_one_way_direction() {
    let start = TilePos { x: 10, y: 20 };
    let end = TilePos { x: 14, y: 20 };
    for kind in [RoadKind::TwoLane, RoadKind::FourLane, RoadKind::SixLane] {
        for drive_on_right in [true, false] {
            for command in road_segment_commands(start, end, kind, drive_on_right, true) {
                let GameCommand::SetRoad { road, .. } = command else {
                    panic!("the road tool issued a non-road command: {command:?}");
                };
                assert_eq!(
                    road.dir,
                    RoadDir::East,
                    "{kind:?}, drive_on_right={drive_on_right}: lane {} of a one-way East \
                     stroke points {:?} — a one-way road must not carry an oncoming lane",
                    road.lane,
                    road.dir
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// A2 follow-up: a one-way stroke laid across an existing intersection.
//
// `SetRoad` keeps a box tile a box (`dir: None`) and still overwrites the rest of the cell, so
// the box tiles take the stroke's `flow`. Measured once as a probe, then pinned: no consumer
// reads `flow` on a dir-None tile, the crossing road's movement through the box is untouched,
// and the box's own horizontal movement turns to follow the one-way direction. Written after
// the behaviour was already correct, so it has no red run; it guards against a later change
// that starts reading `flow` on box tiles.
// ---------------------------------------------------------------------------

#[test]
fn one_way_stroke_across_an_intersection_keeps_the_crossing_drivable() {
    let mut app = build_command_apply_app(24, 24);
    for command in road_segment_commands(
        TilePos { x: 12, y: 2 },
        TilePos { x: 12, y: 21 },
        RoadKind::FourLane,
        true,
        false,
    ) {
        send_command(&mut app, command);
    }
    app.update();
    for command in road_segment_commands(
        TilePos { x: 2, y: 12 },
        TilePos { x: 21, y: 12 },
        RoadKind::FourLane,
        true,
        false,
    ) {
        send_command(&mut app, command);
    }
    app.update();

    let box_tiles: Vec<TilePos> = {
        let grid = app.world().resource::<MapGrid>();
        (0..24)
            .flat_map(|y| (0..24).map(move |x| TilePos { x, y }))
            .filter(|t| {
                grid.get(*t)
                    .is_some_and(|c| c.road.is_some() && c.road.dir == RoadDir::None)
            })
            .collect()
    };
    assert!(
        !box_tiles.is_empty(),
        "the crossing must form an intersection box"
    );

    let edges_of = |grid: &MapGrid| -> Vec<u8> {
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(grid, &GraphVersion(1), &mut graph);
        box_tiles
            .iter()
            .map(|t| graph.edges[grid.idx(*t).expect("box tile on map")])
            .collect()
    };
    let edges_before = edges_of(app.world().resource::<MapGrid>());

    for command in road_segment_commands(
        TilePos { x: 2, y: 12 },
        TilePos { x: 21, y: 12 },
        RoadKind::FourLane,
        true,
        true,
    ) {
        send_command(&mut app, command);
    }
    app.update();

    let grid = app.world().resource::<MapGrid>();
    assert!(
        box_tiles
            .iter()
            .all(|t| grid.get(*t).is_some_and(|c| c.road.dir == RoadDir::None)),
        "a one-way stroke across a crossing must leave the crossing a box"
    );
    let edges_after = edges_of(grid);
    for ((tile, before), after) in box_tiles.iter().zip(&edges_before).zip(&edges_after) {
        // Bits 2 and 3 are the vertical moves, 0 and 1 the horizontal ones (West, East).
        assert_eq!(
            before & 0b1100,
            after & 0b1100,
            "box tile {tile:?}: the crossing road's movement through the box changed \
             ({before:#06b} -> {after:#06b})"
        );
        assert_eq!(
            after & 0b0011,
            0b0010,
            "box tile {tile:?}: inside a one-way East box every horizontal move must be East \
             ({after:#06b})"
        );
    }
}

// ---------------------------------------------------------------------------
// Pointer override: automation hovers a tile without a pointer.
//
// The live debug API drives the game from inside it and must never move the real cursor, so
// the hovered tile has to be settable without one. A player's build never sets the override.
// ---------------------------------------------------------------------------

#[test]
fn hovered_tile_follows_the_pointer_override_without_a_window() {
    let mut app = App::new();
    app.insert_resource(MapConfig {
        width: 8,
        height: 8,
        tile_size: 16.0,
    });
    app.init_resource::<HoveredTile>();
    app.insert_resource(crate::game::ui_state::PointerOverride {
        tile: Some(TilePos { x: 3, y: 4 }),
    });
    app.add_systems(Update, super::input::update_hovered_tile);
    app.update();
    assert_eq!(
        app.world().resource::<HoveredTile>().tile,
        Some(TilePos { x: 3, y: 4 }),
        "with the override set, the hovered tile is the override even with no window at all"
    );
}

#[test]
fn hovered_tile_ignores_an_empty_pointer_override() {
    let mut app = App::new();
    app.insert_resource(MapConfig {
        width: 8,
        height: 8,
        tile_size: 16.0,
    });
    app.insert_resource(HoveredTile {
        tile: Some(TilePos { x: 1, y: 1 }),
    });
    app.init_resource::<crate::game::ui_state::PointerOverride>();
    app.add_systems(Update, super::input::update_hovered_tile);
    app.update();
    assert_eq!(
        app.world().resource::<HoveredTile>().tile,
        None,
        "an empty override changes nothing: with no window there is no hovered tile"
    );
}
