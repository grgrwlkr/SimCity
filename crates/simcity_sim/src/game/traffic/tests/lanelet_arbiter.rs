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
