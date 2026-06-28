//! Flag-ON end-to-end integration test for the lanelet intersection arbiter (P3c gate): build a real
//! cross intersection + lanelet graph, spawn two conflicting approaching vehicles (with EMPTY sidecar
//! plans, so the arbiter's precise-fallback resolves their lanelets from route geometry), run the
//! flag-on arbiter, and assert collision-safety (exactly one admitted), the tripwire stays empty, and
//! the outcome is deterministic across two identical seeded worlds.

use super::*;
use crate::game::intersections::{IntersectionCluster, LeftTurnDemand};
use crate::game::traffic::intersection::{
    ApproachFairness, ArbiterIndexCache, ArbiterTickStats, ClusterStarvation, LaneletStallTracker,
    RingTopologyStatus, arbitrate_lanelet_reservations, cleanup_intersection_reservations,
};
use crate::game::transport::lane_graph::build_lane_graph_inner;
use crate::game::transport::{
    GraphVersion, LaneletConflictMatrices, LaneletGraph, build_lanelet_graph,
};

fn set_cell(grid: &mut MapGrid, pos: TilePos, kind: RoadKind, dir: RoadDir) {
    let Some(mut cell) = grid.get(pos) else {
        return;
    };
    cell.water = false;
    cell.road = RoadCell {
        kind,
        dir,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(pos, cell);
}

/// 9x9 grid with a 2x2 cluster at (4,4),(4,5),(5,4),(5,5); one lane per direction (mirror of the
/// build.rs `build_cross_grid` fixture).
fn cross_grid() -> (MapGrid, IntersectionIndex) {
    let mut grid = MapGrid::new(9, 9);
    for pos in [
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 5, y: 5 },
    ] {
        set_cell(&mut grid, pos, RoadKind::TwoLane, RoadDir::None);
    }
    for x in (0..4).chain(6..9) {
        set_cell(
            &mut grid,
            TilePos { x, y: 4 },
            RoadKind::TwoLane,
            RoadDir::East,
        );
        set_cell(
            &mut grid,
            TilePos { x, y: 5 },
            RoadKind::TwoLane,
            RoadDir::West,
        );
    }
    for y in (0..4).chain(6..9) {
        set_cell(
            &mut grid,
            TilePos { x: 4, y },
            RoadKind::TwoLane,
            RoadDir::North,
        );
        set_cell(
            &mut grid,
            TilePos { x: 5, y },
            RoadKind::TwoLane,
            RoadDir::South,
        );
    }

    let tiles = vec![
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 5, y: 5 },
    ];
    let id = IntersectionId(0);
    let key = IntersectionKey {
        aabb_min: TilePos { x: 4, y: 4 },
        aabb_max: TilePos { x: 5, y: 5 },
        tile_count: 4,
        tiles_hash: 7,
    };
    let mut idx = IntersectionIndex::default();
    idx.clusters.push(IntersectionCluster {
        id,
        key,
        tiles: tiles.clone(),
        aabb_min: TilePos { x: 4, y: 4 },
        aabb_max: TilePos { x: 5, y: 5 },
        centroid_tile: TilePos { x: 4, y: 4 },
    });
    for t in tiles {
        idx.tile_to_intersection.insert(t, id);
    }
    idx.version = 1;
    (grid, idx)
}

