//! Flag-ON end-to-end integration test for the lanelet intersection arbiter (P3c gate): build a real
//! cross intersection + lanelet graph, spawn two conflicting approaching vehicles (with EMPTY sidecar
//! plans, so the arbiter's precise-fallback resolves their lanelets from route geometry), run the
//! flag-on arbiter, and assert collision-safety (exactly one admitted), the tripwire stays empty, and
//! the outcome is deterministic across two identical seeded worlds.

use super::*;
use crate::game::intersections::{IntersectionCluster, LeftTurnDemand};
use crate::game::traffic::intersection::{
    ApproachFairness, ArbiterIndexCache, ArbiterTickStats, LaneletStallTracker, RingTopologyStatus,
    arbitrate_lanelet_reservations,
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

/// Build a flag-on arbiter app on the cross grid, spawn an eastbound + a northbound through vehicle
/// (both one tile before the box, empty sidecar -> precise-fallback), run build + arbiter once, and
/// return whether each is reserved + the tripwire state.
fn run_arbiter_once() -> (bool, bool, bool) {
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
        .init_resource::<LaneletStallTracker>()
        .init_resource::<RingTopologyStatus>();

    app.add_systems(
        Update,
        (build_lanelet_graph, arbitrate_lanelet_reservations).chain(),
    );

    // Eastbound through (approach (3,4) -> cluster -> exit (6,4)); northbound through (approach
    // (4,3) -> cluster -> exit (4,6)). Their lanelets share the (4,4) entry corner -> they conflict.
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

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    (
        res.is_reserved_by(IntersectionId(0), east),
        res.is_reserved_by(IntersectionId(0), north),
        res.stall_tripwire(),
    )
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
