use super::*;
use crate::game::intersections::IntersectionIndex;
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use crate::game::traffic::TrafficOccupancy;

#[test]
fn congestion_affects_route_choice_between_parallel_lanes() {
    // Two parallel east-bound lane tiles (y=0 lane0, y=1 lane1) from x=0..3.
    // We congest the lower lane around the middle so pathfinding should lane-change to avoid it.
    let mut grid = MapGrid::new(4, 2);
    for x in 0..4 {
        let pos0 = TilePos { x, y: 0 };
        let mut c0 = grid.get(pos0).unwrap_or_default();
        c0.water = false;
        c0.road = RoadCell {
            kind: RoadKind::FourLane,
            dir: RoadDir::East,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos0, c0);

        let pos1 = TilePos { x, y: 1 };
        let mut c1 = grid.get(pos1).unwrap_or_default();
        c1.water = false;
        c1.road = RoadCell {
            kind: RoadKind::FourLane,
            dir: RoadDir::East,
            lane: 1,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos1, c1);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);
    assert!(graph.is_built_for(gv.0));

    // Congest tiles (1,0) and (2,0) to push the route onto y=1.
    let mut traffic = TrafficOccupancy::default();
    traffic.ensure_len(grid.len());
    let idx_10 = grid.idx(TilePos { x: 1, y: 0 }).unwrap();
    let idx_20 = grid.idx(TilePos { x: 2, y: 0 }).unwrap();
    traffic.per_tick_vehicles[idx_10] = 6;
    traffic.per_tick_vehicles[idx_20] = 6;

    let cfg = PathfindingConfig::default();
    let mut cache = PathCache::default();
    let intersections = IntersectionIndex::default();
    let mut ctx = PathfindingCtx {
        time_now_sec: 0.0,
        cfg: &cfg,
        cache: &mut cache,
        graph: &graph,
        regions: None,
        traffic: &traffic,
        grid: &grid,
        intersections: &intersections,
    };

    let start = TilePos { x: 0, y: 0 };
    let goal = TilePos { x: 3, y: 0 };
    let path = find_road_path_cached(&mut ctx, start, goal);

    assert_eq!(path.first().copied(), Some(start));
    assert_eq!(path.last().copied(), Some(goal));
    assert!(
        path.iter().any(|p| p.y == 1),
        "Expected path to use the alternate lane due to congestion"
    );
    assert!(
        !path.contains(&TilePos { x: 1, y: 0 }),
        "Expected path to avoid congested tile (1,0)"
    );
    assert!(
        !path.contains(&TilePos { x: 2, y: 0 }),
        "Expected path to avoid congested tile (2,0)"
    );
}

#[test]
fn lane_type_left_turn_only_allows_only_left_entry_into_intersection() {
    // Lane tile at (1,1) going North, surrounded by intersection tiles on North/West/East.
    let mut grid = MapGrid::new(3, 3);
    let lane = TilePos { x: 1, y: 1 };

    let mut c = grid.get(lane).unwrap_or_default();
    c.water = false;
    c.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::North,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::LeftTurnOnly,
    };
    grid.set(lane, c);

    for pos in [
        TilePos { x: 1, y: 2 },
        TilePos { x: 0, y: 1 },
        TilePos { x: 2, y: 1 },
    ] {
        let mut ic = grid.get(pos).unwrap_or_default();
        ic.water = false;
        ic.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::None,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos, ic);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let idx = grid.idx(lane).unwrap();
    let mask = graph.edges[idx];

    // W=bit0, E=bit1, S=bit2, N=bit3
    assert_ne!(
        mask & (1 << 0),
        0,
        "left turn should be allowed (West entry)"
    );
    assert_eq!(mask & (1 << 1), 0, "right entry should be blocked");
    assert_eq!(mask & (1 << 3), 0, "straight entry should be blocked");
}

#[test]
fn lane_type_right_turn_only_allows_only_right_entry_into_intersection() {
    let mut grid = MapGrid::new(3, 3);
    let lane = TilePos { x: 1, y: 1 };

    let mut c = grid.get(lane).unwrap_or_default();
    c.water = false;
    c.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::North,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::RightTurnOnly,
    };
    grid.set(lane, c);

    for pos in [
        TilePos { x: 1, y: 2 },
        TilePos { x: 0, y: 1 },
        TilePos { x: 2, y: 1 },
    ] {
        let mut ic = grid.get(pos).unwrap_or_default();
        ic.water = false;
        ic.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::None,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos, ic);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let idx = grid.idx(lane).unwrap();
    let mask = graph.edges[idx];

    assert_eq!(mask & (1 << 0), 0, "left entry should be blocked");
    assert_ne!(
        mask & (1 << 1),
        0,
        "right turn should be allowed (East entry)"
    );
    assert_eq!(mask & (1 << 3), 0, "straight entry should be blocked");
}

