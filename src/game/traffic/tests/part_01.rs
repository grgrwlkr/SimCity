use super::*;

#[test]
fn vehicle_arrival_emits_trip_finished() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 8,
            height: 8,
            tile_size: 16.0,
        })
        .insert_resource(MapGrid::new(8, 8))
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
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

    let citizen = CitizenId(42);
    let vehicle = app
        .world_mut()
        .spawn((
            Vehicle {
                route: Vec::new(),
                route_idx: 0,
                progress: 0.0,
                speed: 0.0,
                max_speed: 60.0,
                max_accel: 20.0,
            },
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            TripPassenger {
                citizen,
                purpose: TripPurpose::Work,
            },
        ))
        .id();

    app.update();

    assert_eq!(app.world().resource::<FinishCount>().0, 1);
    assert!(app.world().get_entity(vehicle).is_err());
}

#[test]
fn stop_sign_release_does_not_oscillate_crossing_state() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 3,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(3, 1);

            let approach = TilePos { x: 0, y: 0 };
            let intersection_tile = TilePos { x: 1, y: 0 };
            let exit = TilePos { x: 2, y: 0 };

            for (pos, dir) in [
                (approach, RoadDir::East),
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
            let intersection_tile = TilePos { x: 1, y: 0 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: intersection_tile,
                aabb_max: intersection_tile,
                tile_count: 1,
                tiles_hash: 1,
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
            idx
        })
        .add_systems(Update, check_intersection_priority);

    let approach = TilePos { x: 0, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 0 };
    let exit = TilePos { x: 2, y: 0 };
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(intersection_tile)
        .unwrap();

    // Place a stop sign marker on the intersection tile.
    app.world_mut().spawn(IntersectionPriorityMarker {
        pos: intersection_tile,
        priority: IntersectionPriority::StopSign,
    });

    // Vehicle is sitting right at the stop line (dist_to_stop == 0) and has already stopped.
    let vehicle = app
        .world_mut()
        .spawn((
            Vehicle {
                route: vec![approach, intersection_tile, exit],
                route_idx: 0,
                progress: TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                speed: 0.0,
                max_speed: 60.0,
                max_accel: 20.0,
            },
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: approach,
                queue_position: 0,
            },
        ))
        .id();

    // Tick 1: released to CrossingIntersection.
    app.update();
    assert_eq!(
        app.world().get::<VehicleTrafficState>(vehicle).copied(),
        Some(VehicleTrafficState::CrossingIntersection { intersection: key })
    );

    // Tick 2: must stay in CrossingIntersection while still on the approach tile (no oscillation).
    app.update();
    assert_eq!(
        app.world().get::<VehicleTrafficState>(vehicle).copied(),
        Some(VehicleTrafficState::CrossingIntersection { intersection: key })
    );
}

#[test]
fn stop_sign_vehicle_gets_reserved_and_enters_intersection_tile() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 3,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(3, 1);

            let approach = TilePos { x: 0, y: 0 };
            let intersection_tile = TilePos { x: 1, y: 0 };
            let exit = TilePos { x: 2, y: 0 };

            for (pos, kind, dir) in [
                (approach, RoadKind::TwoLane, RoadDir::East),
                // Intersection cluster tile: road tile with `dir=None` (cluster marker).
                (intersection_tile, RoadKind::TwoLane, RoadDir::None),
                (exit, RoadKind::TwoLane, RoadDir::East),
            ] {
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind,
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
            let intersection_tile = TilePos { x: 1, y: 0 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: intersection_tile,
                aabb_max: intersection_tile,
                tile_count: 1,
                tiles_hash: 1,
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
            idx
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        // Stop sign marker is used by `check_intersection_priority` to keep the vehicle stopped
        // until it is safe to proceed.
        .add_systems(
            Update,
            (
                check_intersection_priority,
                plan_intersection_reservations,
                build_traffic_spatial_index,
                move_vehicles,
            )
                .chain(),
        );

    let approach = TilePos { x: 0, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 0 };
    let exit = TilePos { x: 2, y: 0 };
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(intersection_tile)
        .unwrap();

    app.world_mut().spawn(IntersectionPriorityMarker {
        pos: intersection_tile,
        priority: IntersectionPriority::StopSign,
    });

    let e = app
        .world_mut()
        .spawn((
            Vehicle {
                route: vec![approach, intersection_tile, exit],
                route_idx: 0,
                progress: TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                speed: 0.0,
                max_speed: 60.0,
                max_accel: 20.0,
            },
            Transform::default(),
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: approach,
                queue_position: 0,
            },
        ))
        .id();

    // Advance fixed time so `move_vehicles` has a non-zero dt.
    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));

    app.update();

    // Reservation must exist now (or we'll deadlock at the intersection entry gate).
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();
    let reserved = app
        .world()
        .resource::<IntersectionReservations>()
        .is_reserved_by(id, e);
    assert!(reserved, "stop-sign vehicle was not reserved");

    // And vehicle should be able to start moving toward the intersection.
    let v = app.world().get::<Vehicle>(e).unwrap();
    assert!(
        v.progress > TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
        "vehicle did not advance after being released/reserved"
    );
}
