use super::lane_change::{LaneChangeCooldown, OvertakeOncoming};
use super::stuck::StuckTimer;
use super::*;

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
    let mut path_pool = app.world_mut().resource_mut::<crate::game::transport::PathPool>();
    app.world_mut().spawn((
        create_vehicle_with_route(
            &mut path_pool,
            (1..20).map(|x| TilePos { x, y: 0 }).collect(),
            0,
            0.0,
            2.0,
            60.0,
            20.0,
        ),
        VehicleTrafficState::FreeFlow,
    ));

    // Ego vehicle behind, wants to pass.
    let ego = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                (0..20).map(|x| TilePos { x, y: 0 }).collect(),
                0,
                0.0,
                5.0,
                60.0,
                20.0,
            ),
            VehicleTrafficState::FreeFlow,
        ))
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

    let mut path_pool = app.world_mut().resource_mut::<crate::game::transport::PathPool>();
    let ego = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                vec![approach, intersection_tile, exit],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
            ),
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
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            }],
        );

    app.update();
    assert_eq!(
        app.world().get::<VehicleTrafficState>(ego).copied(),
        Some(VehicleTrafficState::Accelerating)
    );
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
    let mut path_pool = app.world_mut().resource_mut::<crate::game::transport::PathPool>();
    let e = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                vec![current, goal],
                0,
                0.0,
                0.0,
                60.0,
                20.0,
            ),
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
    assert_eq!(route[0], current);
    assert_eq!(route[1], TilePos { x: 1, y: 1 });
    assert_eq!(route[2], goal);
}
