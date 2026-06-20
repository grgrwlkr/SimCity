//! Tests for basic vehicle behavior: trip completion, stop sign interactions, and fundamental intersection mechanics.

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

    let citizen = CitizenId(42);
    let vehicle_component = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut path_pool, vec![], 0, 0.0, 0.0, 60.0, 20.0, 1.0)
    };
    let vehicle = app
        .world_mut()
        .spawn((
            vehicle_component,
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
        .insert_resource(crate::game::transport::PathPool::default())
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
    let vehicle_component = {
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
    let vehicle = app
        .world_mut()
        .spawn((
            vehicle_component,
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: approach,
                queue_position: 0,
            },
        ))
        .id();

    // Tick 1: released to CrossingIntersection.
    app.update();
    let state1 = app.world().get::<VehicleTrafficState>(vehicle).copied();
    assert_eq!(
        state1,
        Some(VehicleTrafficState::CrossingIntersection { intersection: key })
    );

    // Tick 2: must stay in CrossingIntersection while still on the approach tile (no oscillation).
    app.update();
    let state2 = app.world().get::<VehicleTrafficState>(vehicle).copied();
    assert_eq!(
        state2,
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
        .insert_resource(crate::game::transport::PathPool::default())
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

    let vehicle_component = {
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
            vehicle_component,
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

/// Overlap-clamp test scaffold: a 4-tile straight `SixLane` road and a `TrafficConfig` tuned so a
/// single 0.1s step carries the follower FAR past the safe gap if the hard clamp is absent.
///
/// Unit math (tile_size=16, tile_meters=1.0 ⇒ world_per_meter = 16):
///   * v0 (SixLane 80 km/h)   = (80/3.6) * 16 ≈ 355.6 world/s ⇒ dprog ≈ 2.22 tiles per 0.1s step.
///   * idm_min_gap_m = 0       ⇒ s0 = 0 ⇒ min_gap_tiles = VEHICLE_VISUAL_LENGTH_TILES = 1.4 tiles.
/// IDM's max decel (b_max = 7*16 = 112 world/s²) cannot brake 355 world/s down enough in one step,
/// so soft braking is insufficient — only the hard clamp prevents the overlap.
fn overlap_clamp_app() -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
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
            for x in 0..4i32 {
                let pos = TilePos { x, y: 0 };
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::SixLane,
                    dir: RoadDir::East,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
            }
            grid
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig {
            // Small tile_meters inflates world-space speeds (large overshoot) while idm_min_gap_m=0
            // keeps min_gap_tiles == VEHICLE_VISUAL_LENGTH_TILES (1.4), so leader_pos - min_gap is
            // achievable for a next-tile leader and the strict invariant is testable.
            tile_meters: 1.0,
            idm_min_gap_m: 0.0,
            ..TrafficConfig::default()
        })
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());
    app
}

/// Bumper-to-bumper minimum gap (tiles) for the `overlap_clamp_app` config.
/// Mirrors `drive.rs`: (s0 + VEHICLE_VISUAL_LENGTH_TILES * tile_size) / tile_size, s0 = 0 here.
const TEST_MIN_GAP_TILES: f32 = VEHICLE_VISUAL_LENGTH_TILES; // 1.4

fn route_4() -> Vec<TilePos> {
    vec![
        TilePos { x: 0, y: 0 },
        TilePos { x: 1, y: 0 },
        TilePos { x: 2, y: 0 },
        TilePos { x: 3, y: 0 },
    ]
}

#[test]
fn same_tile_follower_cannot_overlap_leader_after_large_step() {
    use std::time::Duration;
    let mut app = overlap_clamp_app();
    let route = route_4();

    // Leader: stationary near the FAR edge of the same tile (progress 0.95).
    let leader_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pp, route.clone(), 0, 0.95, 0.0, 400.0, 50.0, 1.0)
    };
    let _leader = app
        .world_mut()
        .spawn((leader_comp, VehicleTrafficState::FreeFlow))
        .id();

    // Ego: behind on the same tile (progress 0.0) with a huge initial speed so an unclamped
    // forward-Euler step would sail past the leader.
    let ego_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pp, route.clone(), 0, 0.0, 400.0, 400.0, 50.0, 1.35)
    };
    let ego = app
        .world_mut()
        .spawn((ego_comp, VehicleTrafficState::FreeFlow))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));

    app.update();

    let ego_v = app.world().get::<Vehicle>(ego).unwrap();
    assert_eq!(
        ego_v.path_cursor, 0,
        "ego left the tile; test setup invalid"
    );

    // Continuous longitudinal positions (path_cursor + progress, tile units).
    let leader_pos = 0.0 + 0.95;
    let follower_pos = ego_v.path_cursor as f32 + ego_v.progress;
    // No-overlap invariant: follower must keep at least min_gap behind the leader.
    // For a same-tile leader min_gap (1.4) > max same-tile separation (1.0), so the achievable
    // floor is prev_p (0.0) — the clamp must at minimum FREEZE the follower (no advance into the
    // leader). Without the clamp the follower advances ~2.2 tiles and overlaps.
    let bound = (leader_pos - TEST_MIN_GAP_TILES).max(0.0);
    assert!(
        follower_pos <= bound + 1e-4,
        "same-tile overlap: follower_pos={follower_pos} > leader_pos-min_gap(max prev_p)={bound}"
    );
}

