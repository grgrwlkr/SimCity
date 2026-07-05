//! Flag-ON end-to-end integration test for the lanelet intersection arbiter (P3c gate): build a real
//! cross intersection + lanelet graph, spawn two conflicting approaching vehicles (with EMPTY sidecar
//! plans, so the arbiter's precise-fallback resolves their lanelets from route geometry), run the
//! flag-on arbiter, and assert collision-safety (exactly one admitted), the tripwire stays empty, and
//! the outcome is deterministic across two identical seeded worlds.

use super::*;
use crate::game::intersections::{IntersectionCluster, LeftTurnDemand};
use crate::game::traffic::intersection::{
    ApproachFairness, ArbiterIndexCache, ArbiterTickStats, LaneletStallTracker, RingTopologyStatus,
    arbitrate_lanelet_reservations, cleanup_intersection_reservations,
};
use crate::game::transport::lane_graph::build_lane_graph_inner;
use crate::game::transport::{
    GraphVersion, LaneletConflictMatrices, LaneletGraph, build_lanelet_graph,
};

fn set_cell_lane(grid: &mut MapGrid, pos: TilePos, kind: RoadKind, dir: RoadDir, lane: u8) {
    let Some(mut cell) = grid.get(pos) else {
        return;
    };
    cell.water = false;
    cell.road = RoadCell {
        kind,
        dir,
        lane,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(pos, cell);
}

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
        .insert_resource(TrafficConfig::default())
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
        .insert_resource(TrafficConfig::default())
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
        .insert_resource(TrafficConfig::default())
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
        .insert_resource(TrafficConfig::default())
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

/// (Task E) Admission no longer gates on box-exit occupancy. Previously a JAMMED exit tile refused
/// admission (`jammed_exit_tile_refuses_admission_spillback`) and a sustained jam was only broken by a
/// force-admit valve. Both the don't-block-the-box GRANT mirror (downstream-headroom + exit-slot) and
/// the valve are REMOVED: clear-the-box guarantees an admitted car exits even onto a full exit road,
/// so the only collision-safe, live policy is to admit when the conflict matrix and the light allow —
/// REGARDLESS of exit occupancy. This test pins that: a vehicle whose box-exit tile is jammed to
/// capacity is STILL admitted on the first tick (no capacity refusal recorded), exactly the behavior
/// that lets a saturated deadlock cycle unwind.
#[test]
fn full_exit_tile_no_longer_refuses_admission() {
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
        res.is_reserved_by(IntersectionId(0), e),
        "vehicle MUST be admitted even with a FULL box-exit tile (don't-block-the-box removed): \
         clear-the-box guarantees it exits, so exit occupancy no longer gates admission"
    );
    let stats = app.world().resource::<ArbiterTickStats>();
    assert_eq!(
        stats.refused_capacity, 0,
        "there is no capacity/spillback refusal anymore; refused_capacity must be 0, got {}",
        stats.refused_capacity
    );
}

/// Contrast case retained from the old spillback suite: with a free box-exit tile the vehicle is of
/// course admitted (matrix/light permitting). The point now is parity with the full-exit case above —
/// admission is exit-occupancy-INDEPENDENT.
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
    // US-rule RTOR mechanics under test; the ПДД РФ default disables RTOR entirely.
    app.world_mut()
        .resource_mut::<TrafficConfig>()
        .right_turn_on_red = true;
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
        .insert_resource(TrafficConfig::default())
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

// =================================================================================================
// MULTI-LANE (FourLane × FourLane → 4x4 box) parallel-admission tests. The whole point of converting
// the test city to FourLane: in a 2x2 box every maneuver shares the same 4 tiles, so a single wide
// turn monopolizes the box → forced serialization → gridlock. In a 4x4 box a maneuver occupies only
// SOME of the 16 tiles, so two non-conflicting movements admit in the SAME tick. These tests build a
// real FourLane 4x4 cross + lanelet graph and assert exactly that, plus that genuinely conflicting
// movements still can't both admit (collision-safety preserved at the bigger box).
//
// 4x4 box lane layout (x,y in 4..=7, mirrors what `build_road_segment(FourLane)` emits):
//   Horizontal E-W road occupies rows y=4,5 (EAST lanes) and y=6,7 (WEST lanes).
//   Vertical   N-S road occupies cols x=6,7 (NORTH lanes) and x=4,5 (SOUTH lanes).
//   The 16 crossing tiles (x,y in 4..=7) are the box (dir == None).
// =================================================================================================

