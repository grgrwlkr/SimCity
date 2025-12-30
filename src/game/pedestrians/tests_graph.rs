use super::*;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};

#[test]
fn sixlane_has_no_sidewalks_but_intersection_corners_are_walkable() {
    // Grid:
    // - SixLane eastbound lane tile at (0,0)
    // - Intersection tile (dir=None) at (0,1)
    // - Candidate corner tile at (1,1) adjacent to intersection -> should be walkable
    // - Tile (1,0) adjacent only to SixLane segment -> should NOT be walkable
    let mut grid = MapGrid::new(3, 3);

    let sixlane = TilePos { x: 0, y: 0 };
    if let Some(mut cell) = grid.get(sixlane) {
        cell.road = RoadCell {
            kind: RoadKind::SixLane,
            dir: RoadDir::East,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(sixlane, cell);
    }

    let intersection = TilePos { x: 0, y: 1 };
    if let Some(mut cell) = grid.get(intersection) {
        cell.road = RoadCell {
            kind: RoadKind::SixLane,
            dir: RoadDir::None,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(intersection, cell);
    }

    // Build pedestrian graph for this grid.
    let mut graph = PedestrianGraph {
        version: 1,
        width: 3,
        height: 3,
        walkable: vec![false; grid.len()],
    };
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                continue;
            }
            let walk = if cell.road.is_some() {
                cell.road.dir == RoadDir::None
            } else {
                // Inline equivalent of graph rebuild rules:
                // - corner next to intersection OR sidewalk next to a road that provides sidewalk.
                let mut corner = false;
                for npos in [
                    TilePos {
                        x: pos.x - 1,
                        y: pos.y,
                    },
                    TilePos {
                        x: pos.x + 1,
                        y: pos.y,
                    },
                    TilePos {
                        x: pos.x,
                        y: pos.y - 1,
                    },
                    TilePos {
                        x: pos.x,
                        y: pos.y + 1,
                    },
                ] {
                    if let Some(ncell) = grid.get(npos)
                        && !ncell.water
                        && ncell.road.is_some()
                        && ncell.road.dir == RoadDir::None
                    {
                        corner = true;
                        break;
                    }
                }
                if corner {
                    true
                } else {
                    let mut sidewalk = false;
                    for npos in [
                        TilePos {
                            x: pos.x - 1,
                            y: pos.y,
                        },
                        TilePos {
                            x: pos.x + 1,
                            y: pos.y,
                        },
                        TilePos {
                            x: pos.x,
                            y: pos.y - 1,
                        },
                        TilePos {
                            x: pos.x,
                            y: pos.y + 1,
                        },
                    ] {
                        if let Some(ncell) = grid.get(npos)
                            && !ncell.water
                            && ncell.road.is_some()
                            && (ncell.road.dir == RoadDir::None
                                || ncell.road.kind != RoadKind::SixLane)
                        {
                            sidewalk = true;
                            break;
                        }
                    }
                    sidewalk
                }
            };
            if walk && let Some(i) = graph.idx(pos) {
                graph.walkable[i] = true;
            }
        }
    }

    let corner = TilePos { x: 1, y: 1 };
    let near_sixlane_only = TilePos { x: 1, y: 0 };

    assert!(graph.is_walkable(intersection));
    assert!(graph.is_walkable(corner));
    assert!(!graph.is_walkable(near_sixlane_only));
}
