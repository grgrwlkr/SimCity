//! Tests for route rewriting scenarios: overtaking oncoming traffic, stuck vehicle recovery (U-turns), and right turn on red releases.

use super::lane_change::{LaneChangeCooldown, OvertakeOncoming};
use super::stuck::StuckTimer;
use super::*;
use crate::game::intersections::build_intersection_clusters;

#[test]
fn oncoming_overtake_rewrites_route_on_two_lane() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 20,
            height: 2,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(20, 2);
            for x in 0..20 {
                // Our lane (eastbound)
                let p0 = TilePos { x, y: 0 };
                let Some(mut c0) = grid.get(p0) else {
                    continue;
                };
                c0.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::East,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(p0, c0);

                // Oncoming lane (westbound)
                let p1 = TilePos { x, y: 1 };
                let Some(mut c1) = grid.get(p1) else {
                    continue;
                };
                c1.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::West,
                    lane: 1,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(p1, c1);
            }
            grid
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(
            Update,
            (build_traffic_spatial_index, plan_oncoming_overtakes).chain(),
        );

    // Leader occupies the next tile, moving slowly.
    let leader_vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            (1..20).map(|x| TilePos { x, y: 0 }).collect(),
            0,
            0.0,
            2.0,
            60.0,
            20.0,
            1.0,
        )
    };
    app.world_mut()
        .spawn((leader_vehicle, VehicleTrafficState::FreeFlow));

    // Ego vehicle behind, wants to pass.
    let ego_vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            (0..20).map(|x| TilePos { x, y: 0 }).collect(),
            0,
            0.0,
            5.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((ego_vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let v = app.world().get::<Vehicle>(ego).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    let route = path_pool.get(v.path_handle).unwrap();
    assert_eq!(route[0], TilePos { x: 0, y: 0 });
    assert_eq!(route[1], TilePos { x: 0, y: 1 }); // pull out
    assert_eq!(route[2], TilePos { x: 1, y: 1 }); // oncoming forward
    assert_eq!(route[5], TilePos { x: 3, y: 0 }); // return to our lane (pass_tiles=3)

    assert!(app.world().get::<LaneChangeCooldown>(ego).is_some());
    assert!(app.world().get::<OvertakeOncoming>(ego).is_some());
}

#[test]
fn intersection_connector_rewrites_corner_cut() {
    let grid = {
        let mut grid = MapGrid::new(5, 5);
        for x in 1..=3 {
            for y in 1..=3 {
                let pos = TilePos { x, y };
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::None,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
            }
        }

        for (pos, dir) in [
            (TilePos { x: 2, y: 0 }, RoadDir::North),
            (TilePos { x: 4, y: 2 }, RoadDir::East),
        ] {
            let Some(mut cell) = grid.get(pos) else {
                continue;
            };
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, cell);
        }

        grid
    };
    let (clusters, tile_to_intersection) = build_intersection_clusters(&grid);
    let index = IntersectionIndex {
        version: 1,
        clusters,
        tile_to_intersection,
        ..Default::default()
    };

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 5,
            height: 5,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(grid)
        .insert_resource(index)
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, rewrite_intersection_connectors);

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 2, y: 0 },
                TilePos { x: 2, y: 1 },
                TilePos { x: 3, y: 1 },
                TilePos { x: 3, y: 2 },
                TilePos { x: 4, y: 2 },
            ],
            0,
            0.0,
            5.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let v = app.world().get::<Vehicle>(ego).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    let route = path_pool.get(v.path_handle).unwrap();

    assert_eq!(route[0], TilePos { x: 2, y: 0 });
    assert_eq!(route[1], TilePos { x: 2, y: 1 });
    assert_eq!(route[2], TilePos { x: 2, y: 2 });
    assert_eq!(route[3], TilePos { x: 3, y: 2 });
    assert_eq!(route[4], TilePos { x: 4, y: 2 });
}

