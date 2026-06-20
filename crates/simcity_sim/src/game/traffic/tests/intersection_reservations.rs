//! Tests for intersection reservation system: concurrent reservations, conflict detection, and reservation mechanics.

use super::*;

#[test]
fn straight_stream_allows_multiple_vehicles_to_reserve_concurrently() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
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
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let approach = TilePos { x: 0, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 0 };
    let exit = TilePos { x: 2, y: 0 };
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(intersection_tile)
        .unwrap();

    // Two vehicles in the SAME stream (eastbound straight). Both should be reserved.
    let route = vec![approach, intersection_tile, exit];
    let (v1, v2) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(
                &mut path_pool,
                route.clone(),
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
            create_vehicle_with_route(
                &mut path_pool,
                route,
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
        )
    };
    let e1 = app
        .world_mut()
        .spawn((
            v1,
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: approach,
                queue_position: 0,
            },
        ))
        .id();
    let e2 = app
        .world_mut()
        .spawn((
            v2,
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: approach,
                queue_position: 1,
            },
        ))
        .id();

    app.update();

    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();
    let res = app.world().resource::<IntersectionReservations>();
    assert!(res.is_reserved_by(id, e1));
    assert!(res.is_reserved_by(id, e2));
}

#[test]
fn left_turn_conflicts_with_straight_flow() {
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
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);
            let i = TilePos { x: 1, y: 1 };

            // Eastbound straight: (0,1)->(1,1)->(2,1)
            for (pos, dir) in [
                (TilePos { x: 0, y: 1 }, RoadDir::East),
                (i, RoadDir::None),
                (TilePos { x: 2, y: 1 }, RoadDir::East),
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

            // Northbound left turn: (1,0)->(1,1)->(0,1) (turn left at the intersection).
            for (pos, dir) in [
                (TilePos { x: 1, y: 0 }, RoadDir::North),
                (i, RoadDir::None),
                (TilePos { x: 0, y: 1 }, RoadDir::East),
            ] {
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                if !cell.road.is_some() {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                }
                grid.set(pos, cell);
            }

            grid
        })
        .insert_resource({
            let i = TilePos { x: 1, y: 1 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: i,
                aabb_max: i,
                tile_count: 1,
                tiles_hash: 1,
            };
            let mut idx = IntersectionIndex::default();
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![i],
                    aabb_min: i,
                    aabb_max: i,
                    centroid_tile: i,
                });
            idx.tile_to_intersection.insert(i, id);
            idx
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let i = TilePos { x: 1, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(i)
        .unwrap();

    // Straight vehicle (eastbound).
    let (straight_vehicle, left_vehicle) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 0, y: 1 }, i, TilePos { x: 2, y: 1 }],
                0,
                0.9,
                1.0,
                60.0,
                20.0,
                1.0,
            ),
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 1, y: 0 }, i, TilePos { x: 0, y: 1 }],
                0,
                0.9,
                1.0,
                60.0,
                20.0,
                1.0,
            ),
        )
    };
    let straight = app
        .world_mut()
        .spawn((straight_vehicle, VehicleTrafficState::FreeFlow))
        .id();

    // Left turn vehicle (from south to west).
    let left = app
        .world_mut()
        .spawn((left_vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let list = res.by_intersection.get(&id).cloned().unwrap_or_default();
    assert!(list.iter().any(|r| r.vehicle == straight));

    // The northbound left turn (South→West) physically crosses the eastbound straight's path
    // through the single intersection tile: the left-turner must sweep across the lane the
    // straight occupies. The coarse mask wrongly reported these as disjoint (ZONE_NW vs
    // ZONE_SW|ZONE_SE); per-tile admission now correctly blocks the lower-priority left turn
    // while the higher-priority straight proceeds. This is the same crossing-vs-coarse-mask
    // bug class P0-2 targets, now covered on single-tile clusters.
    assert!(
        !list.iter().any(|r| r.vehicle == left),
        "left turn crosses the perpendicular straight on the shared tile and must yield"
    );
}

#[test]
fn intersection_tile_with_kind_none_does_not_force_speed_to_zero() {
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

            // Approach/exit are regular road tiles, intersection cluster tiles have `dir=None`
            // and `kind != None` (as in the runtime grid).
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
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            // One intersection cluster covering tiles (1,0) and (2,0).
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
            1, // already inside intersection cluster (kind=None/dir=None)
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
        v.speed > 0.1,
        "vehicle speed was forced near-zero while on intersection tile"
    );
    assert!(v.progress > 0.0, "vehicle did not advance while crossing");
}
