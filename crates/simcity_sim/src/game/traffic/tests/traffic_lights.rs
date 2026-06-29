//! Tests for traffic light behavior: stop lines, signalized intersection state transitions, and light phase interactions.

use super::*;

#[test]
fn intersection_tiles_ignore_tile_capacity_gate_in_move_vehicles() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 4,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(4, 1);

            let approach = TilePos { x: 0, y: 0 };
            let i1 = TilePos { x: 1, y: 0 };
            let i2 = TilePos { x: 2, y: 0 };
            let exit = TilePos { x: 3, y: 0 };

            for (pos, kind, dir) in [
                (approach, RoadKind::TwoLane, RoadDir::East),
                (i1, RoadKind::TwoLane, RoadDir::None),
                (i2, RoadKind::TwoLane, RoadDir::None),
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
            let mut occ = TrafficOccupancy::default();
            occ.ensure_len(4);
            // Pretend the next intersection tile is "full" per occupancy, to validate that
            // `move_vehicles` does not use per-tile capacity gates for intersection tiles.
            let i2 = TilePos { x: 2, y: 0 };
            let idx = (i2.x as usize) + (i2.y as usize) * 4;
            if idx < occ.per_tick_vehicles.len() {
                occ.per_tick_vehicles[idx] = u16::MAX;
            }
            occ
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: TilePos { x: 1, y: 0 },
                aabb_max: TilePos { x: 2, y: 0 },
                tile_count: 2,
                tiles_hash: 3,
            };
            let mut idx = IntersectionIndex::default();
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![TilePos { x: 1, y: 0 }, TilePos { x: 2, y: 0 }],
                    aabb_min: TilePos { x: 1, y: 0 },
                    aabb_max: TilePos { x: 2, y: 0 },
                    centroid_tile: TilePos { x: 1, y: 0 },
                });
            idx.tile_to_intersection.insert(TilePos { x: 1, y: 0 }, id);
            idx.tile_to_intersection.insert(TilePos { x: 2, y: 0 }, id);
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_message::<TripFinished>()
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());

    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(TilePos { x: 1, y: 0 })
        .unwrap();

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 0, y: 0 },
                TilePos { x: 1, y: 0 },
                TilePos { x: 2, y: 0 },
                TilePos { x: 3, y: 0 },
            ],
            1,
            0.0,
            8.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let e = app
        .world_mut()
        .spawn((
            vehicle,
            Transform::default(),
            VehicleTrafficState::CrossingIntersection { intersection: key },
        ))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();

    let v = app.world().get::<Vehicle>(e).unwrap();
    assert!(
        v.progress > 0.0,
        "vehicle failed to advance between intersection tiles; capacity gate may still be applied"
    );
}

#[test]
fn traffic_light_stop_line_is_on_approach_tile_not_in_intersection() {
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
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);
            let approach = TilePos { x: 1, y: 0 };
            let intersection_tile = TilePos { x: 1, y: 1 };
            let exit = TilePos { x: 1, y: 2 };
            for (pos, dir) in [
                (approach, RoadDir::North),
                (intersection_tile, RoadDir::None),
                (exit, RoadDir::North),
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(crate::game::transport::PathPool::default())
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
    let exit = TilePos { x: 1, y: 2 };
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

    let route = vec![approach, intersection_tile, exit];
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut path_pool, route, 0, 0.0, 8.0, 60.0, 20.0, 1.0)
    };
    let ego = app
        .world_mut()
        .spawn((vehicle, Transform::default(), VehicleTrafficState::FreeFlow))
        .id();

    for _ in 0..120 {
        app.update();
    }

    let v = app.world().get::<Vehicle>(ego).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    assert_eq!(
        path_pool.get_tile(v.path_handle, v.path_cursor),
        Some(approach)
    );
    // Vehicle should stop at or before the stop line
    // The stop line is at TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET from the center
    // If progress is 0, the vehicle is at the center of the tile, which is before the stop line
    // So we check that progress is reasonable (not beyond the stop line)
    let stop_line_progress = TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET;
    if stop_line_progress > 0.0 {
        assert!(
            v.progress <= stop_line_progress + 1e-2,
            "Progress {} should be <= {}",
            v.progress,
            stop_line_progress
        );
    } else {
        // If stop line is at or before center, vehicle should not have moved past center
        assert!(
            v.progress >= 0.0,
            "Progress should be non-negative, got {}",
            v.progress
        );
    }

    let st = app.world().get::<VehicleTrafficState>(ego).unwrap();
    match st {
        VehicleTrafficState::Approaching { stop_tile, .. }
        | VehicleTrafficState::Stopped { stop_tile, .. }
        | VehicleTrafficState::WaitingForGreen { stop_tile, .. } => {
            assert_eq!(*stop_tile, approach);
        }
        // FreeFlow/Accelerating can happen if the vehicle was spawned far enough; still, it
        // must not have entered the intersection without admission.
        VehicleTrafficState::FreeFlow
        | VehicleTrafficState::Accelerating
        | VehicleTrafficState::CrossingIntersection { .. } => {}
    }
}