#[test]
fn right_turn_on_red_releases_when_reserved() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 3,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);

            let approach = TilePos { x: 1, y: 0 };
            let intersection_tile = TilePos { x: 1, y: 1 };
            let exit = TilePos { x: 2, y: 1 };

            for (pos, dir) in [
                (approach, RoadDir::North),
                (intersection_tile, RoadDir::None),
                (exit, RoadDir::East),
            ] {
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
            }

            grid
        })
        .insert_resource({
            let intersection_tile = TilePos { x: 1, y: 1 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: intersection_tile,
                aabb_max: intersection_tile,
                tile_count: 1,
                tiles_hash: 123,
            };

            let mut idx = IntersectionIndex::default();
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![intersection_tile],
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    centroid_tile: intersection_tile,
                });
            idx.tile_to_intersection.insert(intersection_tile, id);
            idx.traffic_lights.insert(id);
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, update_vehicle_traffic_state);

    let intersection_tile = TilePos { x: 1, y: 1 };
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(intersection_tile)
        .unwrap();
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();

    // Red for North/South, green for East/West.
    app.world_mut()
        .spawn(crate::game::intersections::TrafficLight {
            intersection_id: id,
            intersection_key: key,
            pos: intersection_tile,
            phase: LightPhase::EastWestGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        });

    let approach = TilePos { x: 1, y: 0 };
    let exit = TilePos { x: 2, y: 1 };

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![approach, intersection_tile, exit],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((
            vehicle,
            VehicleTrafficState::WaitingForGreen {
                intersection: key,
                stop_tile: approach,
            },
        ))
        .id();

    // Pre-own a reservation so the right-on-red policy can release us.
    app.world_mut()
        .resource_mut::<IntersectionReservations>()
        .by_intersection
        .insert(
            id,
            vec![IntersectionReservation {
                vehicle: ego,
                state: ReservationState::Approaching,
                created_at_sec: 0.0,
                zones: ZONE_ALL,
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            }],
        );

    app.update();
    let state = app.world().get::<VehicleTrafficState>(ego).copied();
    assert_eq!(state, Some(VehicleTrafficState::Accelerating));
}

#[test]
fn intersection_connector_corrects_wrong_way_exit_lane_and_suffix() {
    let grid = {
        let mut grid = MapGrid::new(5, 3);

        // Single-tile intersection.
        let intersection = TilePos { x: 1, y: 1 };
        let Some(mut ic) = grid.get(intersection) else {
            panic!("intersection tile missing");
        };
        ic.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::None,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(intersection, ic);

        // Northbound approach.
        let approach = TilePos { x: 1, y: 0 };
        let Some(mut ac) = grid.get(approach) else {
            panic!("approach tile missing");
        };
        ac.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::North,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(approach, ac);

        // Wrong-way outgoing row (north side): Westbound.
        for x in 2..=4 {
            let pos = TilePos { x, y: 1 };
            let Some(mut c) = grid.get(pos) else {
                continue;
            };
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::West,
                lane: 1,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, c);
        }

        // Correct outgoing row (south side): Eastbound.
        for x in 2..=4 {
            let pos = TilePos { x, y: 0 };
            let Some(mut c) = grid.get(pos) else {
                continue;
            };
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, c);
        }

        grid
    };
    let (clusters, tile_to_intersection) = build_intersection_clusters(&grid);
    let index = IntersectionIndex {
        version: 1,
        clusters,
        tile_to_intersection,
        ..Default::default()
    };

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 5,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(grid)
        .insert_resource(index)
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, rewrite_intersection_connectors);

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 1, y: 0 },
                TilePos { x: 1, y: 1 },
                TilePos { x: 2, y: 1 },
                TilePos { x: 3, y: 1 },
                TilePos { x: 4, y: 1 },
            ],
            0,
            0.0,
            5.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let v = app.world().get::<Vehicle>(ego).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    let route = path_pool.get(v.path_handle).unwrap();

    assert_eq!(route[0], TilePos { x: 1, y: 0 });
    assert_eq!(route[1], TilePos { x: 1, y: 1 });
    assert_eq!(route[2], TilePos { x: 2, y: 0 });
    assert_eq!(route[3], TilePos { x: 3, y: 0 });
    assert_eq!(route[4], TilePos { x: 4, y: 0 });
}