#[test]
fn lane_type_straight_only_allows_only_straight_entry_into_intersection() {
    let mut grid = MapGrid::new(3, 3);
    let lane = TilePos { x: 1, y: 1 };

    let mut c = grid.get(lane).unwrap_or_default();
    c.water = false;
    c.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::North,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::StraightOnly,
    };
    grid.set(lane, c);

    for pos in [
        TilePos { x: 1, y: 2 },
        TilePos { x: 0, y: 1 },
        TilePos { x: 2, y: 1 },
    ] {
        let mut ic = grid.get(pos).unwrap_or_default();
        ic.water = false;
        ic.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::None,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos, ic);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let idx = grid.idx(lane).unwrap();
    let mask = graph.edges[idx];

    assert_eq!(mask & (1 << 0), 0, "left entry should be blocked");
    assert_eq!(mask & (1 << 1), 0, "right entry should be blocked");
    assert_ne!(
        mask & (1 << 3),
        0,
        "straight should be allowed (North entry)"
    );
}

#[test]
fn intersection_exit_requires_lane_dir_alignment() {
    let mut grid = MapGrid::new(3, 3);
    let intersection = TilePos { x: 1, y: 1 };

    let mut ic = grid.get(intersection).unwrap_or_default();
    ic.water = false;
    ic.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::None,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(intersection, ic);

    // North neighbor points South (opposite to move_dir North) -> should be blocked.
    let north = TilePos { x: 1, y: 2 };
    let mut n = grid.get(north).unwrap_or_default();
    n.water = false;
    n.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::South,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(north, n);

    // South neighbor points South (matches move_dir South) -> should be allowed.
    let south = TilePos { x: 1, y: 0 };
    let mut s = grid.get(south).unwrap_or_default();
    s.water = false;
    s.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::South,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(south, s);

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let idx = grid.idx(intersection).unwrap();
    let mask = graph.edges[idx];

    assert_eq!(
        mask & (1 << 3),
        0,
        "exit into opposite-direction lane should be blocked"
    );
    assert_ne!(
        mask & (1 << 2),
        0,
        "exit into matching-direction lane should be allowed"
    );
}

#[test]
fn lane_entry_blocks_reverse_into_intersection() {
    let mut grid = MapGrid::new(3, 3);
    let intersection = TilePos { x: 1, y: 1 };

    let mut ic = grid.get(intersection).unwrap_or_default();
    ic.water = false;
    ic.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::None,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(intersection, ic);

    // South lane points North (approach) -> forward entry should be allowed.
    let south = TilePos { x: 1, y: 0 };
    let mut s = grid.get(south).unwrap_or_default();
    s.water = false;
    s.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::North,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(south, s);

    // North lane also points North (moving away) -> reverse entry should be blocked.
    let north = TilePos { x: 1, y: 2 };
    let mut n = grid.get(north).unwrap_or_default();
    n.water = false;
    n.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::North,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(north, n);

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let south_idx = grid.idx(south).unwrap();
    let north_idx = grid.idx(north).unwrap();
    let south_mask = graph.edges[south_idx];
    let north_mask = graph.edges[north_idx];

    assert_ne!(
        south_mask & (1 << 3),
        0,
        "forward entry into intersection should be allowed"
    );
    assert_eq!(
        north_mask & (1 << 2),
        0,
        "reverse entry into intersection should be blocked"
    );
}