#[test]
fn next_tile_follower_cannot_overlap_boundary_crossing_leader() {
    use std::time::Duration;
    let mut app = overlap_clamp_app();
    let route = route_4();

    // Leader: stationary on the NEXT tile (cursor 1), near its far edge (progress 0.9).
    // Continuous pos = 1 + 0.9 = 1.9; safe follower bound = 1.9 - 1.4 = 0.5.
    let leader_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pp, route.clone(), 1, 0.9, 0.0, 400.0, 50.0, 1.0)
    };
    let _leader = app
        .world_mut()
        .spawn((leader_comp, VehicleTrafficState::FreeFlow))
        .id();

    // Ego: on the current tile near the boundary (progress 0.0) with a huge speed. Unclamped, one
    // step (~2.2 tiles) would carry it onto/over the leader; only the hard clamp holds it at 0.5.
    let ego_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pp, route.clone(), 0, 0.0, 400.0, 400.0, 50.0, 1.35)
    };
    let ego = app
        .world_mut()
        .spawn((ego_comp, VehicleTrafficState::FreeFlow))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));

    app.update();

    let ego_v = app.world().get::<Vehicle>(ego).unwrap();
    // Continuous longitudinal positions.
    let leader_pos = 1.0 + 0.9;
    let follower_pos = ego_v.path_cursor as f32 + ego_v.progress;
    let bound = leader_pos - TEST_MIN_GAP_TILES; // 0.5, achievable here
    // Strict continuous no-overlap invariant.
    assert!(
        follower_pos <= bound + 1e-4,
        "next-tile overlap: follower_pos={follower_pos} > leader_pos-min_gap={bound}"
    );
    // And it must NOT be a full freeze — the clamp should let it advance up to the safe bound,
    // proving the bound (not mere leader-presence) is what binds.
    assert!(
        follower_pos > 0.3,
        "follower frozen ({follower_pos}); expected to advance to the safe bound ~0.5"
    );
}

#[test]
fn free_flow_follower_not_throttled_by_clamp() {
    use std::time::Duration;
    let mut app = overlap_clamp_app();
    let route = route_4();

    // No leader at all. The follower must accelerate/advance under pure IDM free-flow; the clamp
    // (no leader_cap) must be a strict no-op. Reuse modest values so it stays on its tile this step.
    // v0 (SixLane) ≈ 355 world/s; start from a moderate speed so one step doesn't leave the tile.
    let ego_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        // speed 40 world/s ⇒ dprog = 40*0.1/16 = 0.25 tiles; no leader ⇒ clamp must not touch it.
        create_vehicle_with_route(&mut pp, route.clone(), 0, 0.0, 40.0, 400.0, 50.0, 1.0)
    };
    let ego = app
        .world_mut()
        .spawn((ego_comp, VehicleTrafficState::FreeFlow))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));

    app.update();

    let ego_v = app.world().get::<Vehicle>(ego).unwrap();
    assert_eq!(
        ego_v.path_cursor, 0,
        "ego left the tile; test setup invalid"
    );
    // Free-flow: must advance roughly the kinematic distance and speed must not be throttled below
    // the initial value (IDM accelerates toward v0; the clamp adds no artificial crawl).
    assert!(
        ego_v.progress > 0.2,
        "free-flow follower under-advanced ({}); clamp wrongly throttled it",
        ego_v.progress
    );
    assert!(
        ego_v.speed >= 40.0,
        "free-flow speed throttled to {} (< initial 40); clamp must be a no-op without a leader",
        ego_v.speed
    );
}