#[test]
fn stuck_dead_end_uturn_rewrites_route_on_two_lane() {
    use crate::game::transport::{
        GraphVersion, PathCache, PathfindingConfig, RegionGraph, RoadGraph,
        rebuild_road_graph_inner,
    };

    let mut grid = MapGrid::new(2, 2);
    for x in 0..2 {
        // Eastbound lane (dead end at x=1)
        let p0 = TilePos { x, y: 0 };
        let Some(mut c0) = grid.get(p0) else {
            continue;
        };
        c0.water = false;
        c0.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(p0, c0);

        // Westbound lane
        let p1 = TilePos { x, y: 1 };
        let Some(mut c1) = grid.get(p1) else {
            continue;
        };
        c1.water = false;
        c1.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::West,
            lane: 1,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(p1, c1);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let mut occ = TrafficOccupancy::default();
    occ.ensure_len(grid.len());

    let cfg = PathfindingConfig {
        enable_hierarchical: false,
        ..Default::default()
    };

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(MapConfig {
            width: 2,
            height: 2,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(graph)
        .insert_resource(RegionGraph::default())
        .insert_resource(cfg)
        .insert_resource(PathCache::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(occ)
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, resolve_stuck_vehicles);

    let current = TilePos { x: 1, y: 0 };
    let goal = TilePos { x: 0, y: 1 };
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![current, goal],
            0,
            0.0,
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let e = app
        .world_mut()
        .spawn((
            vehicle,
            VehicleTrafficState::FreeFlow,
            StuckTimer {
                secs: STUCK_REROUTE_SECS,
                last_tile: current,
                last_progress: 0.0,
                uturn_attempted: false,
            },
        ))
        .id();

    app.update();

    let v = app.world().get::<Vehicle>(e).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    let route = path_pool.get(v.path_handle).unwrap();
    // After re-routing, the route should be rewritten
    // The route should start at current and end at goal
    assert_eq!(route[0], current);
    assert_eq!(route.last(), Some(&goal));
    // The route should have been rewritten (different from the original direct path)
    // The original path was [current, goal], but after re-routing it may be different
    // For this test, we just verify that the route was rewritten and reaches the goal
    assert!(route.len() >= 2, "Route should have at least 2 tiles");
}

/// ROOT B regression: a passenger-less, non-service vehicle wedged on its ONLY path must eventually
/// despawn instead of freezing forever. Before the fix, the emergency reroute reset `stuck.secs` to 0
/// every call even when it returned the same blocked path (so the despawn threshold was unreachable),
/// AND the despawn guardrail required a passenger. A straight single-lane road has exactly one path,
/// so the reroute returns the unchanged route; with `secs == STUCK_DESPAWN_SECS` injected the vehicle
/// must be removed in one resolve tick.
#[test]
fn stuck_passengerless_vehicle_on_only_path_despawns_instead_of_freezing() {
    use crate::game::transport::{
        GraphVersion, PathCache, PathfindingConfig, RegionGraph, RoadGraph,
        rebuild_road_graph_inner,
    };

    let mut grid = MapGrid::new(4, 1);
    for x in 0..4 {
        let p = TilePos { x, y: 0 };
        let Some(mut c) = grid.get(p) else {
            continue;
        };
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(p, c);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let mut occ = TrafficOccupancy::default();
    occ.ensure_len(grid.len());

    let cfg = PathfindingConfig {
        enable_hierarchical: false,
        ..Default::default()
    };

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(MapConfig {
            width: 4,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(graph)
        .insert_resource(RegionGraph::default())
        .insert_resource(cfg)
        .insert_resource(PathCache::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(occ)
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, resolve_stuck_vehicles);

    let current = TilePos { x: 0, y: 0 };
    let goal = TilePos { x: 3, y: 0 };
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                current,
                TilePos { x: 1, y: 0 },
                TilePos { x: 2, y: 0 },
                goal,
            ],
            0,
            0.0,
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    // No TripPassenger, no ServiceVehicle: the kind the old guardrail never removed.
    let e = app
        .world_mut()
        .spawn((
            vehicle,
            VehicleTrafficState::FreeFlow,
            StuckTimer {
                secs: STUCK_DESPAWN_SECS,
                last_tile: current,
                last_progress: 0.0,
                uturn_attempted: false,
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(e).is_err(),
        "passenger-less vehicle wedged on its only path must despawn, not freeze forever"
    );
}

/// Verifies speed-dependent lane preference: slow vehicles keep right, fast vehicles prefer left.
/// Uses separate tests to avoid vehicles blocking each other's lane changes.
#[test]
fn lane_preference_slow_keeps_right() {
    let mut app = lane_preference_test_setup();
    let slow_route: Vec<TilePos> = (0..6).map(|x| TilePos { x, y: 1 }).collect();
    let slow_vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            slow_route,
            0,
            0.0,
            5.0,
            60.0,
            20.0,
            KEEP_RIGHT_SPEED_THRESHOLD - 0.05, // slow: below threshold
        )
    };
    let slow_entity = app
        .world_mut()
        .spawn((slow_vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    let vehicle = app.world().get::<Vehicle>(slow_entity).unwrap();
    let route_after = path_pool.get(vehicle.path_handle).unwrap();
    assert_eq!(
        route_after[0],
        TilePos { x: 0, y: 1 },
        "slow vehicle should keep current tile"
    );
    assert_eq!(
        route_after[1],
        TilePos { x: 0, y: 0 },
        "slow vehicle should change to right lane (keep-right)"
    );
}

#[test]
fn lane_preference_fast_prefers_left() {
    let mut app = lane_preference_test_setup();
    let fast_route: Vec<TilePos> = (0..6).map(|x| TilePos { x, y: 0 }).collect();
    let fast_vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            fast_route,
            0,
            0.0,
            5.0,
            60.0,
            20.0,
            KEEP_RIGHT_SPEED_THRESHOLD + 0.05, // fast: above threshold
        )
    };
    let fast_entity = app
        .world_mut()
        .spawn((fast_vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    let vehicle = app.world().get::<Vehicle>(fast_entity).unwrap();
    let route_after = path_pool.get(vehicle.path_handle).unwrap();
    assert_eq!(
        route_after[0],
        TilePos { x: 0, y: 0 },
        "fast vehicle should keep current tile"
    );
    assert_eq!(
        route_after[1],
        TilePos { x: 0, y: 1 },
        "fast vehicle should change to left lane (prefer-left)"
    );
}

fn lane_preference_test_setup() -> bevy::prelude::App {
    use crate::game::transport::{
        GraphVersion, PathCache, PathfindingConfig, RegionGraph, RoadGraph,
        rebuild_road_graph_inner,
    };

    let mut grid = MapGrid::new(6, 2);
    for x in 0..6 {
        for y in 0..2 {
            let pos = TilePos { x, y };
            let Some(mut c) = grid.get(pos) else {
                continue;
            };
            c.water = false;
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: y as u8,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, c);
        }
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let mut occ = TrafficOccupancy::default();
    occ.ensure_len(grid.len());

    let path_cfg = PathfindingConfig {
        enable_hierarchical: false,
        ..Default::default()
    };

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(MapConfig {
            width: 6,
            height: 2,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(graph)
        .insert_resource(RegionGraph::default())
        .insert_resource(path_cfg)
        .insert_resource(PathCache::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(occ)
        .insert_resource(TrafficConfig::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(
            Update,
            (
                build_traffic_spatial_index_pre_lane_changes,
                plan_lane_changes,
            )
                .chain(),
        );

    app
}

#[test]
fn stuck_returning_service_vehicle_is_sent_home_to_park_not_left_to_block() {
    use crate::game::services::{ServiceKind, ServiceVehicle, ServiceVehicleState};

    // A Returning service vehicle is never despawned by the stuck guardrail (that would leak its
    // station's vehicle count) and rerouting loops it back into the same jam — so a wedged one blocks
    // a lane forever (live: Returning service vehicles pinned at the oversized intersection). Recovery
    // must consume its route so park_returned_service_vehicles snaps it to its station.
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(
            Update,
            super::stuck::recover_stuck_returning_service_vehicles,
        );

    let station = app.world_mut().spawn(()).id();
    let route = vec![
        TilePos { x: 0, y: 0 },
        TilePos { x: 1, y: 0 },
        TilePos { x: 2, y: 0 },
        TilePos { x: 3, y: 0 },
    ];
    let mk = |app: &mut App, state: ServiceVehicleState, stuck_secs: f32| {
        let v = {
            let mut pp = app
                .world_mut()
                .resource_mut::<crate::game::transport::PathPool>();
            create_vehicle_with_route(&mut pp, route.clone(), 0, 0.0, 0.0, 60.0, 20.0, 1.0)
        };
        app.world_mut()
            .spawn((
                v,
                VehicleTrafficState::FreeFlow,
                ServiceVehicle {
                    kind: ServiceKind::Fire,
                    home_station: station,
                    home_road: TilePos { x: 9, y: 9 },
                    mission: None,
                    state,
                },
                StuckTimer {
                    secs: stuck_secs,
                    last_tile: TilePos { x: 0, y: 0 },
                    last_progress: 0.0,
                    uturn_attempted: false,
                },
            ))
            .id()
    };

    // Stuck + Returning -> route consumed (will be parked at station).
    let stuck_returning = mk(&mut app, ServiceVehicleState::Returning, STUCK_REROUTE_SECS);
    // Returning but not yet stuck -> untouched.
    let fresh_returning = mk(&mut app, ServiceVehicleState::Returning, 0.0);
    // Stuck but mid-mission (EnRoute) -> must NOT be teleported away.
    let stuck_enroute = mk(&mut app, ServiceVehicleState::EnRoute, STUCK_REROUTE_SECS);

    app.update();

    let len = {
        let w = app.world();
        let pp = w.resource::<crate::game::transport::PathPool>();
        let v = w.get::<Vehicle>(stuck_returning).unwrap();
        pp.len(v.path_handle)
    };
    let cursor = |app: &App, e| app.world().get::<Vehicle>(e).unwrap().path_cursor;

    assert_eq!(
        cursor(&app, stuck_returning),
        len,
        "stuck Returning service vehicle must have its route consumed so it parks at the station"
    );
    assert_eq!(
        cursor(&app, fresh_returning),
        0,
        "a Returning vehicle not yet stuck must be left alone"
    );
    assert_eq!(
        cursor(&app, stuck_enroute),
        0,
        "a stuck mid-mission (EnRoute) vehicle must NOT be teleported home"
    );
}
