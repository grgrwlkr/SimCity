//! Tests for vehicle spawning and trip management: spawn location logic, yellow light behavior, and trip lifecycle.

use super::*;

#[test]
fn yellow_allows_proceeding_if_too_late_to_stop_comfortably() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 6,
            height: 6,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(6, 6);

            let t0 = TilePos { x: 2, y: 0 };
            let t1 = TilePos { x: 2, y: 1 };
            let t2 = TilePos { x: 2, y: 2 };
            let intersection_tile = TilePos { x: 2, y: 3 };
            let exit = TilePos { x: 3, y: 3 };

            for (pos, dir) in [
                (t0, RoadDir::North),
                (t1, RoadDir::North),
                (t2, RoadDir::North),
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
            let intersection_tile = TilePos { x: 2, y: 3 };
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, update_vehicle_traffic_state);

    let intersection_tile = TilePos { x: 2, y: 3 };
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

    // Yellow for North/South.
    app.world_mut()
        .spawn(crate::game::intersections::TrafficLight {
            intersection_id: id,
            intersection_key: key,
            pos: intersection_tile,
            phase: LightPhase::NorthSouthYellow,
            phase_timer: 3.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        });

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 2, y: 0 },
                TilePos { x: 2, y: 1 },
                TilePos { x: 2, y: 2 },
                intersection_tile,
                TilePos { x: 3, y: 3 },
            ],
            0,
            0.0,
            100.0, // fast enough that stopping comfortably is impossible in ~3 tiles
            999.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((
            vehicle,
            VehicleTrafficState::Approaching {
                intersection: key,
                stop_tile: TilePos { x: 2, y: 2 },
                distance_to_stop: 999.0,
            },
        ))
        .id();

    app.update();

    let state = app.world().get::<VehicleTrafficState>(ego).copied();
    assert_eq!(
        state,
        Some(VehicleTrafficState::CrossingIntersection { intersection: key })
    );
}

#[test]
fn car_trip_spawns_from_citizen_car_parked_at_not_from() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripRequested>();

    let cfg = MapConfig {
        width: 3,
        height: 3,
        tile_size: 16.0,
    };

    let grid = {
        let mut grid = MapGrid::new(3, 3);
        // Two road tiles:
        // - (1,0) adjacent to `from` (0,0)
        // - (1,2) adjacent to `car_parked_at` (0,2) and `to` (2,2)
        for pos in [TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 2 }] {
            let Some(mut cell) = grid.get(pos) else {
                continue;
            };
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, cell);
        }
        grid
    };

    let graph = {
        let mut graph = RoadGraph::default();
        let gv = crate::game::transport::GraphVersion(1);
        crate::game::transport::rebuild_road_graph_inner(&grid, &gv, &mut graph);
        graph
    };

    app.insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(cfg)
        .insert_resource(grid)
        .insert_resource(graph)
        .insert_resource(RegionGraph::default())
        .insert_resource(PathfindingConfig {
            enable_hierarchical: false,
            ..Default::default()
        })
        .insert_resource(PathCache::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficIndex::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<crate::game::sim::SimRng>()
        .add_systems(Update, spawn_trip_vehicles);

    // Citizen's car is parked at "work" building (0,2), but trip is requested from (0,0).
    let cid = crate::game::ids::CitizenId(1);
    app.world_mut().spawn((
        CitizenIdComp(cid),
        Citizen {
            home: TilePos { x: 0, y: 0 },
            state: crate::game::citizens::CitizenState::AtHome,
            last_place: TilePos { x: 0, y: 0 },
            tour_mode: Some(TripMode::Car),
            car_parked_at: TilePos { x: 0, y: 2 },
            decision_timer: Timer::from_seconds(1.0, TimerMode::Repeating),
            shopping_need: Timer::from_seconds(1.0, TimerMode::Repeating),
            work_stay: Timer::from_seconds(1.0, TimerMode::Once),
            shop_stay: Timer::from_seconds(1.0, TimerMode::Once),
            trip_departed_at_sec: None,
            trip_purpose: None,
        },
        crate::game::citizens::CitizenWorkplace::default(),
    ));

    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<TripRequested>>()
        .write(TripRequested {
            citizen: cid,
            from: TilePos { x: 0, y: 0 },
            car_parked_at: Some(TilePos { x: 0, y: 2 }),
            to: TilePos { x: 2, y: 2 },
            purpose: crate::game::trips::TripPurpose::Work,
            mode: TripMode::Car,
        });

    app.update();

    // Ensure the spawned vehicle starts on the road adjacent to car_parked_at, i.e. (1,2).
    let world_pos = tile_to_world(app.world().resource::<MapConfig>(), TilePos { x: 1, y: 2 });
    let mut q = app
        .world_mut()
        .query_filtered::<&Transform, With<Vehicle>>();
    let t = q.iter(app.world()).next().expect("vehicle spawned");
    assert!((t.translation.x - world_pos.x).abs() < 1e-3);
    assert!((t.translation.y - world_pos.y).abs() < 1e-3);
}

#[test]
fn owned_car_is_parked_on_arrival_not_despawned() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 3,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);
            let tile = TilePos { x: 1, y: 1 };
            if let Some(mut cell) = grid.get(tile) {
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::East,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(tile, cell);
            }
            grid
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .insert_resource(FinishCount::default())
        .add_systems(
            Update,
            (
                build_traffic_spatial_index,
                move_vehicles,
                count_trip_finished,
            )
                .chain(),
        );

    let tile = TilePos { x: 1, y: 1 };
    let citizen = CitizenId(7);
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![tile],
            0,
            1.0, // will be consumed -> arrival
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let car = app
        .world_mut()
        .spawn((
            Sprite::default(),
            vehicle,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            CarOwner { citizen },
            TripPassenger {
                citizen,
                purpose: TripPurpose::Work,
            },
        ))
        .id();

    app.update();

    assert_eq!(app.world().resource::<FinishCount>().0, 1);
    assert!(
        app.world().get_entity(car).is_ok(),
        "car should not despawn"
    );
    assert!(
        app.world().get::<Parked>(car).is_some(),
        "car should be parked"
    );
    assert!(
        app.world().get::<TripPassenger>(car).is_none(),
        "trip marker removed"
    );
    let v = app.world().get::<Vehicle>(car).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    assert_eq!(path_pool.get_tile(v.path_handle, v.path_cursor), Some(tile));
    assert_eq!(v.speed, 0.0);
}