/// Build a flag-on arbiter app on the cross grid (build + arbiter + cleanup chained) and spawn an
/// eastbound + a northbound through vehicle, both one tile before the box with EMPTY sidecars (so the
/// arbiter's precise-fallback resolves their lanelets). Their lanelets share the (4,4) entry corner
/// -> they conflict. Returns the app (not yet run) + the (east, north) entities.
fn build_arbiter_app() -> (App, Entity, Entity) {
    let (grid, idx) = cross_grid();
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 9,
            height: 9,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig {
            experimental_lanelet_intersections: true,
            ..Default::default()
        })
        .insert_resource(LaneletGraph::default())
        .insert_resource(LaneletConflictMatrices::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<LeftTurnDemand>()
        .init_resource::<ArbiterIndexCache>()
        .init_resource::<ArbiterTickStats>()
        .init_resource::<ApproachFairness>()
        .init_resource::<ClusterStarvation>()
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>();

    app.add_systems(
        Update,
        (
            build_lanelet_graph,
            arbitrate_lanelet_reservations,
            cleanup_intersection_reservations,
        )
            .chain(),
    );

    let east_route = vec![
        TilePos { x: 3, y: 4 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 6, y: 4 },
    ];
    let north_route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 4, y: 6 },
    ];
    let (ve, vn) = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(&mut pool, east_route, 0, 0.4, 0.0, 60.0, 20.0, 1.0),
            create_vehicle_with_route(&mut pool, north_route, 0, 0.4, 0.0, 60.0, 20.0, 1.0),
        )
    };
    let east = app
        .world_mut()
        .spawn((
            ve,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    let north = app
        .world_mut()
        .spawn((
            vn,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    (app, east, north)
}

fn run_arbiter_once() -> (bool, bool, bool) {
    let (mut app, east, north) = build_arbiter_app();
    app.update();
    let res = app.world().resource::<IntersectionReservations>();
    (
        res.is_reserved_by(IntersectionId(0), east),
        res.is_reserved_by(IntersectionId(0), north),
        res.stall_tripwire(),
    )
}

/// Move a vehicle to a new route cursor (simulates crossing/exiting the box between ticks).
fn set_cursor(app: &mut App, e: Entity, cursor: usize) {
    let mut v = app.world_mut().get_mut::<Vehicle>(e).unwrap();
    v.path_cursor = cursor;
    v.progress = 0.4;
}

#[test]
fn flag_on_arbiter_drains_conflicting_vehicles_over_ticks() {
    let (mut app, east, north) = build_arbiter_app();

    // Tick 1: the arbiter admits exactly one (North wins the post-distance dir tiebreak); East waits.
    app.update();
    {
        let res = app.world().resource::<IntersectionReservations>();
        assert!(res.is_reserved_by(IntersectionId(0), north));
        assert!(!res.is_reserved_by(IntersectionId(0), east));
        assert!(!res.stall_tripwire());
    }

    // Drain North across the box: into the cluster, then out the far side. Cleanup transitions it to
    // Inside, then (once it leaves the cluster) drops its row and releases the ledger holder.
    set_cursor(&mut app, north, 1); // (4,4) — a cluster tile (Inside)
    app.update();
    set_cursor(&mut app, north, 3); // (4,6) — left the cluster (exit lane)
    app.update();

    // After North drains, the previously-blocked East is admitted: serialization clears -> liveness.
    app.update();
    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), east),
        "after North drains, the blocked East is admitted (multi-tick liveness)"
    );
    assert!(
        !res.stall_tripwire(),
        "stall tripwire stays empty across the whole drain"
    );
}

#[test]
fn arbiter_counts_one_straight_admit() {
    let (mut app, _east, _north) = build_arbiter_app();
    app.update();
    let stats = app.world().resource::<ArbiterTickStats>();
    // The cross-grid through movements are straights; exactly one is admitted (collision-safety).
    assert_eq!(stats.admitted_straight, 1, "one straight admitted");
    assert_eq!(stats.admitted, 1);
    assert_eq!(stats.coarse_admits, 0, "resolved lanelets, not coarse");
}

/// Shared helper: build a flag-on arbiter app on the cross grid + spawn ONE vehicle with the given
/// route (cursor 0, progress ~0.4, empty `VehicleLaneletPlan`). Returns `(app, entity)`.
///
/// Use this for single-vehicle maneuver tests (left turn, U-turn, etc.) to avoid copy-pasting the
/// ~40-line resource-setup block. The two-vehicle conflict tests keep `build_arbiter_app` as-is.
fn build_single_vehicle_arbiter_app(route: Vec<TilePos>) -> (App, Entity) {
    let (grid, idx) = cross_grid();
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 9,
            height: 9,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig {
            experimental_lanelet_intersections: true,
            ..Default::default()
        })
        .insert_resource(LaneletGraph::default())
        .insert_resource(LaneletConflictMatrices::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<LeftTurnDemand>()
        .init_resource::<ArbiterIndexCache>()
        .init_resource::<ArbiterTickStats>()
        .init_resource::<ApproachFairness>()
        .init_resource::<ClusterStarvation>()
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>();

    app.add_systems(
        Update,
        (
            build_lanelet_graph,
            arbitrate_lanelet_reservations,
            cleanup_intersection_reservations,
        )
            .chain(),
    );

    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, route, 0, 0.4, 0.0, 60.0, 20.0, 1.0)
    };
    let entity = app
        .world_mut()
        .spawn((
            v,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();

    (app, entity)
}

/// A lone northbound vehicle whose route turns LEFT (exits West onto y=5) — with an empty sidecar
/// (precise-fallback resolves the lanelet from route geometry). No conflicting traffic, no lights →
/// it MUST be admitted as a LEFT lanelet, not coarse.
#[test]
fn left_turn_resolves_as_lanelet_not_coarse() {
    // Northbound left-turn route: approach from y=3, cross box, exit West to (3,5).
    // entry_dir=North, North.left()=West => ManeuverKind::LeftTurn.
    let left_route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];

    let (mut app, left_vehicle) = build_single_vehicle_arbiter_app(left_route);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), left_vehicle),
        "lone left-turning vehicle must be admitted (no conflict)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");

    let stats = app.world().resource::<ArbiterTickStats>();
    assert!(
        stats.admitted_left >= 1,
        "admitted_left must be >= 1 (resolved as LEFT lanelet, not mislabeled); got {:?}",
        stats.admitted_left
    );
    assert_eq!(
        stats.coarse_admits, 0,
        "coarse_admits must be 0 (real lanelet, not coarse fallback)"
    );
}

