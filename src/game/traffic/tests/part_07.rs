use super::*;

#[test]
fn intersection_conflict_zones_allow_two_opposite_straights() {
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
            let intersection_tile = TilePos { x: 1, y: 1 };

            for (pos, dir) in [
                (TilePos { x: 1, y: 0 }, RoadDir::North),
                (TilePos { x: 1, y: 2 }, RoadDir::South),
            ] {
                if let Some(mut cell) = grid.get(pos) {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }
            }
            if let Some(mut cell) = grid.get(intersection_tile) {
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::None,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(intersection_tile, cell);
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
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let intersection_tile = TilePos { x: 1, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();

    // Car A: south -> north straight (zones NE|SE).
    let mut path_pool = app.world_mut().resource_mut::<crate::game::transport::PathPool>();
    let a = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                vec![
                    TilePos { x: 1, y: 0 },
                    intersection_tile,
                    TilePos { x: 1, y: 2 },
                ],
                0,
                0.9,
                1.0,
                60.0,
                20.0,
            ),
            VehicleTrafficState::FreeFlow,
        ))
        .id();

    // Car B: north -> south straight (zones NW|SW).
    let b = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                vec![
                    TilePos { x: 1, y: 2 },
                    intersection_tile,
                    TilePos { x: 1, y: 0 },
                ],
                0,
                0.9,
                1.0,
                60.0,
                20.0,
            ),
            VehicleTrafficState::FreeFlow,
        ))
        .id();

    app.update();

    let rs = app
        .world()
        .resource::<IntersectionReservations>()
        .by_intersection
        .get(&id)
        .cloned()
        .unwrap_or_default();
    assert_eq!(rs.len(), 2);
    assert!(rs.iter().any(|r| r.vehicle == a));
    assert!(rs.iter().any(|r| r.vehicle == b));
}

#[test]
fn intersection_conflict_zones_block_two_conflicting_right_turns() {
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
            let intersection_tile = TilePos { x: 1, y: 1 };
            for pos in [TilePos { x: 1, y: 0 }, TilePos { x: 2, y: 1 }] {
                if let Some(mut cell) = grid.get(pos) {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::East,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }
            }
            if let Some(mut cell) = grid.get(intersection_tile) {
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::None,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(intersection_tile, cell);
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
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let intersection_tile = TilePos { x: 1, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();

    // Two vehicles doing the same right-turn (same stream) should be able to follow each other
    // through the intersection (no artificial "one vehicle at a time" rule).
    let mut path_pool = app.world_mut().resource_mut::<crate::game::transport::PathPool>();
    let route = vec![
        TilePos { x: 1, y: 0 },
        intersection_tile,
        TilePos { x: 2, y: 1 },
    ];
    let a = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                route.clone(),
                0,
                0.9,
                1.0,
                60.0,
                20.0,
            ),
            VehicleTrafficState::FreeFlow,
        ))
        .id();
    let b = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                route,
                0,
                0.8,
                1.0,
                60.0,
                20.0,
            ),
            VehicleTrafficState::FreeFlow,
        ))
        .id();

    app.update();

    let rs = app
        .world()
        .resource::<IntersectionReservations>()
        .by_intersection
        .get(&id)
        .cloned()
        .unwrap_or_default();
    assert_eq!(rs.len(), 2);
    assert!(rs.iter().any(|r| r.vehicle == a));
    assert!(rs.iter().any(|r| r.vehicle == b));
}

#[test]
fn right_turn_on_red_speed_is_capped_to_turn_speed() {
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
        .insert_resource(MapGrid::new(3, 3))
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
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
        .add_systems(
            Update,
            (
                update_vehicle_traffic_state,
                build_traffic_spatial_index,
                move_vehicles,
            )
                .chain(),
        );

    let approach = TilePos { x: 1, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 1 };
    let exit = TilePos { x: 2, y: 1 };

    // Set up road cells so speed limit is > 15 km/h.
    {
        let mut grid = app.world_mut().resource_mut::<MapGrid>();
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
    }

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

    // Red for North/South, green for East/West (so right-on-red is applicable for a North approach).
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

    let mut path_pool = app.world_mut().resource_mut::<crate::game::transport::PathPool>();
    let ego = app
        .world_mut()
        .spawn((
            create_vehicle_with_route(
                &mut path_pool,
                vec![approach, intersection_tile, exit],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                999.0, // absurdly high, should be clamped
                999.0,
                20.0,
            ),
            Transform::default(),
            VehicleTrafficState::WaitingForGreen {
                intersection: key,
                stop_tile: approach,
            },
        ))
        .id();

    // Pre-own a reservation so right-on-red can release us.
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

    assert!(app.world().get::<RightTurnOnRed>(ego).is_some());
    let v = app.world().get::<Vehicle>(ego).unwrap();
    let cap = kmh_to_world_speed(
        app.world().resource::<MapConfig>(),
        app.world().resource::<TrafficConfig>(),
        RIGHT_ON_RED_TURN_MAX_KMH,
    );
    assert!(v.speed <= cap + 1e-3);
}