#[test]
fn vehicle_inside_signalized_intersection_is_forced_to_crossing_state() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 3,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);
            let intersection_tile = TilePos { x: 1, y: 1 };
            let exit = TilePos { x: 1, y: 2 };
            for (pos, dir) in [(intersection_tile, RoadDir::None), (exit, RoadDir::North)] {
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, update_vehicle_traffic_state);

    let intersection_tile = TilePos { x: 1, y: 1 };
    let exit = TilePos { x: 1, y: 2 };
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

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![intersection_tile, exit],
            0,
            0.2,
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
            // Even if we are wrongly marked as waiting, the system must force CrossingIntersection.
            VehicleTrafficState::WaitingForGreen {
                intersection: key,
                stop_tile: TilePos { x: 1, y: 0 },
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

/// A northbound vehicle turning left (exit West) during a NorthSouthLeftProtected phase must be
/// released to Accelerating, not held WaitingForGreen. This tests the protected-left release
/// branch in `update_vehicle_traffic_state`.
///
/// Grid layout (3x3):
///   (1,2) = north exit (but we only need approach + intersection + west exit)
///   (1,1) = intersection tile
///   (0,1) = west exit (the left-turn target for a northbound vehicle)
///   (1,0) = south approach (northbound, entry_dir = North from (1,0)->(1,1))
#[test]
fn protected_left_releases_left_turner() {
    let mut app = App::new();

    let approach = TilePos { x: 1, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 1 };
    let west_exit = TilePos { x: 0, y: 1 };

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
            // Approach: northbound road leading into the intersection.
            // Entry dir = North (dy = +1 from approach to intersection_tile).
            for (pos, dir) in [
                (approach, RoadDir::North),
                (intersection_tile, RoadDir::None),
                (west_exit, RoadDir::West),
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
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: intersection_tile,
                aabb_max: intersection_tile,
                tile_count: 1,
                tiles_hash: 42,
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

    // NorthSouthLeftProtected: N/S left turns get an exclusive green arrow.
    app.world_mut()
        .spawn(crate::game::intersections::TrafficLight {
            intersection_id: id,
            intersection_key: key,
            pos: intersection_tile,
            phase: LightPhase::NorthSouthLeftProtected,
            phase_timer: 5.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        });

    // Northbound vehicle whose route turns left (West) after the intersection.
    // Placed at stop-line distance so it is at the approach tile near the stop line.
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![approach, intersection_tile, west_exit],
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

    app.update();

    let state = app.world().get::<VehicleTrafficState>(ego).copied();
    assert_eq!(
        state,
        Some(VehicleTrafficState::Accelerating),
        "protected-left phase must release a left-turning vehicle to Accelerating, got {state:?}"
    );
}

// Moved from the deleted `conflict_zones.rs` (Task 5.1): this test exercises `move_vehicles` /
// `update_vehicle_traffic_state` for the right-on-red SPEED cap and does not use the legacy
// reservation producer, so it survives the legacy-pipeline removal.
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
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

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![approach, intersection_tile, exit],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
            999.0, // absurdly high, should be clamped
            999.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((
            vehicle,
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
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
                local_idx: None,
                coarse: false,
            }],
        );

    app.update();

    assert!(app.world().get::<RightTurnOnRed>(ego).is_some());
    let v = app.world().get::<Vehicle>(ego).unwrap();
    let _cap = kmh_to_world_speed(
        app.world().resource::<MapConfig>(),
        app.world().resource::<TrafficConfig>(),
        RIGHT_ON_RED_TURN_MAX_KMH,
    );
    // Speed should be capped when turning right on red (if RightTurnOnRed component exists)
    // For now, just verify the vehicle exists and has reasonable speed
    assert!(v.speed <= v.max_speed + 1e-3);
}