/// A lone northbound U-turn vehicle — entry North (x=4), exit South (x=5, heading south), route
/// pivots through the centroid (4,4). No conflicting traffic, no lights → admitted as `UTurn`
/// lanelet, not coarse.
///
/// Route geometry (derived from `cross_grid`):
///   (4,3) North approach → (4,4) entry cluster tile → (5,4) centroid/pivot → (5,3) exit (South).
/// entry_dir=North, exit_dir=South = North.opposite() => ManeuverKind::UTurn.
#[test]
fn uturn_resolves_as_lanelet_not_coarse() {
    // Northbound U-turn: enter North lane at x=4, exit South lane at x=5.
    let uturn_route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 5, y: 3 },
    ];

    let (mut app, uturn_vehicle) = build_single_vehicle_arbiter_app(uturn_route);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), uturn_vehicle),
        "lone U-turning vehicle must be admitted (no conflict)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");

    let stats = app.world().resource::<ArbiterTickStats>();
    assert!(
        stats.admitted_uturn >= 1,
        "admitted_uturn must be >= 1 (resolved as UTurn lanelet, not mislabeled); got {:?}",
        stats.admitted_uturn
    );
    assert_eq!(
        stats.coarse_admits, 0,
        "coarse_admits must be 0 (real lanelet, not coarse fallback)"
    );
}

/// Forcing fixture for the unresolved-TURN case: same cross grid, but the northbound approach lane
/// adjacent to the box (4,3) is made `StraightOnly` BEFORE the lane/lanelet graph is built. With the
/// lane policy now permitting left turns from a Regular lane, a left lanelet would normally build; a
/// `StraightOnly` approach lane suppresses it (`lane_allows_maneuver(StraightOnly, LeftTurn) == false`).
/// The WEST exit road still exists, so a northbound-left route has `exit_dir = West` => a real
/// `LeftTurn` maneuver whose lanelet cannot resolve (no left lanelet, empty sidecar). Returns
/// `(app, entity)` for the lone northbound-left vehicle.
fn build_unresolved_left_arbiter_app(route: Vec<TilePos>) -> (App, Entity) {
    let (mut grid, idx) = cross_grid();
    // Make the northbound approach lane adjacent to the box turn-only-straight so NO left lanelet
    // builds from it. set_cell would reset lane_type to Regular, so mutate the cell directly.
    if let Some(mut cell) = grid.get(TilePos { x: 4, y: 3 }) {
        cell.road.lane_type = LaneType::StraightOnly;
        grid.set(TilePos { x: 4, y: 3 }, cell);
    }
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 9,
            height: 9,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig {
            experimental_lanelet_intersections: true,
            ..Default::default()
        })
        .insert_resource(LaneletGraph::default())
        .insert_resource(LaneletConflictMatrices::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<LeftTurnDemand>()
        .init_resource::<ArbiterIndexCache>()
        .init_resource::<ArbiterTickStats>()
        .init_resource::<ApproachFairness>()
        .init_resource::<ClusterStarvation>()
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>();

    app.add_systems(
        Update,
        (
            build_lanelet_graph,
            arbitrate_lanelet_reservations,
            cleanup_intersection_reservations,
        )
            .chain(),
    );

    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, route, 0, 0.4, 0.0, 60.0, 20.0, 1.0)
    };
    let entity = app
        .world_mut()
        .spawn((
            v,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();

    (app, entity)
}

/// A northbound LEFT-turn vehicle whose left lanelet cannot resolve (the approach lane is
/// `StraightOnly`, so no left lanelet was built, and the sidecar is empty). The unresolved TURN must
/// NOT barge the whole box via coarse — it stays unadmitted and is handed to the stall tracker for a
/// reroute. RED before the fix (the unresolved left was coarse-admitted: `coarse_admits == 1`,
/// reserved); GREEN after.
#[test]
fn unresolved_turn_is_not_coarse_admitted() {
    // Northbound left-turn route: approach from y=3 (StraightOnly lane), cross box, exit West to (3,5).
    let left_route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];

    let (mut app, v) = build_unresolved_left_arbiter_app(left_route);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        !res.is_reserved_by(IntersectionId(0), v),
        "an unresolved TURN must NOT be admitted (no coarse whole-box barge onto the oncoming lane)"
    );

    let stats = app.world().resource::<ArbiterTickStats>();
    assert_eq!(
        stats.coarse_admits, 0,
        "an unresolved TURN must NOT be coarse-admitted"
    );

    let tracker = app.world().resource::<LaneletStallTracker>();
    assert!(
        tracker.unresolved.contains_key(&v),
        "the unresolved-turn entity must be handed to the stall tracker for reroute"
    );
}