/// Shared fixture: 2x2 FourLane intersection cluster in the center of a 5x5 grid with:
/// - approaches from South (two North-bound lanes): (2,1)=rightmost, (3,1)=leftmost
/// - exits to North (straight) and West (left)
///
/// `autogen_turn_lanes` marks (3,1) `LeftTurnOnly` and (2,1) `StraightOnly` on this layout.
fn four_lane_turn_intersection_grid() -> MapGrid {
    let mut grid = MapGrid::new(5, 5);

    // South approaches (two lanes in the same travel direction).
    for (pos, lane) in [
        (TilePos { x: 2, y: 1 }, 0u8), // rightmost for North-bound
        (TilePos { x: 3, y: 1 }, 1u8), // leftmost for North-bound
    ] {
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::FourLane,
            dir: RoadDir::North,
            lane,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, c);
    }

    // 2x2 intersection cluster tiles.
    for pos in [
        TilePos { x: 2, y: 2 },
        TilePos { x: 3, y: 2 },
        TilePos { x: 2, y: 3 },
        TilePos { x: 3, y: 3 },
    ] {
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::FourLane,
            dir: RoadDir::None,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, c);
    }

    // Exits: straight North (dir North, behind is intersection), left West (dir West).
    for (pos, dir) in [
        (TilePos { x: 2, y: 4 }, RoadDir::North), // back=(2,3) is intersection
        (TilePos { x: 1, y: 3 }, RoadDir::West),  // back=(2,3) is intersection
    ] {
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, c);
    }

    grid
}

#[test]
fn autogen_turn_lanes_four_lane_two_lanes_assigns_left_and_straight_only() {
    let mut grid = four_lane_turn_intersection_grid();

    super::turn_lanes::autogen_turn_lanes_inner(&mut grid);

    let right = grid.get(TilePos { x: 2, y: 1 }).unwrap().road.lane_type;
    let left = grid.get(TilePos { x: 3, y: 1 }).unwrap().road.lane_type;

    assert_eq!(left, LaneType::LeftTurnOnly);
    assert_eq!(right, LaneType::StraightOnly);
}

/// Ordering pin (audit 2026-07-06, HIGH): `autogen_turn_lanes` mutates `MapGrid` lane-type marks
/// and `rebuild_road_graph` bakes those marks into edges cached for a whole `GraphVersion`.
/// With the production `TransportPlugin` wiring, one FixedUpdate run must produce a road graph
/// that already reflects this version's autogen marks: the LeftTurnOnly leftmost approach (3,1)
/// must NOT have a straight (North) entry edge into the intersection.
#[test]
fn autogen_turn_lanes_feeds_road_graph_on_fixed_update() {
    let mut app = App::new();
    app.add_plugins(super::TransportPlugin)
        .insert_resource(four_lane_turn_intersection_grid())
        // Fresh version nothing has been built for (autogen state + all graphs start at 0/None).
        .insert_resource(GraphVersion(7))
        .init_resource::<IntersectionIndex>()
        .init_resource::<crate::game::traffic::TrafficConfig>();

    app.world_mut().run_schedule(FixedUpdate);

    let grid = app.world().resource::<MapGrid>();
    let leftmost = TilePos { x: 3, y: 1 };
    let rightmost = TilePos { x: 2, y: 1 };
    assert_eq!(
        grid.get(leftmost).unwrap().road.lane_type,
        LaneType::LeftTurnOnly,
        "autogen must have marked the leftmost approach this tick"
    );

    let graph = app.world().resource::<RoadGraph>();
    assert!(graph.is_built_for(7), "road graph must be built this tick");
    let left_mask = graph.edges[grid.idx(leftmost).unwrap()];
    let right_mask = graph.edges[grid.idx(rightmost).unwrap()];
    // W=bit0, E=bit1, S=bit2, N=bit3. Straight entry (North) into the cluster:
    assert_eq!(
        left_mask & (1 << 3),
        0,
        "LeftTurnOnly approach must not get a straight entry edge — the road graph was built \
         from the PRE-autogen grid (autogen_turn_lanes must run before rebuild_road_graph)"
    );
    assert_ne!(
        right_mask & (1 << 3),
        0,
        "StraightOnly approach keeps its straight entry edge (sanity: graph is non-trivial)"
    );
}

