//! Tests for basic vehicle behavior: trip completion and fundamental intersection mechanics.

use super::*;

#[test]
fn vehicle_arrival_emits_trip_finished() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .init_resource::<RouteProducerStats>()
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

/// REPRO (live freeze, Day 69): a permanent off-intersection gridlock formed from two same-direction
/// vehicles on adjacent lanes whose routes SWAP the same pair of tiles — each one's next tile is the
/// tile the other currently occupies. Both are held at speed 0 forever by the car-following
/// next-tile leader (each is the other's zero-gap leader), and nothing arbitrates a 2-cycle tile
/// swap off an intersection (reservations only govern intersection tiles).
///
/// Two westbound lanes y=0 / y=1 (both dir=West). Vehicle A sits on (2,0) and its route changes lane
/// to (2,1) then continues west. Vehicle B sits on (2,1) and its route changes lane to (2,0) then
/// continues west. A wants B's tile, B wants A's tile.
///
/// This is the integration repro that the earlier (reservation-only) test never exercised: it runs
/// the real `move_vehicles` movement tick. It asserts the DESIRED behavior — at least one vehicle
/// eventually breaks the swap and advances — so it FAILS today (both pinned at cursor 0) and must
/// pass once a tile-swap deadlock breaker exists.
#[test]
fn lateral_tile_swap_on_same_direction_lanes_does_not_deadlock_forever() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 4,
            height: 2,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(4, 2);
            for y in 0..2i32 {
                for x in 0..4i32 {
                    let pos = TilePos { x, y };
                    let Some(mut cell) = grid.get(pos) else {
                        continue;
                    };
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::West,
                        lane: y as u8,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }
            }
            grid
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .init_resource::<RouteProducerStats>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .insert_resource(FinishCount::default())
        .init_resource::<crate::game::transport::PathfindingConfig>()
        .init_resource::<crate::game::transport::LaneGraph>()
        .init_resource::<crate::game::transport::LaneletGraph>()
        .init_resource::<crate::game::sim::SimRng>()
        .add_systems(
            Update,
            (build_traffic_spatial_index, break_tile_swaps, move_vehicles).chain(),
        );

    // A on (2,0): lane-change to (2,1), then west.
    // B on (2,1): lane-change to (2,0), then west. Each one's next tile holds the other.
    let (a, b) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        let a = create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 2, y: 0 },
                TilePos { x: 2, y: 1 },
                TilePos { x: 1, y: 1 },
                TilePos { x: 0, y: 1 },
            ],
            0,
            0.0,
            0.0,
            60.0,
            20.0,
            1.0,
        );
        let b = create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 2, y: 1 },
                TilePos { x: 2, y: 0 },
                TilePos { x: 1, y: 0 },
                TilePos { x: 0, y: 0 },
            ],
            0,
            0.0,
            0.0,
            60.0,
            20.0,
            1.0,
        );
        (a, b)
    };
    let a = app
        .world_mut()
        .spawn((a, Transform::default(), VehicleTrafficState::FreeFlow))
        .id();
    let b = app
        .world_mut()
        .spawn((b, Transform::default(), VehicleTrafficState::FreeFlow))
        .id();

    for _ in 0..200 {
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();
    }

    let a_cursor = app.world().get::<Vehicle>(a).map(|v| v.path_cursor);
    let b_cursor = app.world().get::<Vehicle>(b).map(|v| v.path_cursor);
    // Despawn-on-arrival counts as "got through" too.
    let a_done = a_cursor.map(|c| c > 0).unwrap_or(true);
    let b_done = b_cursor.map(|c| c > 0).unwrap_or(true);
    assert!(
        a_done || b_done,
        "tile-swap deadlock: both vehicles pinned at cursor 0 after 200 ticks \
         (A={a_cursor:?}, B={b_cursor:?}) — nothing breaks the off-intersection 2-cycle swap"
    );
}