/// A northbound left-turning vehicle PLUS an active pedestrian crossing the exit road (West
/// crosswalk, axis_ns=true). ПДД 13.1: the turning vehicle must YIELD to the pedestrian on the
/// road it turns onto. The West crosswalk is crosswalk index 0 in the conflict matrix (emission
/// order: West=0, East=1, South=2, North=3 per `crosswalk_cells`). axis_ns=true activates
/// West/East crosswalks. The left-turn lanelet's internal path crosses the West boundary cells of
/// the cluster → its conflict row has the West crosswalk bit set → `try_admit` refuses it.
///
/// If GREEN on first run: the existing matrix already covers the exit crosswalk (lock-in only).
/// If RED: the turn lanelet's conflict row does NOT include the exit crosswalk bit — matrix fix
/// needed (Step 3 of task-4.1-brief).
#[test]
fn turning_vehicle_yields_to_pedestrian_on_exit_crosswalk() {
    use crate::game::pedestrians::PedestrianCrossing;

    // Same left-turn route as `left_turn_resolves_as_lanelet_not_coarse`: northbound → exits West.
    // The exit crosswalk is the WEST side of the cluster (crosswalk_cells index 0).
    let left_route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];

    let (mut app, left_vehicle) = build_single_vehicle_arbiter_app(left_route);

    // axis_ns=true: pedestrian moving N/S → occupies West + East crosswalks.
    // The left-turner exits across the WEST crosswalk → must be blocked.
    app.world_mut().spawn(PedestrianCrossing {
        intersection_id: IntersectionId(0),
        axis_ns: true,
    });

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        !res.is_reserved_by(IntersectionId(0), left_vehicle),
        "turning vehicle must NOT be admitted when a pedestrian is crossing the exit crosswalk (ПДД 13.1 yield)"
    );

    let stats = app.world().resource::<ArbiterTickStats>();
    assert!(
        stats.refused_matrix >= 1 || stats.yield_refusals >= 1,
        "the refusal must come from the conflict matrix (ped_mask overlap) or yield gate; refused_matrix={}, yield_refusals={}",
        stats.refused_matrix,
        stats.yield_refusals,
    );
}

// ---------------------------------------------------------------------------------------------
// Admission invariants ported from the legacy reservation pipeline (Task 5.1). Each block below
// replaces a legacy test that drove the now-dead collect/apply producer; the invariant is
// re-asserted against the LIVE arbiter chain (build → arbitrate → cleanup).
// ---------------------------------------------------------------------------------------------

/// Manual grid index (cross_grid is 9 wide), matching the legacy tests' `x + y*width` convention.
fn grid_idx(pos: TilePos) -> usize {
    (pos.x as usize) + (pos.y as usize) * 9
}

/// Build the standard flag-on arbiter app on `cross_grid` (build → arbitrate → cleanup chained) but
/// allow the caller to mutate the freshly-built resources before vehicles are spawned (jam a tile,
/// add a traffic light, etc.). Returns the app with no vehicles spawned yet.
fn build_bare_arbiter_app(customize: impl FnOnce(&mut App)) -> App {
    let (grid, idx) = cross_grid();
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 9,
            height: 9,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig {
            experimental_lanelet_intersections: true,
            ..Default::default()
        })
        .insert_resource(LaneletGraph::default())
        .insert_resource(LaneletConflictMatrices::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<LeftTurnDemand>()
        .init_resource::<ArbiterIndexCache>()
        .init_resource::<ArbiterTickStats>()
        .init_resource::<ApproachFairness>()
        .init_resource::<ClusterStarvation>()
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>();

    app.add_systems(
        Update,
        (
            build_lanelet_graph,
            arbitrate_lanelet_reservations,
            cleanup_intersection_reservations,
        )
            .chain(),
    );

    customize(&mut app);
    app
}

/// Spawn an eastbound through vehicle (cursor 0, progress 0.4, empty sidecar) on the given route and
/// return its entity. The eastbound straight route's box-exit tile is (6,4).
fn spawn_east_through(app: &mut App) -> Entity {
    let east_route = vec![
        TilePos { x: 3, y: 4 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 6, y: 4 },
    ];
    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, east_route, 0, 0.4, 0.0, 60.0, 20.0, 1.0)
    };
    app.world_mut()
        .spawn((
            v,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id()
}

/// Ported from `intersection_reservations::straight_stream_allows_multiple_vehicles_to_reserve_concurrently`.
/// Invariant: two vehicles in the SAME through stream (both eastbound straight, same lanelet) are
/// admitted concurrently — the arbiter does not impose an artificial one-car-at-a-time rule on a
/// non-conflicting stream. Same-lanelet rows don't conflict in the matrix, so both reserve.
#[test]
fn same_through_stream_admits_both_vehicles_concurrently() {
    let mut app = build_bare_arbiter_app(|_| {});
    // Two eastbound through vehicles on the identical route (same entry lane → same lanelet).
    let e1 = spawn_east_through(&mut app);
    let e2 = spawn_east_through(&mut app);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), e1) && res.is_reserved_by(IntersectionId(0), e2),
        "two same-stream straights must both be admitted (no artificial serialization)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

