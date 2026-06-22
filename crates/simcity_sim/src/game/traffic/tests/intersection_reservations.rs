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

#[test]
fn opposing_stuck_cars_at_uncontrolled_intersection_grant_at_most_one_per_tick() {
    use crate::game::traffic::stuck::StuckTimer;

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
            for (pos, dir) in [
                (TilePos { x: 0, y: 1 }, RoadDir::East),
                (TilePos { x: 2, y: 1 }, RoadDir::West),
                (i, RoadDir::None),
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

    let (east_v, west_v) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 0, y: 1 }, i, TilePos { x: 2, y: 1 }],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 2, y: 1 }, i, TilePos { x: 0, y: 1 }],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
        )
    };

    let stuck = StuckTimer {
        secs: INTERSECTION_FORCE_ENTRY_SECS,
        last_tile: TilePos { x: 0, y: 1 },
        last_progress: 0.0,
        uturn_attempted: false,
    };

    let e_east = app
        .world_mut()
        .spawn((east_v, VehicleTrafficState::FreeFlow, stuck))
        .id();
    let e_west = app
        .world_mut()
        .spawn((west_v, VehicleTrafficState::FreeFlow, stuck))
        .id();

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let granted =
        usize::from(res.is_reserved_by(id, e_east)) + usize::from(res.is_reserved_by(id, e_west));
    assert!(
        granted <= 1,
        "emergency entry must serialize: got {granted} reservations in one tick"
    );
    assert_eq!(
        granted, 1,
        "exactly one stuck car should get an emergency grant"
    );
}

#[test]
fn perpendicular_stuck_cars_at_uncontrolled_intersection_grant_at_most_one_per_tick() {
    // Covers the ORIGINAL force_entry collision scenario: two genuinely-conflicting maneuvers
    // (East-West straight vs North-South straight) both stuck past INTERSECTION_FORCE_ENTRY_SECS.
    // They cross the same center tile and are NOT carved out by opposite_straights/same-stream/merge/
    // both-right → neither can reserve normally → both hit the ZONE_ALL emergency path → at most one
    // must land (ZONE_ALL conflicts with everything, so can_reserve() blocks the second).
    use crate::game::traffic::stuck::StuckTimer;

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
            // 3x3 grid with a single intersection tile at (1,1).
            // Vehicle A: West→East  — route (0,1) → (1,1) → (2,1)
            // Vehicle B: North→South (y increases southward) — route (1,2) → (1,1) → (1,0)
            // Both cross the same center tile; no carve-out applies.
            let mut grid = MapGrid::new(3, 3);
            let i = TilePos { x: 1, y: 1 };
            for (pos, dir) in [
                // East-West road
                (TilePos { x: 0, y: 1 }, RoadDir::East),
                (TilePos { x: 2, y: 1 }, RoadDir::East),
                // North-South road
                (TilePos { x: 1, y: 2 }, RoadDir::South),
                (TilePos { x: 1, y: 0 }, RoadDir::South),
                // Intersection tile
                (i, RoadDir::None),
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

    // Vehicle A: West→East straight through (1,1).
    // Vehicle B: North→South straight through (1,1).
    let (ew_v, ns_v) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 0, y: 1 }, i, TilePos { x: 2, y: 1 }],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 1, y: 2 }, i, TilePos { x: 1, y: 0 }],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
        )
    };

    // Both have been stuck long enough to trigger the emergency ZONE_ALL path.
    let stuck = StuckTimer {
        secs: INTERSECTION_FORCE_ENTRY_SECS,
        last_tile: TilePos { x: 0, y: 1 },
        last_progress: 0.0,
        uturn_attempted: false,
    };

    let e_ew = app
        .world_mut()
        .spawn((ew_v, VehicleTrafficState::FreeFlow, stuck))
        .id();
    let e_ns = app
        .world_mut()
        .spawn((ns_v, VehicleTrafficState::FreeFlow, stuck))
        .id();

    app.update();

    // ZONE_ALL conflicts with everything: can_reserve() must block the second grant.
    // Exactly one perpendicular vehicle must be admitted — the real collision scenario
    // that the old force_entry bypass admitted both of.
    let res = app.world().resource::<IntersectionReservations>();
    let rs: Vec<_> = res
        .by_intersection
        .get(&id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.vehicle == e_ew || r.vehicle == e_ns)
        .collect();
    assert_eq!(
        rs.len(),
        1,
        "emergency serialization must admit exactly 1 of the 2 perpendicular-conflict vehicles; got {}",
        rs.len()
    );
}