/// Negative-control for the pin above: wiring the REVERSE order (road graph before autogen)
/// must bake the stale Regular lane-type into the cached edges — proving the positive test's
/// assertion is sensitive to the system order and not a tautology.
#[test]
fn road_graph_before_autogen_bakes_stale_lane_marks() {
    let mut app = App::new();
    app.insert_resource(four_lane_turn_intersection_grid())
        .insert_resource(GraphVersion(7))
        .init_resource::<RoadGraph>()
        .init_resource::<super::turn_lanes::TurnLaneAutogenState>()
        .add_systems(
            FixedUpdate,
            (
                super::road_graph::rebuild_road_graph,
                super::turn_lanes::autogen_turn_lanes,
            )
                .chain(),
        );

    app.world_mut().run_schedule(FixedUpdate);

    let grid = app.world().resource::<MapGrid>();
    let leftmost = TilePos { x: 3, y: 1 };
    assert_eq!(
        grid.get(leftmost).unwrap().road.lane_type,
        LaneType::LeftTurnOnly,
        "autogen still ran (after the graph)"
    );
    let graph = app.world().resource::<RoadGraph>();
    let left_mask = graph.edges[grid.idx(leftmost).unwrap()];
    assert_ne!(
        left_mask & (1 << 3),
        0,
        "reverse order must bake the stale Regular mark (straight entry present) — \
         if this starts failing the positive pin above has become tautological"
    );
}

/// Version-guard pin: with an unchanged `GraphVersion` the second FixedUpdate run must NOT
/// rebuild the `LaneGraph` — a sentinel mutation planted after run 1 survives run 2, and is
/// wiped after a version bump.
#[test]
fn lane_graph_skips_rebuild_for_unchanged_graph_version() {
    let mut grid = MapGrid::new(2, 1);
    let pos = TilePos { x: 0, y: 0 };
    let mut c = grid.get(pos).unwrap_or_default();
    c.water = false;
    c.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir: RoadDir::East,
        lane: 0,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(pos, c);

    let mut app = App::new();
    app.insert_resource(grid)
        .insert_resource(GraphVersion(3))
        .init_resource::<LaneGraph>()
        .add_systems(FixedUpdate, build_lane_graph);

    app.world_mut().run_schedule(FixedUpdate);
    {
        let grid = app.world().resource::<MapGrid>().clone();
        assert!(app.world().resource::<LaneGraph>().is_built_for(3, &grid));
    }

    let sentinel = TilePos { x: 99, y: 99 };
    app.world_mut()
        .resource_mut::<LaneGraph>()
        .pos_to_id
        .insert(sentinel, LaneId(777));

    app.world_mut().run_schedule(FixedUpdate);
    assert!(
        app.world()
            .resource::<LaneGraph>()
            .pos_to_id
            .contains_key(&sentinel),
        "unchanged GraphVersion must not trigger a LaneGraph rebuild"
    );

    app.world_mut().resource_mut::<GraphVersion>().bump();
    app.world_mut().run_schedule(FixedUpdate);
    let lanes = app.world().resource::<LaneGraph>();
    assert!(
        !lanes.pos_to_id.contains_key(&sentinel),
        "a GraphVersion bump must rebuild the LaneGraph (sentinel wiped)"
    );
    let grid = app.world().resource::<MapGrid>();
    assert!(lanes.is_built_for(4, grid));
}

/// Empty-but-valid build pin: a roadless map builds an EMPTY `LaneGraph`, which must still
/// count as built for its version (explicit `built_for` instead of inferring from content) —
/// otherwise empty maps rebuild the graph every tick.
#[test]
fn lane_graph_empty_build_counts_as_built() {
    let mut app = App::new();
    app.insert_resource(MapGrid::new(4, 4)) // no roads at all
        .insert_resource(GraphVersion(3))
        .init_resource::<LaneGraph>()
        .add_systems(FixedUpdate, build_lane_graph);

    app.world_mut().run_schedule(FixedUpdate);
    {
        let grid = app.world().resource::<MapGrid>();
        let lanes = app.world().resource::<LaneGraph>();
        assert!(lanes.lanes.is_empty(), "roadless map builds an empty graph");
        assert!(
            lanes.is_built_for(3, grid),
            "empty build still counts as built"
        );
    }

    let sentinel = TilePos { x: 99, y: 99 };
    app.world_mut()
        .resource_mut::<LaneGraph>()
        .pos_to_id
        .insert(sentinel, LaneId(777));

    app.world_mut().run_schedule(FixedUpdate);
    assert!(
        app.world()
            .resource::<LaneGraph>()
            .pos_to_id
            .contains_key(&sentinel),
        "an empty-but-valid LaneGraph must not be rebuilt every tick"
    );
}