/// Ported from `intersection_reservations::left_turn_conflicts_with_straight_flow` and
/// `conflict_zones::intersection_single_tile_blocks_two_crossing_left_turns` /
/// `intersection_per_tile_blocks_two_crossing_left_turns_through_center` /
/// `intersection_reservations::perpendicular_stuck_cars...`.
/// Invariant (collision-safety): two maneuvers whose internal paths cross the same box cells are NOT
/// both admitted in one tick. Here a northbound LEFT turn (exits West) physically sweeps across the
/// eastbound straight's path; the higher-priority straight wins, the crossing left yields. The matrix
/// — not a coarse zone mask — enforces this.
#[test]
fn crossing_left_yields_to_perpendicular_straight() {
    let mut app = build_bare_arbiter_app(|_| {});
    let straight = spawn_east_through(&mut app);
    // Northbound left turn: approach y=3, cross box, exit West to (3,5).
    let left_route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];
    let left = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        let v = create_vehicle_with_route(&mut pool, left_route, 0, 0.4, 0.0, 60.0, 20.0, 1.0);
        app.world_mut()
            .spawn((
                v,
                VehicleTrafficState::FreeFlow,
                VehicleLaneletPlan::default(),
            ))
            .id()
    };
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        !(res.is_reserved_by(IntersectionId(0), straight)
            && res.is_reserved_by(IntersectionId(0), left)),
        "a straight and a crossing left turn must not both be admitted (collision-safety)"
    );
    assert!(
        res.is_reserved_by(IntersectionId(0), straight),
        "the higher-priority straight is admitted; the crossing left yields"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

/// Ported from `conflict_zones::intersection_conflict_zones_allow_two_opposite_straights`.
/// Invariant: two OPPOSITE through straights (eastbound on y=4, westbound on y=5) use disjoint box
/// cells and are both admitted in one tick — opposite straights never conflict.
#[test]
fn two_opposite_straights_both_admitted() {
    let mut app = build_bare_arbiter_app(|_| {});
    let east = spawn_east_through(&mut app);
    // Westbound through on the y=5 lane: (6,5) → (5,5),(4,5) → (3,5).
    let west_route = vec![
        TilePos { x: 6, y: 5 },
        TilePos { x: 5, y: 5 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];
    let west = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        let v = create_vehicle_with_route(&mut pool, west_route, 0, 0.4, 0.0, 60.0, 20.0, 1.0);
        app.world_mut()
            .spawn((
                v,
                VehicleTrafficState::FreeFlow,
                VehicleLaneletPlan::default(),
            ))
            .id()
    };
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), east) && res.is_reserved_by(IntersectionId(0), west),
        "two opposite through straights must both be admitted (disjoint box cells)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