#[test]
fn downstream_jammed_link_blocks_admission_into_upstream_intersection() {
    // 2-intersection chain on a single eastbound lane (1x6):
    //  x=0 approach | x=1 cluster A | x=2 exit-of-A/link | x=3 link (JAMMED) | x=4 cluster B | x=5 exit-of-B
    // Vehicle approaches A routed A->B->exit. The exit tile of A (x=2) is FREE, so the old
    // single-exit-tile gate would admit it. But the link tile x=3 (right before cluster B) is
    // FULL (occ == cap), so the car would cross A, fill x=2, then be unable to advance into the
    // jammed link toward B -> sits in/just past A's box -> classic cross-intersection spillback.
    // P1-1 must REFUSE admission: no reservation for this vehicle.
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 6,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(6, 1);
            for (pos, dir) in [
                (TilePos { x: 0, y: 0 }, RoadDir::East), // approach
                (TilePos { x: 1, y: 0 }, RoadDir::None), // cluster A
                (TilePos { x: 2, y: 0 }, RoadDir::East), // exit-of-A / link tile 1
                (TilePos { x: 3, y: 0 }, RoadDir::East), // link tile 2 (will be jammed)
                (TilePos { x: 4, y: 0 }, RoadDir::None), // cluster B
                (TilePos { x: 5, y: 0 }, RoadDir::East), // exit-of-B
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
            let mut idx = IntersectionIndex::default();
            // Cluster A at (1,0).
            let a = TilePos { x: 1, y: 0 };
            let id_a = IntersectionId(0);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id: id_a,
                    key: IntersectionKey {
                        aabb_min: a,
                        aabb_max: a,
                        tile_count: 1,
                        tiles_hash: 1,
                    },
                    tiles: vec![a],
                    aabb_min: a,
                    aabb_max: a,
                    centroid_tile: a,
                });
            idx.tile_to_intersection.insert(a, id_a);
            // Cluster B at (4,0).
            let b = TilePos { x: 4, y: 0 };
            let id_b = IntersectionId(1);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id: id_b,
                    key: IntersectionKey {
                        aabb_min: b,
                        aabb_max: b,
                        tile_count: 1,
                        tiles_hash: 2,
                    },
                    tiles: vec![b],
                    aabb_min: b,
                    aabb_max: b,
                    centroid_tile: b,
                });
            idx.tile_to_intersection.insert(b, id_b);
            idx
        })
        .insert_resource({
            let mut occ = TrafficOccupancy::default();
            occ.ensure_len(6);
            // Jam the link tile RIGHT BEFORE cluster B (x=3): occ == cap (TwoLane => 2).
            // exit-of-A (x=2) stays FREE so the OLD single-exit-tile gate would still admit.
            let jam = TilePos { x: 3, y: 0 };
            let jam_idx = (jam.x as usize) + (jam.y as usize) * 6;
            occ.per_tick_vehicles[jam_idx] = RoadKind::TwoLane.capacity_per_lane_tile();
            occ
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let id_a = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(TilePos { x: 1, y: 0 })
        .unwrap();
    let key_a = app
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
                TilePos { x: 4, y: 0 },
                TilePos { x: 5, y: 0 },
            ],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
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
            VehicleTrafficState::Stopped {
                intersection: key_a,
                stop_tile: TilePos { x: 0, y: 0 },
                queue_position: 0,
            },
        ))
        .id();

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        !res.is_reserved_by(id_a, e),
        "vehicle must NOT be admitted into cluster A: the link tile toward cluster B is jammed \
         (cross-intersection spillback), even though A's own exit tile is free"
    );
}