/// 12x12 grid with a 4x4 cluster at x,y in 4..=7. Two crossing FourLane roads (2 lanes per
/// direction). Approach/exit lanes extend out to the grid edges.
fn cross_grid_4x4() -> (MapGrid, IntersectionIndex) {
    let mut grid = MapGrid::new(12, 12);

    // Box tiles (dir == None).
    let mut box_tiles = Vec::new();
    for x in 4..=7 {
        for y in 4..=7 {
            let p = TilePos { x, y };
            set_cell(&mut grid, p, RoadKind::FourLane, RoadDir::None);
            box_tiles.push(p);
        }
    }

    // Horizontal FourLane: rows y=4,5 EAST; y=6,7 WEST. Lanes outside the box on both x sides.
    // Lane indices follow the real paint (input.rs): canonical East, 0 = curb of the canonical
    // carriageway (y=4), 1 = its centerline lane (y=5), 2 = opposite centerline (y=6),
    // 3 = opposite curb (y=7) — so is_leftmost/rightmost_for_dir see real positions.
    for x in (0..4).chain(8..12) {
        set_cell_lane(
            &mut grid,
            TilePos { x, y: 4 },
            RoadKind::FourLane,
            RoadDir::East,
            0,
        );
        set_cell_lane(
            &mut grid,
            TilePos { x, y: 5 },
            RoadKind::FourLane,
            RoadDir::East,
            1,
        );
        set_cell_lane(
            &mut grid,
            TilePos { x, y: 6 },
            RoadKind::FourLane,
            RoadDir::West,
            2,
        );
        set_cell_lane(
            &mut grid,
            TilePos { x, y: 7 },
            RoadKind::FourLane,
            RoadDir::West,
            3,
        );
    }
    // Vertical FourLane: cols x=6,7 NORTH; x=4,5 SOUTH. Canonical North: 0 = curb (x=7),
    // 1 = centerline (x=6); opposite (South): 2 = centerline (x=5), 3 = curb (x=4).
    for y in (0..4).chain(8..12) {
        set_cell_lane(
            &mut grid,
            TilePos { x: 6, y },
            RoadKind::FourLane,
            RoadDir::North,
            1,
        );
        set_cell_lane(
            &mut grid,
            TilePos { x: 7, y },
            RoadKind::FourLane,
            RoadDir::North,
            0,
        );
        set_cell_lane(
            &mut grid,
            TilePos { x: 4, y },
            RoadKind::FourLane,
            RoadDir::South,
            3,
        );
        set_cell_lane(
            &mut grid,
            TilePos { x: 5, y },
            RoadKind::FourLane,
            RoadDir::South,
            2,
        );
    }

    let id = IntersectionId(0);
    let key = IntersectionKey {
        aabb_min: TilePos { x: 4, y: 4 },
        aabb_max: TilePos { x: 7, y: 7 },
        tile_count: 16,
        tiles_hash: 16,
    };
    let mut idx = IntersectionIndex::default();
    idx.clusters.push(IntersectionCluster {
        id,
        key,
        tiles: box_tiles.clone(),
        aabb_min: TilePos { x: 4, y: 4 },
        aabb_max: TilePos { x: 7, y: 7 },
        centroid_tile: TilePos { x: 4, y: 4 },
    });
    for t in box_tiles {
        idx.tile_to_intersection.insert(t, id);
    }
    idx.version = 1;
    (grid, idx)
}

/// Build a bare flag-on arbiter app on the 4x4 cross (build → arbitrate → cleanup chained), no
/// vehicles spawned. `customize` may mutate resources first.
fn build_bare_arbiter_app_4x4(customize: impl FnOnce(&mut App)) -> App {
    let (grid, idx) = cross_grid_4x4();
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 12,
            height: 12,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig::default())
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