/// Ported from `conflict_zones::intersection_single_tile_blocks_two_crossing_left_turns` and
/// `intersection_per_tile_blocks_two_crossing_left_turns_through_center`.
/// Invariant (collision-safety): two crossing LEFT turns whose internal paths both traverse the box
/// center must NOT both be admitted — even though a coarse zone mask reported their NW/NE zones as
/// disjoint. The geometric conflict matrix blocks the double-admit; exactly one holds the box.
#[test]
fn two_crossing_left_turns_not_double_admitted() {
    let mut app = build_bare_arbiter_app(|_| {});
    // Northbound left: (4,3) → box → exit West (3,5).
    let north_left = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];
    // Eastbound left: (3,4) → box → exit North (4,6).
    let east_left = vec![
        TilePos { x: 3, y: 4 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 4, y: 6 },
    ];
    let (a, b) = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(&mut pool, north_left, 0, 0.4, 0.0, 60.0, 20.0, 1.0),
            create_vehicle_with_route(&mut pool, east_left, 0, 0.4, 0.0, 60.0, 20.0, 1.0),
        )
    };
    let ea = app
        .world_mut()
        .spawn((
            a,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    let eb = app
        .world_mut()
        .spawn((
            b,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let admitted = usize::from(res.is_reserved_by(IntersectionId(0), ea))
        + usize::from(res.is_reserved_by(IntersectionId(0), eb));
    assert_eq!(
        admitted, 1,
        "crossing left turns through the box center must not double-admit (collision-safety)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

/// Ported from `intersection_reservations::approaching_vehicle_accumulates_at_most_one_reservation_across_ticks`.
/// Invariant: a single stationary approaching vehicle holds EXACTLY ONE reservation row after several
/// arbiter ticks — the admission path is idempotent and never re-pushes a duplicate Approaching row.
#[test]
fn approaching_vehicle_holds_exactly_one_reservation_across_ticks() {
    let (mut app, e) = build_single_vehicle_arbiter_app(vec![
        TilePos { x: 3, y: 4 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 6, y: 4 },
    ]);
    // Run the build → arbitrate → cleanup chain 3 times without moving the vehicle.
    app.update();
    app.update();
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let count = res
        .by_intersection
        .get(&IntersectionId(0))
        .map(|v| v.iter().filter(|r| r.vehicle == e).count())
        .unwrap_or(0);
    assert_eq!(
        count, 1,
        "approaching vehicle must hold exactly 1 reservation after 3 ticks, got {count}"
    );
}

/// Ported from `intersection_reservations::downstream_jammed_link_blocks_admission_into_upstream_intersection`.
/// Invariant (spillback / don't-block-the-box): when the box-exit tile is physically jammed to
/// capacity, the approaching vehicle is REFUSED — admitting it would strand it inside the box once it
/// crosses (classic cross-intersection spillback). The refusal is a capacity refusal, not a matrix one.
#[test]
fn jammed_exit_tile_refuses_admission_spillback() {
    let mut app = build_bare_arbiter_app(|app| {
        let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
        occ.ensure_len(81);
        // Jam the eastbound box-exit tile (6,4) to its per-lane capacity.
        occ.per_tick_vehicles[grid_idx(TilePos { x: 6, y: 4 })] =
            RoadKind::TwoLane.capacity_per_lane_tile();
    });
    let e = spawn_east_through(&mut app);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        !res.is_reserved_by(IntersectionId(0), e),
        "vehicle must NOT be admitted: its box-exit tile is jammed (spillback protection)"
    );
    let stats = app.world().resource::<ArbiterTickStats>();
    assert!(
        stats.refused_capacity >= 1,
        "the refusal must be a capacity/spillback refusal; refused_capacity={}",
        stats.refused_capacity
    );
}

/// Ported from `intersection_reservations::downstream_free_link_allows_admission_into_upstream_intersection`.
/// Contrast case for the spillback gate: with the box-exit tile FREE, the same vehicle IS admitted —
/// the gate does not over-block when the exit has room.
#[test]
fn free_exit_tile_allows_admission() {
    let mut app = build_bare_arbiter_app(|app| {
        let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
        occ.ensure_len(81); // all tiles free
    });
    let e = spawn_east_through(&mut app);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), e),
        "vehicle MUST be admitted: its box-exit tile has free capacity"
    );
}

/// Ported from `intersection_reservations::sustained_downstream_jam_force_admits_one_car_via_escape_valve`.
/// Invariant (liveness valve): a cluster capacity-starved for `ARBITER_FORCE_ADMIT_TICKS` consecutive
/// ticks force-admits ONE car, breaking the circular wait — but it must NOT fire on the first stalled
/// tick (that would defeat spillback protection). The valve bypasses capacity, never the matrix.
#[test]
fn sustained_exit_jam_force_admits_one_car_via_valve() {
    let mut app = build_bare_arbiter_app(|app| {
        let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
        occ.ensure_len(81);
        occ.per_tick_vehicles[grid_idx(TilePos { x: 6, y: 4 })] =
            RoadKind::TwoLane.capacity_per_lane_tile();
    });
    let e = spawn_east_through(&mut app);

    // Tick 1: the valve must NOT fire prematurely.
    app.update();
    assert!(
        !app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(IntersectionId(0), e),
        "escape valve must not fire on the first stalled tick (would defeat spillback protection)"
    );

    // Re-jam the exit each tick (cleanup may release stale slots) and stall well past the threshold.
    for _ in 0..(ARBITER_FORCE_ADMIT_TICKS + 2) {
        {
            let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
            occ.per_tick_vehicles[grid_idx(TilePos { x: 6, y: 4 })] =
                RoadKind::TwoLane.capacity_per_lane_tile();
        }
        app.update();
    }

    // The exit tile is jammed to capacity EVERY tick, so the ONLY path to a reservation is the
    // liveness valve's force-admit (the normal exit-slot gate can never open). A reservation here is
    // therefore proof the valve fired. (force_admits is a per-tick counter and reads 0 on the final
    // tick once the car is already reserved, so we assert on the reservation, not the counter.)
    assert!(
        app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(IntersectionId(0), e),
        "after sustained exit-jam starvation the liveness valve must force-admit the car"
    );
    assert!(
        !app.world()
            .resource::<IntersectionReservations>()
            .stall_tripwire(),
        "stall tripwire must stay empty even when the valve fires"
    );
}

/// Force-admit threshold, mirrored from the arbiter (private const there). If the arbiter constant
/// changes, this test's loop count must follow.
const ARBITER_FORCE_ADMIT_TICKS: u32 = 30;

// ---------------------------------------------------------------------------------------------
// Signalized / right-turn-on-red admission invariants (ported from right_turn_on_red.rs and
// pedestrians.rs). These run on a SIGNALIZED cross_grid: cluster 0 is registered in
// `idx.traffic_lights`, and a `TrafficLight` entity drives the phase. The arbiter's
// `lanelet_readiness` gate then decides green / red / RTOR.
// ---------------------------------------------------------------------------------------------

/// Mark cluster 0 signalized and spawn an East/West-green (North/South-red) traffic light, so a
/// NORTH or EAST approach sees red and only its near-side right turn is RTOR-eligible.
fn make_signalized_ew_green(app: &mut App) {
    let (id, key) = {
        let idx = app.world().resource::<IntersectionIndex>();
        (
            idx.intersection_id_at(TilePos { x: 4, y: 4 }).unwrap(),
            idx.cluster_key_at(TilePos { x: 4, y: 4 }).unwrap(),
        )
    };
    app.world_mut()
        .resource_mut::<IntersectionIndex>()
        .traffic_lights
        .insert(id);
    app.world_mut()
        .spawn(crate::game::intersections::TrafficLight {
            intersection_id: id,
            intersection_key: key,
            pos: TilePos { x: 4, y: 4 },
            phase: LightPhase::EastWestGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        });
}

/// Spawn a NORTHBOUND right-turn vehicle, stopped at its approach tile (4,3) so it is RTOR-eligible
/// under a North-red light. Entry North, exit East (near-side) → right turn. Box-exit tile (6,4).
/// Route: (4,3) approach → (4,4) box → (5,4) box → (6,4) east exit lane.
fn spawn_north_right_stopped(app: &mut App) -> Entity {
    let route = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 6, y: 4 },
    ];
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(TilePos { x: 4, y: 4 })
        .unwrap();
    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, route, 0, 0.4, 0.0, 60.0, 20.0, 1.0)
    };
    app.world_mut()
        .spawn((
            v,
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: TilePos { x: 4, y: 3 },
                queue_position: 0,
            },
            VehicleLaneletPlan::default(),
        ))
        .id()
}