#[test]
fn sustained_downstream_jam_force_admits_one_car_via_escape_valve() {
    // Same 2-intersection chain as downstream_jammed_link_..., but the link toward cluster B stays
    // jammed indefinitely (cyclic-deadlock proxy: occupancy never drains because nothing moves it).
    // The downstream-link gate refuses admission EVERY tick, so without an escape valve the upstream
    // intersection would never admit anyone -> permanent freeze. The starvation-free escape valve
    // must force-admit ONE car once the cluster has been capacity-starved for
    // INTERSECTION_STALL_FORCE_TICKS consecutive ticks, breaking the circular wait.
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 6,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(6, 1);
            for (pos, dir) in [
                (TilePos { x: 0, y: 0 }, RoadDir::East), // approach
                (TilePos { x: 1, y: 0 }, RoadDir::None), // cluster A
                (TilePos { x: 2, y: 0 }, RoadDir::East), // exit-of-A / link tile 1
                (TilePos { x: 3, y: 0 }, RoadDir::East), // link tile 2 (jammed)
                (TilePos { x: 4, y: 0 }, RoadDir::None), // cluster B
                (TilePos { x: 5, y: 0 }, RoadDir::East), // exit-of-B
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
            let mut idx = IntersectionIndex::default();
            let a = TilePos { x: 1, y: 0 };
            let id_a = IntersectionId(0);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id: id_a,
                    key: IntersectionKey {
                        aabb_min: a,
                        aabb_max: a,
                        tile_count: 1,
                        tiles_hash: 1,
                    },
                    tiles: vec![a],
                    aabb_min: a,
                    aabb_max: a,
                    centroid_tile: a,
                });
            idx.tile_to_intersection.insert(a, id_a);
            let b = TilePos { x: 4, y: 0 };
            let id_b = IntersectionId(1);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id: id_b,
                    key: IntersectionKey {
                        aabb_min: b,
                        aabb_max: b,
                        tile_count: 1,
                        tiles_hash: 2,
                    },
                    tiles: vec![b],
                    aabb_min: b,
                    aabb_max: b,
                    centroid_tile: b,
                });
            idx.tile_to_intersection.insert(b, id_b);
            idx
        })
        .insert_resource({
            let mut occ = TrafficOccupancy::default();
            occ.ensure_len(6);
            let jam = TilePos { x: 3, y: 0 };
            let jam_idx = (jam.x as usize) + (jam.y as usize) * 6;
            occ.per_tick_vehicles[jam_idx] = RoadKind::TwoLane.capacity_per_lane_tile();
            occ
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let id_a = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(TilePos { x: 1, y: 0 })
        .unwrap();
    let key_a = app
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
                TilePos { x: 4, y: 0 },
                TilePos { x: 5, y: 0 },
            ],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
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
            VehicleTrafficState::Stopped {
                intersection: key_a,
                stop_tile: TilePos { x: 0, y: 0 },
                queue_position: 0,
            },
        ))
        .id();

    // Tick 1: the valve must NOT fire prematurely — single-tick behavior stays "refuse".
    app.update();
    assert!(
        !app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(id_a, e),
        "escape valve must not fire on the first stalled tick (would defeat spillback protection)"
    );

    // Keep stalling well past the threshold. The valve fires once the cluster has been
    // capacity-starved for INTERSECTION_STALL_FORCE_TICKS consecutive ticks.
    for _ in 0..(crate::game::traffic::INTERSECTION_STALL_FORCE_TICKS + 2) {
        app.update();
    }

    assert!(
        app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(id_a, e),
        "after sustained downstream-jam starvation the escape valve must force-admit the car to \
         break the cross-intersection circular wait"
    );
}

/// A single approaching vehicle must accumulate at most ONE reservation per intersection across
/// multiple plan_intersection_reservations ticks while it stays stationary on the approach tile.
///
/// Live evidence: a vehicle held 11 near-identical Approaching reservations (one per 0.1 s tick)
/// because the candidate-emission path never checked is_reserved_by before pushing a fresh
/// candidate → apply() happily pushed another Approaching entry each tick.
///
/// After the fix the Vec length must be exactly 1 after 3 ticks.
#[test]
fn approaching_vehicle_accumulates_at_most_one_reservation_across_ticks() {
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
    let e = app
        .world_mut()
        .spawn((
            vehicle,
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: approach,
                queue_position: 0,
            },
        ))
        .id();

    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();

    // Run the full collect→apply pipeline 3 times without moving the vehicle.
    app.update();
    app.update();
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let count = res
        .by_intersection
        .get(&id)
        .map(|v| v.iter().filter(|r| r.vehicle == e).count())
        .unwrap_or(0);
    assert_eq!(
        count, 1,
        "approaching vehicle must hold exactly 1 reservation after 3 ticks, got {count}"
    );
}

