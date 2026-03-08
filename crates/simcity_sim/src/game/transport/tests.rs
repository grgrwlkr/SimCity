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
            kind: RoadKind::TwoLane,
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
            kind: RoadKind::TwoLane,
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

#[test]
fn autogen_turn_lanes_four_lane_two_lanes_assigns_left_and_straight_only() {
    // 2x2 intersection cluster in the center with:
    // - approaches from South (two North-bound lanes)
    // - exits to North (straight) and West (left)
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

    super::turn_lanes::autogen_turn_lanes_inner(&mut grid);

    let right = grid.get(TilePos { x: 2, y: 1 }).unwrap().road.lane_type;
    let left = grid.get(TilePos { x: 3, y: 1 }).unwrap().road.lane_type;

    assert_eq!(left, LaneType::LeftTurnOnly);
    assert_eq!(right, LaneType::StraightOnly);
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