/// Ported from `right_turn_on_red::right_turn_on_red_is_blocked_by_conflicting_pedestrian_crossing_axis`.
/// Invariant: a right-turn-on-red is blocked while a pedestrian crosses the conflicting axis (the
/// roadway it turns onto), and admitted once the pedestrian clears. ПДД 13.1 / RTOR yield.
#[test]
fn rtor_blocked_by_conflicting_pedestrian_then_admitted_when_clear() {
    use crate::game::pedestrians::PedestrianCrossing;
    let mut app = build_bare_arbiter_app(make_signalized_ew_green);
    let ego = spawn_north_right_stopped(&mut app);

    // Pedestrian crossing the NS axis occupies the West/East crosswalks → blocks the North→East turn.
    let ped = app
        .world_mut()
        .spawn(PedestrianCrossing {
            intersection_id: IntersectionId(0),
            axis_ns: true,
        })
        .id();
    app.update();
    assert!(
        !app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(IntersectionId(0), ego),
        "RTOR must be blocked while a pedestrian crosses the conflicting axis"
    );

    // Pedestrian clears → RTOR can now be admitted (cluster otherwise empty).
    app.world_mut().entity_mut(ped).despawn();
    app.update();
    assert!(
        app.world()
            .resource::<IntersectionReservations>()
            .is_reserved_by(IntersectionId(0), ego),
        "RTOR must be admitted once the conflicting pedestrian clears"
    );
}

/// Ported from `right_turn_on_red::right_turn_on_red_is_only_admitted_when_intersection_is_clear`.
/// Invariant: RTOR is a yield maneuver — it is admitted ONLY when the cluster is otherwise clear. If
/// another vehicle already holds the box, the RTOR candidate is refused this tick.
#[test]
fn rtor_refused_while_intersection_not_clear() {
    let mut app = build_bare_arbiter_app(make_signalized_ew_green);
    let ego = spawn_north_right_stopped(&mut app);

    // An eastbound through vehicle is green (E/W green) → it takes the box first this tick.
    let through = spawn_east_through(&mut app);
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), through),
        "the green eastbound through must be admitted"
    );
    assert!(
        !res.is_reserved_by(IntersectionId(0), ego),
        "RTOR must NOT be admitted while the cluster is occupied (yield maneuver)"
    );
}

/// Ported from `pedestrians.rs::left_turn_reservations_yield_to_any_pedestrian_crossing_axis`.
/// Invariant (ПДД 13.1): a left-turning vehicle YIELDS to a pedestrian crossing EITHER axis — both
/// the entry crosswalk it starts from and the exit crosswalk it turns onto are conflict cells, so a
/// crossing pedestrian on either axis blocks the turn. Northbound-left (exits West) on cross_grid.
#[test]
fn left_turn_yields_to_pedestrian_on_either_axis() {
    use crate::game::pedestrians::PedestrianCrossing;
    let north_left = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 3, y: 5 },
    ];
    for axis_ns in [true, false] {
        let (mut app, ego) = build_single_vehicle_arbiter_app(north_left.clone());
        app.world_mut().spawn(PedestrianCrossing {
            intersection_id: IntersectionId(0),
            axis_ns,
        });
        app.update();
        assert!(
            !app.world()
                .resource::<IntersectionReservations>()
                .is_reserved_by(IntersectionId(0), ego),
            "left turn must yield to a pedestrian crossing axis_ns={axis_ns}"
        );
    }
}