#[test]
fn downstream_free_link_allows_admission_into_upstream_intersection() {
    // Same 2-intersection chain, but the link toward B is EMPTY -> admission MUST succeed.
    // Contrast case proving P1-1 does not over-block when the downstream link has room.
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 6,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(6, 1);
            for (pos, dir) in [
                (TilePos { x: 0, y: 0 }, RoadDir::East),
                (TilePos { x: 1, y: 0 }, RoadDir::None),
                (TilePos { x: 2, y: 0 }, RoadDir::East),
                (TilePos { x: 3, y: 0 }, RoadDir::East),
                (TilePos { x: 4, y: 0 }, RoadDir::None),
                (TilePos { x: 5, y: 0 }, RoadDir::East),
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
            let mut idx = IntersectionIndex::default();
            let a = TilePos { x: 1, y: 0 };
            let id_a = IntersectionId(0);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id: id_a,
                    key: IntersectionKey {
                        aabb_min: a,
                        aabb_max: a,
                        tile_count: 1,
                        tiles_hash: 1,
                    },
                    tiles: vec![a],
                    aabb_min: a,
                    aabb_max: a,
                    centroid_tile: a,
                });
            idx.tile_to_intersection.insert(a, id_a);
            let b = TilePos { x: 4, y: 0 };
            let id_b = IntersectionId(1);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id: id_b,
                    key: IntersectionKey {
                        aabb_min: b,
                        aabb_max: b,
                        tile_count: 1,
                        tiles_hash: 2,
                    },
                    tiles: vec![b],
                    aabb_min: b,
                    aabb_max: b,
                    centroid_tile: b,
                });
            idx.tile_to_intersection.insert(b, id_b);
            idx
        })
        .insert_resource({
            let mut occ = TrafficOccupancy::default();
            occ.ensure_len(6); // all link tiles free
            occ
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let id_a = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(TilePos { x: 1, y: 0 })
        .unwrap();
    let key_a = app
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
                TilePos { x: 4, y: 0 },
                TilePos { x: 5, y: 0 },
            ],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
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
            VehicleTrafficState::Stopped {
                intersection: key_a,
                stop_tile: TilePos { x: 0, y: 0 },
                queue_position: 0,
            },
        ))
        .id();

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(id_a, e),
        "vehicle MUST be admitted: the downstream link toward cluster B has free capacity"
    );
}

#[test]
fn diagonal_cluster_exit_is_admitted_not_refused_no_zones() {
    // Regression: a multi-tile intersection cluster whose lane route EXITS diagonally produces an
    // undeterminable exit direction (dir_between_adjacent returns None for a non-orthogonal step).
    // The admission gate then called reservation_zones_for_maneuver(entry, None) -> None and refused
    // the vehicle ("no_zones") on EVERY tick, so cars routed through the big cluster (live:
    // intersection 7, a 4x6 block) could never enter -> permanent admission deadlock. A vehicle that
    // is already routed THROUGH the cluster must be admitted (exclusively, via the ZONE_ALL fallback)
    // rather than refused forever.
    //
    // Route through a 2-tile cluster that exits diagonally:
    //   (4,3) approach -> (3,3) cluster -> (3,2) cluster -> (4,1) exit  [ (3,2)->(4,1) is diagonal ]
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
        .insert_resource({
            let mut grid = MapGrid::new(6, 6);
            for (pos, dir) in [
                (TilePos { x: 4, y: 3 }, RoadDir::West),  // approach
                (TilePos { x: 3, y: 3 }, RoadDir::None),  // cluster tile
                (TilePos { x: 3, y: 2 }, RoadDir::None),  // cluster tile
                (TilePos { x: 4, y: 1 }, RoadDir::North), // exit (diagonal from (3,2))
                (TilePos { x: 4, y: 0 }, RoadDir::North), // downstream link
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
            let mut idx = IntersectionIndex::default();
            let a = TilePos { x: 3, y: 3 };
            let b = TilePos { x: 3, y: 2 };
            let id = IntersectionId(0);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key: IntersectionKey {
                        aabb_min: b,
                        aabb_max: a,
                        tile_count: 2,
                        tiles_hash: 7,
                    },
                    tiles: vec![a, b],
                    aabb_min: b,
                    aabb_max: a,
                    centroid_tile: a,
                });
            idx.tile_to_intersection.insert(a, id);
            idx.tile_to_intersection.insert(b, id);
            idx
        })
        .insert_resource({
            let mut occ = TrafficOccupancy::default();
            occ.ensure_len(36);
            occ
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(TilePos { x: 3, y: 3 })
        .unwrap();

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 4, y: 3 },
                TilePos { x: 3, y: 3 },
                TilePos { x: 3, y: 2 },
                TilePos { x: 4, y: 1 },
                TilePos { x: 4, y: 0 },
            ],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let e = app
        .world_mut()
        .spawn((vehicle, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(id, e),
        "vehicle routed to exit the cluster diagonally must be admitted (ZONE_ALL fallback), not \
         refused forever with no_zones"
    );
}