/// Spawn a through/turn vehicle on the 4x4 grid from `route` (cursor 0, progress 0.4, empty sidecar).
fn spawn_route_4x4(app: &mut App, route: Vec<TilePos>) -> Entity {
    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, route, 0, 0.4, 0.0, 60.0, 20.0, 1.0)
    };
    app.world_mut()
        .spawn((
            v,
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id()
}

/// PARALLEL-ADMIT (the whole point): two OPPOSITE through straights on disjoint rows of the 4x4 box
/// — eastbound on the south lane y=4, westbound on the north lane y=7 — occupy disjoint tile sets, so
/// the arbiter admits BOTH in the SAME tick. In a 2x2 box the analogue already worked, but on the 4x4
/// the lanelet graph + conflict matrix for the bigger box must reproduce it (the conversion's risk).
#[test]
fn four_lane_4x4_two_disjoint_straights_both_admitted_same_tick() {
    let mut app = build_bare_arbiter_app_4x4(|_| {});
    // Eastbound straight on the south-most EAST lane (y=4): (3,4)→box→(8,4).
    let east = spawn_route_4x4(
        &mut app,
        vec![
            TilePos { x: 3, y: 4 },
            TilePos { x: 4, y: 4 },
            TilePos { x: 7, y: 4 },
            TilePos { x: 8, y: 4 },
        ],
    );
    // Westbound straight on the north-most WEST lane (y=7): (8,7)→box→(3,7).
    let west = spawn_route_4x4(
        &mut app,
        vec![
            TilePos { x: 8, y: 7 },
            TilePos { x: 7, y: 7 },
            TilePos { x: 4, y: 7 },
            TilePos { x: 3, y: 7 },
        ],
    );
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), east),
        "eastbound straight (y=4) must be admitted"
    );
    assert!(
        res.is_reserved_by(IntersectionId(0), west),
        "westbound straight (y=7) must be admitted in the SAME tick (disjoint rows of the 4x4 box)"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

/// PARALLEL-ADMIT, the 4x4-specific win: an eastbound straight on the bottom row (y=4) PLUS a tight
/// right turn that hugs a DIFFERENT corner, so their box footprints are disjoint and both admit in
/// one tick. Westbound→North right turn: enters West-lane row y=6 from the east side, exits North on
/// col x=7 — its tight arc hugs the top-right corner, never touching the y=4 row.
#[test]
fn four_lane_4x4_straight_plus_disjoint_right_turn_both_admitted() {
    let mut app = build_bare_arbiter_app_4x4(|_| {});
    // Eastbound straight, bottom row y=4.
    let straight = spawn_route_4x4(
        &mut app,
        vec![
            TilePos { x: 3, y: 4 },
            TilePos { x: 4, y: 4 },
            TilePos { x: 7, y: 4 },
            TilePos { x: 8, y: 4 },
        ],
    );
    // Westbound→North right turn from the CURB West lane y=7 (ПДД 8.5: right turns from the
    // крайняя правая), exit North col x=7. entry_dir=West, West.right()=North under right-hand
    // traffic → RightTurn, hugs the top-right corner tile (7,7) only.
    let right = spawn_route_4x4(
        &mut app,
        vec![
            TilePos { x: 8, y: 7 },
            TilePos { x: 7, y: 7 },
            TilePos { x: 7, y: 8 },
        ],
    );
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    assert!(
        res.is_reserved_by(IntersectionId(0), straight),
        "eastbound straight (y=4) must be admitted"
    );
    assert!(
        res.is_reserved_by(IntersectionId(0), right),
        "disjoint right turn (top-right corner) must be admitted in the SAME tick"
    );
    assert!(!res.stall_tripwire(), "stall tripwire must stay empty");
}

/// COLLISION-SAFETY preserved at the 4x4: two CONFLICTING movements whose box paths cross still can't
/// both admit. Eastbound straight on y=4 (sweeps (4,4)..(7,4)) vs a southbound straight on col x=4
/// (sweeps (4,7)..(4,4)) — they share the bottom-left tile (4,4), so at most one is admitted.
#[test]
fn four_lane_4x4_conflicting_movements_not_double_admitted() {
    let mut app = build_bare_arbiter_app_4x4(|_| {});
    // Eastbound straight on y=4.
    let east = spawn_route_4x4(
        &mut app,
        vec![
            TilePos { x: 3, y: 4 },
            TilePos { x: 4, y: 4 },
            TilePos { x: 7, y: 4 },
            TilePos { x: 8, y: 4 },
        ],
    );
    // Southbound straight on the west-most SOUTH lane x=4: (4,8)→box→(4,3). Crosses (4,4).
    let south = spawn_route_4x4(
        &mut app,
        vec![
            TilePos { x: 4, y: 8 },
            TilePos { x: 4, y: 7 },
            TilePos { x: 4, y: 4 },
            TilePos { x: 4, y: 3 },
        ],
    );
    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let admitted = usize::from(res.is_reserved_by(IntersectionId(0), east))
        + usize::from(res.is_reserved_by(IntersectionId(0), south));
    assert_eq!(
        admitted, 1,
        "two movements sharing box tile (4,4) must NOT both be admitted (collision-safety)"
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

// =================================================================================================
// DEFERRED-RESERVATION ENTRY-GATE tests (task B). An `Approaching` grant no longer pre-locks the
// box (`active_mask`); the conflict-tile reservation is taken at BOX ENTRY in `move_vehicles`, and
// THAT gate is the collision serializer. These tests drive vehicles through the FULL chain
// (build → arbitrate → spatial-index → move_vehicles → cleanup) and assert at the ENTRY level:
// who physically holds the box (`ledger.holds` == an `active_mask` holder == Inside), not just who
// holds an `Approaching` reservation row.
// =================================================================================================

/// Build the full-chain arbiter app on the 4x4 `cross_grid_4x4` (build → arbitrate → spatial → move →
/// cleanup), so vehicles actually advance into the box through the entry gate. The 4x4 box is used
/// (not the 2x2) so two CONFLICTING straights enter DIFFERENT first box tiles — the per-tile capacity
/// gate then cannot mask the conflict, leaving the lanelet ENTRY MATRIX as the sole serializer (the
/// thing this task adds). `customize` may mutate resources first. No vehicles spawned yet.
fn build_full_chain_arbiter_app_4x4(customize: impl FnOnce(&mut App)) -> App {
    let (grid, idx) = cross_grid_4x4();
    let gv = GraphVersion(1);
    let lanes = build_lane_graph_inner(&grid, &gv);

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 12,
            height: 12,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(lanes)
        .insert_resource(gv)
        .insert_resource(TrafficConfig::default())
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
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>();

    app.add_systems(
        Update,
        (
            build_lanelet_graph,
            arbitrate_lanelet_reservations,
            build_traffic_spatial_index,
            move_vehicles,
            cleanup_intersection_reservations,
        )
            .chain(),
    );

    customize(&mut app);
    app
}

/// Spawn a through vehicle at the STOP LINE of its approach tile (so it crosses into the box during
/// `move_vehicles` once admitted), with an empty sidecar and a healthy speed. Returns its entity.
fn spawn_at_stop_line(app: &mut App, route: Vec<TilePos>) -> Entity {
    let stop_progress = TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET;
    let v = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, route, 0, stop_progress, 8.0, 60.0, 20.0, 1.0)
    };
    app.world_mut()
        .spawn((
            v,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id()
}

/// True iff `e`'s route cursor currently points at a box (intersection) tile — i.e. it is physically
/// INSIDE the cluster.
fn is_inside_box(app: &App, e: Entity) -> bool {
    // A vehicle that finished its route is despawned by `move_vehicles` → no longer in the box.
    let Some(v) = app.world().get::<Vehicle>(e) else {
        return false;
    };
    let pool = app.world().resource::<crate::game::transport::PathPool>();
    let idx = app.world().resource::<IntersectionIndex>();
    pool.get_tile(v.path_handle, v.path_cursor)
        .and_then(|t| idx.intersection_id_at(t))
        .is_some()
}

/// COLLISION-SAFETY AT ENTRY (the core task-B invariant). Two CONFLICTING straights on the 4x4 box —
/// eastbound on row y=4 (enters box tile (4,4)) and southbound on col x=4 (enters box tile (4,7), then
/// sweeps down to (4,4)) — share the (4,4) tile, so they CONFLICT. Their FIRST box tiles differ
/// ((4,4) vs (4,7)), so the per-tile capacity gate canNOT mask the conflict; the lanelet ENTRY MATRIX
/// is the SOLE serializer. The arbiter may grant BOTH an `Approaching` row (deferred — no pre-lock),
/// but the box-entry gate in `move_vehicles` must ensure the two are NEVER both inside the box at the
/// same time, and at most ONE holds the conflict-tile reservation (`active_mask`).
///
/// RED-proof: with the entry-matrix check removed (gate = bare `is_reserved_by`), the southbound car
/// freely enters its (4,7) corner while the eastbound holds (4,4) — both inside the box at once — and
/// this test fails. With the matrix check, the southbound's `try_admit` fails while the eastbound
/// holds (4,4), so it waits at the line (verified: reverting the gate makes this test fail).
#[test]
fn conflicting_vehicles_never_both_inside_box_entry_serialized() {
    let mut app = build_full_chain_arbiter_app_4x4(|_| {});
    // Eastbound straight on the bottom EAST lane y=4: (3,4) → box (4,4),(7,4) → (8,4).
    let east = spawn_at_stop_line(
        &mut app,
        vec![
            TilePos { x: 3, y: 4 },
            TilePos { x: 4, y: 4 },
            TilePos { x: 7, y: 4 },
            TilePos { x: 8, y: 4 },
        ],
    );
    // Southbound straight on the west SOUTH lane x=4: (4,8) → box (4,7),(4,4) → (4,3). Shares (4,4).
    let south = spawn_at_stop_line(
        &mut app,
        vec![
            TilePos { x: 4, y: 8 },
            TilePos { x: 4, y: 7 },
            TilePos { x: 4, y: 4 },
            TilePos { x: 4, y: 3 },
        ],
    );

    // Drive the whole crossing. At EVERY tick assert the collision invariant: the two CONFLICTING
    // vehicles are never both physically inside the box, and the box never has two active-mask holders
    // for this conflict set. Record that the path is genuinely exercised so the test can't pass
    // vacuously.
    let mut east_granted = false;
    let mut south_granted = false;
    let mut any_observed_inside = false;
    for tick in 0..80 {
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        app.update();

        let east_in = is_inside_box(&app, east);
        let south_in = is_inside_box(&app, south);
        any_observed_inside |= east_in || south_in;
        assert!(
            !(east_in && south_in),
            "tick {tick}: two CONFLICTING vehicles must NEVER both be inside the box (collision)"
        );

        let res = app.world().resource::<IntersectionReservations>();
        east_granted |= res.is_reserved_by(IntersectionId(0), east);
        south_granted |= res.is_reserved_by(IntersectionId(0), south);
        if let Some(ledger) = res.ledger(IntersectionId(0)) {
            let both_hold = ledger.holds(east) && ledger.holds(south);
            assert!(
                !both_hold,
                "tick {tick}: conflicting vehicles must not both hold the box (active_mask)"
            );
        }
        assert!(
            !res.stall_tripwire(),
            "tick {tick}: stall tripwire must stay empty"
        );
    }

    // Non-vacuity: the entry gate was actually exercised (a car physically entered the box), and the
    // deferred grant let BOTH conflicting cars become eligible — otherwise this would just re-test the
    // old grant-level serialization.
    assert!(
        any_observed_inside,
        "at least one vehicle must have been observed inside the box (entry gate exercised)"
    );
    assert!(
        east_granted && south_granted,
        "both conflicting vehicles must have received an Approaching grant during the drive \
         (deferred design) — east={east_granted}, south={south_granted}"
    );
}

/// NO PRE-LOCK (the throughput change). Two CONFLICTING perpendicular straights approach. Under the
/// OLD design only one ever got a reservation (the granted-Approaching car pre-locked the box). Under
/// the deferred design, a granted-but-not-yet-entered car does NOT block the conflicting candidate
/// from ALSO being granted an `Approaching` reservation — so across a couple of ticks BOTH hold an
/// `Approaching` row, yet (proven by the entry-gate test above) only one actually enters. This test
/// asserts the new GRANT behavior: both eventually get reservations.
#[test]
fn granted_approaching_does_not_pre_lock_conflicting_candidate() {
    // Hold both vehicles at the line (don't run move_vehicles) so neither enters the box; only the
    // grant phase runs across ticks. Build → arbitrate → cleanup (no move): the first tick grants
    // one, a later tick grants the other (the first is skipped as already-reserved, freeing the
    // conflict because it never took active_mask).
    let (mut app, east, north) = build_arbiter_app();

    let mut east_seen = false;
    let mut north_seen = false;
    for _ in 0..6 {
        app.update();
        let res = app.world().resource::<IntersectionReservations>();
        east_seen |= res.is_reserved_by(IntersectionId(0), east);
        north_seen |= res.is_reserved_by(IntersectionId(0), north);
        // Neither moves (no move_vehicles in this chain), so neither ever takes active_mask: the box
        // stays unheld, which is exactly what lets both accumulate Approaching rows.
        if let Some(ledger) = res.ledger(IntersectionId(0)) {
            assert_eq!(
                ledger.holder_count(),
                0,
                "no vehicle enters the box in this chain, so active_mask must hold nobody"
            );
        }
    }

    assert!(
        east_seen && north_seen,
        "deferred design: BOTH conflicting vehicles must get an Approaching reservation across ticks \
         (a granted-but-not-entered car no longer pre-locks the box) — east={east_seen}, north={north_seen}"
    );
}

/// Build a `build_traffic_spatial_index → move_vehicles` app on the 4x4 (deep-box) cross. No arbiter:
/// the test injects the reservation it needs directly so the don't-block-the-box EXIT gate is the
/// only thing under test.
fn build_move_app_4x4() -> App {
    let (grid, idx) = cross_grid_4x4();
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 12,
            height: 12,
            tile_size: 16.0,
        })
        .insert_resource(grid)
        .insert_resource(idx)
        .insert_resource(TrafficConfig::default())
        .insert_resource(LaneletConflictMatrices::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());
    app
}

/// Push a coarse whole-box Approaching reservation for `e` so the box-entry RESERVATION gate
/// (`entry_reservation` → `Some((None, true))`) admits it — isolating the don't-block-the-box EXIT
/// gate as the sole decision.
fn inject_coarse_reservation(app: &mut App, e: Entity) {
    app.world_mut()
        .resource_mut::<IntersectionReservations>()
        .by_intersection
        .entry(IntersectionId(0))
        .or_default()
        .push(IntersectionReservation {
            vehicle: e,
            state: ReservationState::Approaching,
            created_at_sec: 0.0,
            zones: ZONE_ALL,
            tiles: Vec::new(),
            stream: StreamKey {
                entry: RoadDir::East,
                exit: RoadDir::East,
            },
            maneuver: ManeuverKind::Straight,
            local_idx: None,
            coarse: true,
        });
}

/// (Task E) DEADLOCK-FLOW. A car at a deep-box approach whose EXIT road tile is FULL (`occ == cap`)
/// with a STATIONARY lead at high progress must now ENTER the box (conflict-matrix permitting) and
/// step out via clear-the-box — instead of waiting forever at the approach. The don't-block-the-box
/// ENTRY gate that USED to refuse this entry (and caused the approach deadlock when every box's exit
/// is held by the next car in a cycle) is removed. Clear-the-box guarantees the admitted car exits the
/// box even onto the full exit road, so blocking entry on exit-fullness is counterproductive — it only
/// freezes the cycle.
///
/// RED-PROOF: pre-change, with `occ == cap` and a stationary high-progress lead, the don't-block-the-box
/// gate set `blocked_next = true` and the car snapped BACK toward the stop line (cursor 0, progress <
/// start). Post-change it advances onto the first box tile and, within a few ticks, exits at route end.
#[test]
fn deadlock_flow_full_exit_no_longer_blocks_box_entry() {
    let exit_tile = TilePos { x: 8, y: 4 };
    let approach = TilePos { x: 3, y: 4 };
    let route = vec![
        approach,
        TilePos { x: 4, y: 4 },
        TilePos { x: 7, y: 4 },
        exit_tile,
    ];
    let cap = RoadKind::FourLane.capacity_per_lane_tile();

    let mut app = build_move_app_4x4();
    let exit_idx = app.world().resource::<MapGrid>().idx(exit_tile).unwrap();

    // Candidate eastbound mid approach tile (progress 0.4, speed 0) — the SAME start as the deep-box
    // RED case, so the discriminator is a direct inverse: OLD code (don't-block-the-box) snapped it
    // BACK toward the stop line (progress drops below start); NEW code lets it advance FORWARD into the
    // box despite the full exit.
    let start_progress = 0.4_f32;
    let cand = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pool, route, 0, start_progress, 0.0, 60.0, 20.0, 1.0)
    };
    let cand = app
        .world_mut()
        .spawn((
            cand,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();
    inject_coarse_reservation(&mut app, cand);

    // Stationary lead occupying the full exit tile at high progress (0.9): exactly the deadlock-cycle
    // shape where the exit is held by the next car. Single-tile route so it stays put.
    {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        let lead =
            create_vehicle_with_route(&mut pool, vec![exit_tile], 0, 0.9, 0.0, 60.0, 20.0, 1.0);
        app.world_mut().spawn((
            lead,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ));
    }
    {
        let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
        occ.ensure_len(12 * 12);
        occ.per_tick_vehicles[exit_idx] = cap;
    }

    // One tick: with don't-block-the-box removed the car is NOT held at the approach by the full exit —
    // it advances FORWARD toward the box (progress increases past its start) instead of snapping back.
    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(std::time::Duration::from_secs_f32(0.1));
    app.update();

    let v = app.world().get::<Vehicle>(cand).unwrap();
    assert!(
        v.path_cursor >= 1 || v.progress > start_progress,
        "a full exit must NOT block box entry anymore (don't-block-the-box removed): the car must \
         advance toward / into the box despite occ==cap (pre-change it snapped back below \
         start={start_progress}); got cursor={} progress={}",
        v.path_cursor,
        v.progress,
    );

    // And it keeps flowing: within a few ticks it reaches the exit (clear-the-box lets it leave the
    // box even onto the still-full exit road).
    for _ in 0..40 {
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        // Keep the exit jammed every tick (the deadlock cycle never drains it on its own).
        {
            let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
            occ.per_tick_vehicles[exit_idx] = cap;
        }
        app.update();
        if app.world().get_entity(cand).is_err() {
            break; // crossed the whole box and despawned at route end
        }
    }
    let reached_exit = match app.world().get::<Vehicle>(cand) {
        Some(v) => v.path_cursor >= 3, // advanced to / past the exit-tile cursor
        None => true,                  // despawned at route end
    };
    assert!(
        reached_exit,
        "with clear-the-box the admitted car must keep flowing THROUGH the box and exit even onto a \
         permanently full exit road — the deadlock cycle unwinds"
    );
}

/// (Task E) MULTI-BOX CYCLE. Three eastbound cars each at the approach of a deep box whose exit road
/// is full. Pre-change, each waits forever (its exit is full → don't-block-the-box refuses entry),
/// the classic circular wait. Post-change every car enters its box and exits via clear-the-box, so
/// all three cursors advance over a few ticks (no permanent deadlock). This is a behavioral
/// stand-in for the live 7-car junction freeze.
#[test]
fn multi_car_full_exit_cycle_progresses_not_deadlocks() {
    let exit_tile = TilePos { x: 8, y: 4 };
    let approach = TilePos { x: 3, y: 4 };
    let route = vec![
        approach,
        TilePos { x: 4, y: 4 },
        TilePos { x: 7, y: 4 },
        exit_tile,
    ];
    let cap = RoadKind::FourLane.capacity_per_lane_tile();

    let mut app = build_move_app_4x4();
    let exit_idx = app.world().resource::<MapGrid>().idx(exit_tile).unwrap();

    // Three same-lanelet eastbound cars queued on the approach tile (cursor 0) at descending progress
    // so they form a queue, all blocked behind the full exit pre-change.
    let mut cars = Vec::new();
    for (i, prog) in [0.4_f32, 0.2, 0.0].into_iter().enumerate() {
        let v = {
            let mut pool = app
                .world_mut()
                .resource_mut::<crate::game::transport::PathPool>();
            create_vehicle_with_route(&mut pool, route.clone(), 0, prog, 8.0, 60.0, 20.0, 1.0)
        };
        let _ = i;
        let e = app
            .world_mut()
            .spawn((
                v,
                Transform::default(),
                VehicleTrafficState::FreeFlow,
                VehicleLaneletPlan::default(),
            ))
            .id();
        inject_coarse_reservation(&mut app, e);
        cars.push(e);
    }

    // Continuous longitudinal start position (cursor + progress) of each car, to prove forward flow.
    let start_pos: Vec<f32> = cars
        .iter()
        .map(|&e| {
            let v = app.world().get::<Vehicle>(e).unwrap();
            v.path_cursor as f32 + v.progress
        })
        .collect();

    // Run with the exit PERMANENTLY full (a deadlock cycle never drains on its own). The front car
    // crosses the whole box (and despawns at route end); the followers ramp up from rest behind it.
    for _ in 0..120 {
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        {
            let mut occ = app.world_mut().resource_mut::<TrafficOccupancy>();
            occ.ensure_len(12 * 12);
            occ.per_tick_vehicles[exit_idx] = cap;
        }
        app.update();
    }

    // No car may be wedged: each must have ADVANCED (continuous position strictly increased) despite
    // the permanently full exit. A despawned car flowed all the way through (front car). With the OLD
    // don't-block-the-box gate every car stayed pinned at the approach (zero forward progress) — the
    // circular wait. Clear-the-box unwinds it.
    for (i, &e) in cars.iter().enumerate() {
        let advanced = match app.world().get::<Vehicle>(e) {
            Some(v) => (v.path_cursor as f32 + v.progress) > start_pos[i] + 0.05,
            None => true, // flowed through the whole box and despawned at route end
        };
        assert!(
            advanced,
            "car {i} must have FLOWED forward despite a permanently full exit (cycle unwinds via \
             clear-the-box), not deadlocked at the approach (start_pos={})",
            start_pos[i]
        );
    }

    // And the leading car must have actually entered the box (cursor advanced past the approach),
    // proving entry happens even with the exit full — not merely crept forward on the approach tile.
    let front_entered = match app.world().get::<Vehicle>(cars[0]) {
        Some(v) => v.path_cursor >= 1,
        None => true,
    };
    assert!(
        front_entered,
        "the leading car must enter the box despite the full exit (don't-block-the-box removed)"
    );
}

/// REPRO + REGRESSION (the live "left turn frozen at an EMPTY box" freeze). An UNCONTROLLED 4x4
/// intersection (no `TrafficLight`). A South-entry LEFT-turner (entry South → exit East, the live
/// frozen car's directions) approaches one tile before the box; a conflicting West-bound through
/// approaches the SAME box but enters MUCH later (it starts far back, at the tile center, low speed).
///
/// The bug: the through took its precise conflict-tile reservation (`active_mask`) the instant it
/// became eligible — while still rolling up its APPROACH tile, NOT physically in the box — and HELD
/// it for its entire slow approach. That phantom hold refused the conflicting left-turn's admission
/// every tick even though the box was PHYSICALLY EMPTY (`active_mask`-held by an approach-tile car,
/// not an in-box one). The left-turner never got a reservation and never advanced — a monotonic
/// freeze at an empty box, exactly the live signature.
///
/// The fix takes the conflict-tile reservation only when a car is AT the box boundary (entering the
/// box), so an approaching car holds nothing while still on its approach tile. The left-turner is
/// then admitted and advances into the box. Collision-safety is preserved: the two never both sit
/// inside the box (asserted every tick), and once one is genuinely crossing the box it does hold the
/// conflict tile and the other yields.
///
/// RED before the fix: the left-turner is NEVER reserved and NEVER enters the box (its cursor/progress
/// never advance) while the through holds `active_mask` from its approach tile.
#[test]
fn uncontrolled_left_turn_not_frozen_by_approaching_through_at_empty_box() {
    let mut app = build_full_chain_arbiter_app_4x4(|_| {});

    // South-entry LEFT-turner on the centerline SOUTH lane x=5 (ПДД 8.5: left turns only from
    // the крайняя левая), exits East onto row y=4. Box tiles 4..=7. (5,8) approach → box
    // (5,7)..(5,4),(6,4),(7,4) → (8,4) East exit. entry South, South.left()=East → LeftTurn.
    // Starts near the stop line, ready to enter.
    let left = spawn_at_stop_line(
        &mut app,
        vec![
            TilePos { x: 5, y: 8 },
            TilePos { x: 5, y: 7 },
            TilePos { x: 5, y: 4 },
            TilePos { x: 6, y: 4 },
            TilePos { x: 7, y: 4 },
            TilePos { x: 8, y: 4 },
        ],
    );

    // Conflicting WEST-bound through on row y=6 (a WEST lane), crossing col x=4 in the box — it
    // shares box tiles with the left-turn sweep. It starts FAR BACK at the tile center (progress 0,
    // low speed) so for many ticks it is on its APPROACH tile, NOT in the box: the box is physically
    // EMPTY while it approaches. Pre-fix it still held `active_mask` the whole time and froze the left.
    let through = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut pool,
            vec![
                TilePos { x: 8, y: 6 },
                TilePos { x: 7, y: 6 },
                TilePos { x: 4, y: 6 },
                TilePos { x: 3, y: 6 },
            ],
            0,
            0.0,
            1.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let through = app
        .world_mut()
        .spawn((
            through,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            VehicleLaneletPlan::default(),
        ))
        .id();

    let left_start = {
        let v = app.world().get::<Vehicle>(left).unwrap();
        v.path_cursor as f32 + v.progress
    };

    let mut left_ever_reserved = false;
    let mut left_entered_box = false;
    for tick in 0..60 {
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        app.update();

        // The only two vehicles are `left` and `through`. A vehicle is "committed into the box" iff
        // its cursor is already on a box tile, OR it is one tile before the box AND its center has
        // crossed the tile boundary (`progress >= TILE_CENTER_TO_EDGE_TILES`) — i.e. its front half is
        // physically over the box. The box is PHYSICALLY EMPTY iff neither is committed. (Cursor-only
        // `is_inside_box` is too coarse here: a car at the boundary, progress 0.5..1.0, legitimately
        // holds the conflict tile while its cursor hasn't advanced yet.)
        let committed_into_box = |app: &App, e: Entity| -> bool {
            let Some(v) = app.world().get::<Vehicle>(e) else {
                return false;
            };
            let pool = app.world().resource::<crate::game::transport::PathPool>();
            let idx = app.world().resource::<IntersectionIndex>();
            let on_box = pool
                .get_tile(v.path_handle, v.path_cursor)
                .and_then(|t| idx.intersection_id_at(t))
                .is_some();
            let next_is_box = pool
                .get_tile(v.path_handle, v.path_cursor + 1)
                .and_then(|t| idx.intersection_id_at(t))
                .is_some();
            on_box || (next_is_box && v.progress >= TILE_CENTER_TO_EDGE_TILES)
        };
        let left_in = is_inside_box(&app, left);
        let through_in = is_inside_box(&app, through);
        let box_physically_empty =
            !committed_into_box(&app, left) && !committed_into_box(&app, through);

        let res = app.world().resource::<IntersectionReservations>();
        left_ever_reserved |= res.is_reserved_by(IntersectionId(0), left);

        // Collision-safety: the two genuinely-conflicting vehicles must NEVER both be inside the box.
        assert!(
            !(left_in && through_in),
            "tick {tick}: the left-turn and the conflicting through must NEVER both be inside the box"
        );
        left_entered_box |= left_in;

        // CORE INVARIANT (the bug): the ledger must NOT hold a conflict-tile reservation
        // (`active_mask` / a holder) while the box is PHYSICALLY EMPTY. Pre-fix the through grabbed
        // `active_mask` from its APPROACH tile and held it for its whole approach — a phantom hold on
        // an empty box that refused the left-turn's admission. Post-fix `active_mask` is held only by
        // a car actually inside the box.
        if box_physically_empty && let Some(ledger) = res.ledger(IntersectionId(0)) {
            assert_eq!(
                ledger.holder_count(),
                0,
                "tick {tick}: the box is PHYSICALLY EMPTY (no vehicle inside) yet the ledger holds \
                 {} conflict-tile reservation(s) — a phantom approach-tile hold that froze the \
                 left-turn (the live empty-box freeze)",
                ledger.holder_count(),
            );
        }
        assert!(
            !res.stall_tripwire(),
            "tick {tick}: stall tripwire must stay empty"
        );
    }

    let left_end = match app.world().get::<Vehicle>(left) {
        Some(v) => v.path_cursor as f32 + v.progress,
        None => f32::INFINITY, // crossed the whole box and despawned at route end
    };

    assert!(
        left_ever_reserved,
        "the uncontrolled left-turner must get a reservation — it must NOT be frozen by a through \
         that is merely APPROACHING an otherwise-empty box (the live empty-box freeze)"
    );
    assert!(
        left_entered_box || left_end > left_start + 0.5,
        "the left-turner must actually advance into / through the box, not freeze at the line \
         (start={left_start}, end={left_end})"
    );
}

/// ПДД 13.12: an unprotected LEFT turn must yield to the ONCOMING straight. The compact
/// Manhattan Г-path is deliberately tile-DISJOINT from the oncoming through column, so the
/// tile-overlap matrix alone would see NO conflict here — the forced semantic pair
/// (`add_conflict_pair` in `transport/lanelet/build.rs`) is what must register it. If that pair
/// were missing, both would be admitted in one tick and the left would cut across the oncoming
/// car's nose.
#[test]
fn crossing_left_yields_to_oncoming_straight() {
    let mut app = build_bare_arbiter_app(|_| {});
    // Southbound ONCOMING through on the x=5 lane: (5,6) → (5,5),(5,4) → (5,3).
    let oncoming_route = vec![
        TilePos { x: 5, y: 6 },
        TilePos { x: 5, y: 5 },
        TilePos { x: 5, y: 4 },
        TilePos { x: 5, y: 3 },
    ];
    let oncoming = {
        let mut pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        let v = create_vehicle_with_route(&mut pool, oncoming_route, 0, 0.4, 0.0, 60.0, 20.0, 1.0);
        app.world_mut()
            .spawn((
                v,
                VehicleTrafficState::FreeFlow,
                VehicleLaneletPlan::default(),
            ))
            .id()
    };
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
        !(res.is_reserved_by(IntersectionId(0), oncoming)
            && res.is_reserved_by(IntersectionId(0), left)),
        "an oncoming straight and an unprotected left must not both be admitted (ПДД 13.12)"
    );
    assert!(
        res.is_reserved_by(IntersectionId(0), oncoming),
        "the oncoming straight has priority; the left yields"
    );
}