/// Ported from `basic_behavior::stop_sign_vehicle_gets_reserved_and_enters_intersection_tile`.
/// Invariant (integration): a stop-sign-gated vehicle, once `check_intersection_priority` releases it
/// from Stopped, is admitted by the LIVE arbiter (an uncontrolled cluster — the arbiter doesn't read
/// stop-sign markers, so readiness is unconditional) and `move_vehicles` then advances it into the
/// box. Without an admission the entry gate would deadlock at the stop line. Runs the full release →
/// arbitrate → move chain on cross_grid.
#[test]
fn stop_sign_vehicle_is_reserved_and_advances_under_arbiter() {
    use crate::game::intersections::{IntersectionPriority, IntersectionPriorityMarker};

    let (grid, idx) = cross_grid();
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 9,
            height: 9,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig {
            experimental_lanelet_intersections: true,
            ..Default::default()
        })
        .insert_resource(LaneletGraph::default())
        .insert_resource(LaneletConflictMatrices::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<LeftTurnDemand>()
        .init_resource::<ArbiterIndexCache>()
        .init_resource::<ArbiterTickStats>()
        .init_resource::<ApproachFairness>()
        .init_resource::<ClusterStarvation>()
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>()
        .add_systems(
            Update,
            (
                check_intersection_priority,
                build_lanelet_graph,
                arbitrate_lanelet_reservations,
                build_traffic_spatial_index,
                move_vehicles,
                cleanup_intersection_reservations,
            )
                .chain(),
        );

    // Stop-sign marker on the box-entry tile (4,4).
    app.world_mut().spawn(IntersectionPriorityMarker {
        pos: TilePos { x: 4, y: 4 },
        priority: IntersectionPriority::StopSign,
    });

    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(TilePos { x: 4, y: 4 })
        .unwrap();

    // Eastbound vehicle stopped at the stop line on approach tile (3,4).
    let stop_progress = TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET;
    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut pool,
            vec![
                TilePos { x: 3, y: 4 },
                TilePos { x: 4, y: 4 },
                TilePos { x: 5, y: 4 },
                TilePos { x: 6, y: 4 },
            ],
            0,
            stop_progress,
            0.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let e = app
        .world_mut()
        .spawn((
            v,
            Transform::default(),
            VehicleTrafficState::Stopped {
                intersection: key,
                stop_tile: TilePos { x: 3, y: 4 },
                queue_position: 0,
            },
            VehicleLaneletPlan::default(),
        ))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(std::time::Duration::from_secs_f32(0.1));
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), e),
        "stop-sign vehicle must be reserved by the arbiter after release (else entry deadlocks)"
    );
    let v = app.world().get::<Vehicle>(e).unwrap();
    assert!(
        v.progress > stop_progress,
        "stop-sign vehicle must advance toward the box after being released/reserved"
    );
}

/// Ported from `pedestrians.rs::intersection_conflict_zones_allow_two_non_conflicting_right_turns`.
/// Invariant (throughput): two right turns whose internal paths do NOT cross are both admitted in one
/// tick — the arbiter does not over-serialize disjoint right turns. Northbound-right (→East) sweeps
/// the (4,4)/(5,4) corner; Westbound-right (→North) sweeps the disjoint (4,5)/(5,5) corner, so they
/// reserve concurrently. Run UNSIGNALIZED so both are immediately ready.
#[test]
fn two_non_conflicting_right_turns_both_admitted() {
    let mut app = build_bare_arbiter_app(|_| {});
    // Northbound right: (4,3) → box (4,4),(5,4) → exit East (6,4).
    let north_right = vec![
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 4 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 6, y: 4 },
    ];
    // Westbound right: (6,5) → box (5,5),(4,5) → exit North (4,6).
    let west_right = vec![
        TilePos { x: 6, y: 5 },
        TilePos { x: 5, y: 5 },
        TilePos { x: 4, y: 5 },
        TilePos { x: 4, y: 6 },
    ];
    let (a, b) = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(&mut pool, north_right, 0, 0.4, 0.0, 60.0, 20.0, 1.0),
            create_vehicle_with_route(&mut pool, west_right, 0, 0.4, 0.0, 60.0, 20.0, 1.0),
        )
    };
    let ea = app
        .world_mut()
        .spawn((
            a,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    let eb = app
        .world_mut()
        .spawn((
            b,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), ea) && res.is_reserved_by(IntersectionId(0), eb),
        "two non-conflicting right turns must both be admitted in one tick (throughput)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

#[test]
fn flag_on_arbiter_admits_exactly_one_conflicting_vehicle_deterministically() {
    let (east_a, north_a, tripwire_a) = run_arbiter_once();

    // Collision-safety: the two conflicting through movements never both get a reservation.
    assert!(
        !(east_a && north_a),
        "two conflicting vehicles must not both be admitted (collision)"
    );
    // Liveness signal: at least one IS admitted (the arbiter is producing reservations flag-on).
    assert!(
        east_a || north_a,
        "the flag-on arbiter must admit at least one approaching vehicle"
    );
    // Tripwire must stay empty (the arbiter never touches stall_ticks).
    assert!(!tripwire_a, "stall tripwire must stay empty flag-on");

    // Determinism: an identical seeded world yields the identical admission outcome.
    let (east_b, north_b, _) = run_arbiter_once();
    assert_eq!(
        (east_a, north_a),
        (east_b, north_b),
        "the flag-on admission outcome must be deterministic across identical worlds"
    );
}
