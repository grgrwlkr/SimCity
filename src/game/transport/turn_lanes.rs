use std::collections::{HashMap, HashSet};

use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, build_intersection_clusters};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadDir, RoadFlow};

use super::GraphVersion;

/// Tracks whether derived turn-lane markings were computed for a given `GraphVersion`.
#[derive(Resource, Default)]
#[allow(dead_code)] // Reserved for future turn lane autogen feature
pub struct TurnLaneAutogenState {
    pub(super) version: u64,
}

#[allow(dead_code)] // Used by autogen_turn_lanes_inner
fn offset(pos: TilePos, d: IVec2) -> TilePos {
    TilePos {
        x: pos.x + d.x,
        y: pos.y + d.y,
    }
}

#[allow(dead_code)] // Reserved for future turn lane autogen feature
pub fn autogen_turn_lanes(
    gv: Res<GraphVersion>,
    mut grid: ResMut<MapGrid>,
    mut state: ResMut<TurnLaneAutogenState>,
) {
    if state.version == gv.0 {
        return;
    }
    state.version = gv.0;

    autogen_turn_lanes_inner(&mut grid);
}

#[allow(dead_code)] // Reserved for future turn lane autogen feature
pub(super) fn autogen_turn_lanes_inner(grid: &mut MapGrid) {
    // Reset any old markings (roads may have changed).
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(mut cell) = grid.get(pos) else {
                continue;
            };
            if cell.water || !cell.road.is_some() || cell.road.dir == RoadDir::None {
                continue;
            }
            if cell.road.lane_type != LaneType::Regular {
                cell.road.lane_type = LaneType::Regular;
                grid.set(pos, cell);
            }
        }
    }

    // Derive intersection clusters from the grid (same logic as `IntersectionIndex`).
    let (clusters, tile_to_intersection) = build_intersection_clusters(grid);

    // For each cluster: which travel directions exist for exit lanes?
    let mut exit_dirs_by_id = HashMap::<IntersectionId, HashSet<RoadDir>>::new();
    // For each (cluster, entry_dir): set of approach lane tiles (deduped).
    let mut approaches = HashMap::<(IntersectionId, RoadDir), HashSet<TilePos>>::new();

    for c in &clusters {
        for &t in &c.tiles {
            for neigh in [RoadDir::West, RoadDir::East, RoadDir::South, RoadDir::North] {
                let npos = offset(t, neigh.delta());
                let Some(ncell) = grid.get(npos) else {
                    continue;
                };
                if ncell.water || !ncell.road.is_some() || ncell.road.dir == RoadDir::None {
                    continue;
                }
                // Ignore "wrong-way" lane tiles on one-way roads (they're not usable by routing).
                if let RoadFlow::OneWay(one_way_dir) = ncell.road.flow
                    && ncell.road.dir != one_way_dir
                {
                    continue;
                }

                let dir = ncell.road.dir;
                let fwd = offset(npos, dir.delta());
                let back = offset(npos, dir.opposite().delta());

                if tile_to_intersection.get(&fwd) == Some(&c.id) {
                    // Approaching the cluster (lane points into it).
                    approaches.entry((c.id, dir)).or_default().insert(npos);
                } else if tile_to_intersection.get(&back) == Some(&c.id) {
                    // Exiting the cluster (lane points away from it).
                    exit_dirs_by_id.entry(c.id).or_default().insert(dir);
                }
            }
        }
    }

    // Apply conservative heuristics:
    // - Only mark turn lanes when there are at least 2 approach lanes for the direction.
    // - FourLane (2 lanes per dir): dedicate leftmost to LeftTurnOnly when available;
    //   dedicate rightmost to RightTurnOnly only if there is no left+straight combination.
    // - SixLane (3+ lanes per dir): leftmost=LeftTurnOnly, rightmost=RightTurnOnly, middle=StraightOnly.
    for ((id, entry_dir), lane_tiles) in approaches {
        let Some(exit_dirs) = exit_dirs_by_id.get(&id) else {
            continue;
        };

        let has_straight = exit_dirs.contains(&entry_dir);
        let has_left = exit_dirs.contains(&entry_dir.left());
        let has_right = exit_dirs.contains(&entry_dir.right());

        let lanes_in_dir = lane_tiles.len();
        if lanes_in_dir <= 1 {
            continue;
        }

        for pos in lane_tiles {
            let Some(mut cell) = grid.get(pos) else {
                continue;
            };
            if cell.water || !cell.road.is_some() || cell.road.dir != entry_dir {
                continue;
            }

            let is_leftmost = cell.road.is_leftmost_for_dir();
            let is_rightmost = cell.road.is_rightmost_for_dir();

            let next_type = if lanes_in_dir >= 3 {
                if is_leftmost && has_left {
                    LaneType::LeftTurnOnly
                } else if is_rightmost && has_right {
                    LaneType::RightTurnOnly
                } else if has_straight {
                    LaneType::StraightOnly
                } else {
                    LaneType::Regular
                }
            } else {
                // lanes_in_dir == 2
                if !has_straight && has_left && has_right {
                    if is_leftmost {
                        LaneType::LeftTurnOnly
                    } else if is_rightmost {
                        LaneType::RightTurnOnly
                    } else {
                        LaneType::Regular
                    }
                } else if has_left && has_straight {
                    if is_leftmost {
                        LaneType::LeftTurnOnly
                    } else if has_right {
                        // Keep a general lane to allow straight+right.
                        LaneType::Regular
                    } else {
                        LaneType::StraightOnly
                    }
                } else if has_right && has_straight && !has_left {
                    if is_rightmost {
                        LaneType::RightTurnOnly
                    } else {
                        LaneType::StraightOnly
                    }
                } else if has_left && !has_straight && !has_right && is_leftmost {
                    LaneType::LeftTurnOnly
                } else if has_right && !has_straight && !has_left && is_rightmost {
                    LaneType::RightTurnOnly
                } else {
                    LaneType::Regular
                }
            };

            if cell.road.lane_type != next_type {
                cell.road.lane_type = next_type;
                grid.set(pos, cell);
            }
        }
    }
}