/// Same empty-but-valid pin for `LaneletGraph`: an intersection-free map legitimately builds
/// zero lanelets; the second run for the same `GraphVersion` must early-return, and a bump
/// must rebuild.
#[test]
fn lanelet_graph_empty_build_counts_as_built() {
    let mut app = App::new();
    app.insert_resource(MapGrid::new(4, 4)) // no roads -> no intersections -> no lanelets
        .insert_resource(GraphVersion(3))
        .init_resource::<IntersectionIndex>()
        .init_resource::<LaneGraph>()
        .init_resource::<LaneletGraph>()
        .init_resource::<LaneletConflictMatrices>()
        .init_resource::<crate::game::traffic::TrafficConfig>()
        .add_systems(FixedUpdate, build_lanelet_graph);

    app.world_mut().run_schedule(FixedUpdate);
    {
        let grid = app.world().resource::<MapGrid>();
        let lanelets = app.world().resource::<LaneletGraph>();
        assert!(lanelets.lanelets.is_empty());
        assert!(
            lanelets.is_built_for(3, grid),
            "empty lanelet build still counts as built"
        );
    }

    app.world_mut()
        .resource_mut::<LaneletGraph>()
        .by_entry_lane
        .insert(LaneId(42), Vec::new());

    app.world_mut().run_schedule(FixedUpdate);
    assert!(
        app.world()
            .resource::<LaneletGraph>()
            .by_entry_lane
            .contains_key(&LaneId(42)),
        "an empty-but-valid LaneletGraph must not be rebuilt every tick"
    );

    app.world_mut().resource_mut::<GraphVersion>().bump();
    app.world_mut().run_schedule(FixedUpdate);
    let grid = app.world().resource::<MapGrid>();
    let lanelets = app.world().resource::<LaneletGraph>();
    assert!(
        !lanelets.by_entry_lane.contains_key(&LaneId(42)),
        "a GraphVersion bump must rebuild the LaneletGraph (sentinel wiped)"
    );
    assert!(lanelets.is_built_for(4, grid));
}

#[test]
fn one_way_ignores_opposite_direction_lane_tiles() {
    // Three adjacent tiles, all marked one-way East:
    // - left tile is incorrectly "West" dir (should be ignored)
    // - middle/right tiles are "East" dir (valid)
    // The middle one should have a usable outgoing edge to the right.
    let mut grid = MapGrid::new(3, 1);

    let west_lane = TilePos { x: 0, y: 0 };
    let east_lane_mid = TilePos { x: 1, y: 0 };
    let east_lane_end = TilePos { x: 2, y: 0 };

    for (pos, dir) in [
        (west_lane, RoadDir::West),
        (east_lane_mid, RoadDir::East),
        (east_lane_end, RoadDir::East),
    ] {
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane: 0,
            flow: crate::game::roads::RoadFlow::OneWay(RoadDir::East),
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos, c);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let idx_bad = grid.idx(west_lane).unwrap();
    let idx_ok = grid.idx(east_lane_mid).unwrap();

    assert_eq!(
        graph.edges[idx_bad], 0,
        "opposite-direction lane should be ignored"
    );
    assert_ne!(
        graph.edges[idx_ok], 0,
        "valid one-way lane should remain usable"
    );
}

#[test]
fn one_way_allows_lane_change_between_same_direction_lanes() {
    // Two parallel eastbound lanes (y=0 and y=1), both one-way East.
    // Ensure lane-change edge is not blocked by one-way logic (perpendicular move).
    let mut grid = MapGrid::new(1, 2);

    for y in 0..2 {
        let pos = TilePos { x: 0, y };
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: y as u8,
            flow: crate::game::roads::RoadFlow::OneWay(RoadDir::East),
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(pos, c);
    }

    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let idx0 = grid.idx(TilePos { x: 0, y: 0 }).unwrap();
    let idx1 = grid.idx(TilePos { x: 0, y: 1 }).unwrap();

    // From y=0 to y=1 is a North move (bit3).
    assert_ne!(
        graph.edges[idx0] & (1 << 3),
        0,
        "lane-change across one-way lanes should be allowed"
    );
    // From y=1 to y=0 is a South move (bit2).
    assert_ne!(
        graph.edges[idx1] & (1 << 2),
        0,
        "lane-change across one-way lanes should be allowed"
    );
}