/// The swap breaker must be a strict no-op for normal same-lane queueing: a follower whose next tile
/// is the leader's tile is NOT a mutual swap (the leader's next is a different tile), so neither route
/// may be rewritten.
#[test]
fn swap_breaker_is_inert_for_normal_queueing() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
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
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::West,
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
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .init_resource::<RouteProducerStats>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .insert_resource(FinishCount::default())
        .init_resource::<crate::game::transport::PathfindingConfig>()
        .init_resource::<crate::game::transport::LaneGraph>()
        .init_resource::<crate::game::transport::LaneletGraph>()
        .init_resource::<crate::game::sim::SimRng>()
        .add_systems(
            Update,
            (build_traffic_spatial_index, break_tile_swaps).chain(),
        );

    // A behind B on the same westbound lane: A(3,0)->(2,0)->.., B(2,0)->(1,0)->.. A's next is B's
    // tile, but B's next (1,0) is NOT A's tile (3,0) — normal following, not a swap.
    let (a, b, route_a, route_b) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        let ra = vec![
            TilePos { x: 3, y: 0 },
            TilePos { x: 2, y: 0 },
            TilePos { x: 1, y: 0 },
            TilePos { x: 0, y: 0 },
        ];
        let rb = vec![
            TilePos { x: 2, y: 0 },
            TilePos { x: 1, y: 0 },
            TilePos { x: 0, y: 0 },
        ];
        let a = create_vehicle_with_route(&mut path_pool, ra.clone(), 0, 0.0, 0.0, 60.0, 20.0, 1.0);
        let b = create_vehicle_with_route(&mut path_pool, rb.clone(), 0, 0.0, 0.0, 60.0, 20.0, 1.0);
        (a, b, ra, rb)
    };
    let a = app
        .world_mut()
        .spawn((a, Transform::default(), VehicleTrafficState::FreeFlow))
        .id();
    let b = app
        .world_mut()
        .spawn((b, Transform::default(), VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let read_route = |app: &App, e| {
        let v = app.world().get::<Vehicle>(e).unwrap();
        let pp = app.world().resource::<crate::game::transport::PathPool>();
        (0..pp.len(v.path_handle))
            .filter_map(|i| pp.get_tile(v.path_handle, i))
            .collect::<Vec<_>>()
    };
    assert_eq!(read_route(&app, a), route_a, "follower route was rewritten");
    assert_eq!(read_route(&app, b), route_b, "leader route was rewritten");
}

/// Overlap-clamp test scaffold: a 4-tile straight `SixLane` road and a `TrafficConfig` tuned so a
/// single 0.1s step carries the follower FAR past the safe gap if the hard clamp is absent.
///
/// Unit math (tile_size=16, tile_meters=1.0 ⇒ world_per_meter = 16):
///   * v0 (SixLane 80 km/h)   = (80/3.6) * 16 ≈ 355.6 world/s ⇒ dprog ≈ 2.22 tiles per 0.1s step.
///   * idm_min_gap_m = 0       ⇒ s0 = 0 ⇒ min_gap_tiles = VEHICLE_VISUAL_LENGTH_TILES = 1.4 tiles.
///
/// IDM's max decel (b_max = 7*16 = 112 world/s²) cannot brake 355 world/s down enough in one step,
/// so soft braking is insufficient — only the hard clamp prevents the overlap.
fn overlap_clamp_app() -> App {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .init_resource::<RouteProducerStats>()
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

/// ПДД 8.12: reversing at intersections is prohibited. A stuck vehicle backing along its own route
/// must NOT cross a tile boundary INTO an intersection-box tile (`dir == None`) — that re-enters
/// the box with no reservation (the admission model has no notion of a car backing in) and reads
/// on screen as driving against the intersection's traffic.
///
/// The invariant is STRUCTURAL, not a tile-type check: reverse only moves within the current tile
/// (progress floors at 0.0 and the cursor never decrements — see the reverse branch in
/// movement/drive.rs), so NO tile boundary, box or otherwise, can ever be crossed backwards. This
/// test pins that structure with the worst-case layout: a box tile directly behind a reversing car.
///
/// Layout (all EAST, 6x1): (1,0) = box tile behind ego, ego on (2,0), (3,0) = box tile ahead with
/// NO reservation (permanently `blocked_next` -> stop line), goal (4,0). Ego is stuck past the
/// reverse threshold, so the reverse branch engages.
#[test]
fn stuck_reverse_never_backs_into_intersection_box() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
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
            for x in 0..6i32 {
                let pos = TilePos { x, y: 0 };
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    // (1,0) and (3,0) are intersection-box tiles.
                    dir: if x == 1 || x == 3 {
                        RoadDir::None
                    } else {
                        RoadDir::East
                    },
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
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .init_resource::<RouteProducerStats>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());

    let ego_comp = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 1, y: 0 },
                TilePos { x: 2, y: 0 },
                TilePos { x: 3, y: 0 },
                TilePos { x: 4, y: 0 },
            ],
            1,   // current tile (2,0)
            0.3, // progress: mid-tile, so it must reverse 0.3+ tiles to cross backwards
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((
            ego_comp,
            VehicleTrafficState::FreeFlow,
            crate::game::traffic::stuck::StuckTimer {
                secs: STUCK_REROUTE_SECS + 5.0,
                last_tile: TilePos { x: 2, y: 0 },
                last_progress: 0.3,
            },
        ))
        .id();

    let mut reversed = false;
    for _ in 0..300 {
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();

        let v = app.world().get::<Vehicle>(ego).unwrap();
        reversed |= v.is_reversing;
        assert!(
            v.path_cursor >= 1,
            "stuck reverse backed the vehicle across the boundary into the intersection box \
             tile (1,0) (path_cursor {}, progress {})",
            v.path_cursor,
            v.progress
        );
    }
    assert!(
        reversed,
        "test never engaged the reverse branch; setup is invalid"
    );
}

/// Buses are persistent traffic agents (like service vehicles): reaching the end of a route
/// segment must NOT despawn them — they dwell and re-plan to the next stop instead. Mirror of
/// `vehicle_arrival_emits_trip_finished` but with a `Bus` marker and no `TripPassenger`.
#[test]
fn bus_with_exhausted_path_is_not_despawned_by_move_vehicles() {
    use crate::game::public_transport::{Bus, BusState};

    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
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
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .init_resource::<RouteProducerStats>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());

    // Empty route => path exhausted (arrived).
    let vehicle_component = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut path_pool, vec![], 0, 0.0, 0.0, 60.0, 20.0, 1.0)
    };
    let bus = app
        .world_mut()
        .spawn((
            vehicle_component,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            Bus {
                route_id: 0,
                target_stop_idx: 0,
                state: BusState::Driving,
                wedge_secs: 0.0,
                last_cursor: 0,
                replan_cooldown_secs: 0.0,
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(bus).is_ok(),
        "a bus with an exhausted path must NOT be despawned (it is a persistent agent)"
    );
}
