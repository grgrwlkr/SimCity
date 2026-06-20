//! Tests for right turn on red behavior: pedestrian blocking, intersection clearance requirements, speed limits, and reservation interactions.

use super::*;

#[test]
fn right_turn_on_red_is_blocked_by_conflicting_pedestrian_crossing_axis() {
    use crate::game::pedestrians::PedestrianCrossing;

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
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

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

    // Pedestrian crossing N/S blocks turns onto the E/W roadway.
    app.world_mut().spawn(PedestrianCrossing {
        intersection_id: id,
        axis_ns: true,
    });

    app.update();
    assert!(
        !app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(id, ego)
    );

    // Once the pedestrian is gone, right-on-red can be admitted.
    let ped_entity = {
        let world = app.world_mut();
        let mut q = world.query_filtered::<Entity, With<PedestrianCrossing>>();
        q.iter(world).next().unwrap()
    };
    app.world_mut().entity_mut(ped_entity).despawn();

    app.update();
    assert!(
        app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(id, ego)
    );
}

#[test]
fn right_turn_on_red_is_only_admitted_when_intersection_is_clear() {
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
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

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

    // Another reservation exists, but it does NOT conflict by zones (NW vs SE).
    let other = app.world_mut().spawn_empty().id();
    app.world_mut()
        .resource_mut::<IntersectionReservations>()
        .by_intersection
        .insert(
            id,
            vec![IntersectionReservation {
                vehicle: other,
                state: ReservationState::Approaching,
                created_at_sec: 0.0,
                zones: ZONE_NW,
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            }],
        );

    app.update();

    let rs = app
        .world()
        .resource::<IntersectionReservations>()
        .by_intersection
        .get(&id)
        .unwrap();
    assert!(rs.iter().all(|r| r.vehicle != ego));
}

#[test]
fn turn_reservations_yield_only_to_conflicting_pedestrian_axis() {
    use crate::game::pedestrians::PedestrianCrossing;

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

            // Approach from south (northbound), exit to east.
            for (pos, dir) in [
                (TilePos { x: 1, y: 0 }, RoadDir::North),
                (intersection_tile, RoadDir::None),
                (TilePos { x: 2, y: 1 }, RoadDir::East),
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
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let intersection_tile = TilePos { x: 1, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();

    // Ego: right turn from northbound (south approach) to east.
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 1, y: 0 },
                intersection_tile,
                TilePos { x: 2, y: 1 },
            ],
            0,
            0.9,
            1.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((vehicle, VehicleTrafficState::FreeFlow))
        .id();

    // Pedestrian crossing axis NS (i.e. moving N/S, crossing E-W roadway) -> should block this turn.
    app.world_mut().spawn(PedestrianCrossing {
        intersection_id: id,
        axis_ns: true,
    });

    app.update();
    assert!(
        !app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(id, ego)
    );

    // Swap to the non-conflicting axis (EW). Now the same turn should be admissible.
    let ped_e = {
        let world = app.world_mut();
        let mut q = world.query_filtered::<Entity, With<PedestrianCrossing>>();
        q.iter(world).next().unwrap()
    };
    app.world_mut().entity_mut(ped_e).despawn();
    app.world_mut().spawn(PedestrianCrossing {
        intersection_id: id,
        axis_ns: false,
    });

    app.update();
    assert!(
        app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(id, ego)
    );
}