/// R11 regression (`adjacent_road_towards`): when no adjacent lane matches the desired direction,
/// the anchor must prefer a NON-OPPOSITE lane (perpendicular is fine) over the oncoming one —
/// otherwise trips anchor (and cars visually spawn) on the встречка. The wrong-way carriageway of
/// a one-way road must never be an anchor at all.
#[test]
fn adjacent_road_anchor_never_prefers_oncoming_lane() {
    let mut grid = MapGrid::new(6, 6);
    let mut put = |pos: TilePos, dir: RoadDir, flow: RoadFlow| {
        let mut cell = grid.get(pos).unwrap_or_default();
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane: 0,
            flow,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    };

    // Building anchor at (2,2); target far EAST -> desired dir East.
    // South neighbor (2,1): WESTBOUND lane (the oncoming side of an E-W road).
    // North neighbor (2,3): NORTHBOUND lane (perpendicular, drivable).
    put(TilePos { x: 2, y: 1 }, RoadDir::West, RoadFlow::TwoWay);
    put(TilePos { x: 2, y: 3 }, RoadDir::North, RoadFlow::TwoWay);

    let anchor = adjacent_road_towards(&grid, TilePos { x: 2, y: 2 }, TilePos { x: 5, y: 2 });
    assert_eq!(
        anchor,
        Some(TilePos { x: 2, y: 3 }),
        "anchor must prefer the perpendicular drivable lane over the oncoming one"
    );

    // One-way: the wrong-way carriageway is not drivable and must never anchor.
    let mut grid2 = MapGrid::new(6, 6);
    let mut put2 = |pos: TilePos, dir: RoadDir, flow: RoadFlow| {
        let mut cell = grid2.get(pos).unwrap_or_default();
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane: 0,
            flow,
            lane_type: LaneType::Regular,
        };
        grid2.set(pos, cell);
    };
    // Only adjacent road: a one-way(East) road's wrong-way half (dir West).
    put2(
        TilePos { x: 2, y: 1 },
        RoadDir::West,
        RoadFlow::OneWay(RoadDir::East),
    );
    let anchor2 = adjacent_road_towards(&grid2, TilePos { x: 2, y: 2 }, TilePos { x: 5, y: 2 });
    assert_eq!(
        anchor2, None,
        "the wrong-way half of a one-way road must never be a trip anchor"
    );
}

/// Build a two-column two-way vertical road (col `nx` = North lanes, col `sx` = South lanes) from
/// y=1..=4, with the north end open (nothing at y=5) so `(nx,4)` is a physical dead-end. `flow`
/// applies to the North column (to exercise the one-way negative case).
fn build_two_way_vertical_spur(nx: i32, sx: i32, north_flow: RoadFlow) -> MapGrid {
    let mut grid = MapGrid::new(8, 8);
    let mut put = |x: i32, y: i32, dir: RoadDir, flow: RoadFlow| {
        let pos = TilePos { x, y };
        let mut cell = grid.get(pos).unwrap_or_default();
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane: 0,
            flow,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    };
    for y in 1..=4 {
        put(nx, y, RoadDir::North, north_flow);
        put(sx, y, RoadDir::South, RoadFlow::TwoWay);
    }
    grid
}

#[test]
fn uturn_edge_added_at_two_way_dead_end() {
    // North column x=5, South column x=4 (opp is the WEST neighbor of the North tile).
    let grid = build_two_way_vertical_spur(5, 4, RoadFlow::TwoWay);
    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let west_bit = 1u8 << 0;
    let dead_end = grid.idx(TilePos { x: 5, y: 4 }).unwrap();
    assert!(
        graph.edges[dead_end] & west_bit != 0,
        "two-way dead-end (5,4)North must gain a U-turn edge WEST to the opposite (4,4)South lane"
    );

    // A mid-spur North tile has a real road ahead -> NOT a dead-end -> no cross-centerline edge.
    let mid = grid.idx(TilePos { x: 5, y: 2 }).unwrap();
    assert!(
        graph.edges[mid] & west_bit == 0,
        "mid-road (5,2) must NOT gain a cross-centerline U-turn edge (only physical dead-ends do)"
    );
}

#[test]
fn no_uturn_edge_on_one_way_dead_end() {
    // North column is one-way(North): the opposite carriageway is not a legal turn-around target.
    let grid = build_two_way_vertical_spur(5, 4, RoadFlow::OneWay(RoadDir::North));
    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let west_bit = 1u8 << 0;
    let dead_end = grid.idx(TilePos { x: 5, y: 4 }).unwrap();
    assert!(
        graph.edges[dead_end] & west_bit == 0,
        "one-way dead-end must NOT gain a U-turn edge (no legal opposite carriageway)"
    );
}
