use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{RoadCell, RoadDir};

use super::GraphVersion;

/// Compact road graph: per-tile bitmask of connected road neighbors + list of road nodes.
#[derive(Resource, Debug, Default, Clone)]
pub struct RoadGraph {
    pub version: u64,
    pub width: usize,
    pub height: usize,
    /// For each tile idx: 4-bit mask (W,E,N,S) indicating adjacent connected road tiles.
    pub edges: Vec<u8>,
    /// Cached list of road tile indices (for random selection / iteration).
    pub road_indices: Vec<usize>,
}

impl RoadGraph {
    pub fn is_built_for(&self, version: u64) -> bool {
        self.version == version && !self.edges.is_empty()
    }
}

pub(super) fn rebuild_road_graph(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut graph: ResMut<RoadGraph>,
) {
    rebuild_road_graph_inner(&grid, &gv, &mut graph);
}

pub fn rebuild_road_graph_inner(grid: &MapGrid, gv: &GraphVersion, graph: &mut RoadGraph) {
    if graph.is_built_for(gv.0)
        && graph.width == grid.width as usize
        && graph.height == grid.height as usize
    {
        return;
    }

    let w = grid.width as usize;
    let h = grid.height as usize;
    let len = w * h;

    graph.version = gv.0;
    graph.width = w;
    graph.height = h;
    graph.edges.clear();
    graph.edges.resize(len, 0);
    graph.road_indices.clear();

    let road_at_idx = |idx: usize| -> Option<RoadCell> {
        let x = (idx % w) as i32;
        let y = (idx / w) as i32;
        let pos = TilePos { x, y };
        grid.get(pos)
            .and_then(|c| (!c.water && c.road.is_some()).then_some(c.road))
    };

    for idx in 0..len {
        let Some(cur) = road_at_idx(idx) else {
            continue;
        };

        // One-way roads: ignore lane tiles that don't match the one-way direction.
        // This prevents pathfinding from using the "opposite" carriageway tiles on one-way segments.
        if let crate::game::roads::RoadFlow::OneWay(one_way_dir) = cur.flow
            && cur.dir != RoadDir::None
            && cur.dir != one_way_dir
        {
            continue;
        }
        graph.road_indices.push(idx);

        let x = idx % w;
        let y = idx / w;

        let mut mask = 0u8;

        // Movement rules (strict lane-based, right-hand traffic):
        // 1. Straight: move in cur.dir only, to a neighbor lane tile whose dir == cur.dir.
        // 2. Lane change: move left/right (perpendicular), staying in same dir, only to adjacent lane.
        // 3. Turn: move left/right into a tile whose dir matches the movement direction,
        //    only from outer lanes (left turn from leftmost, right turn from rightmost).
        // 4. U-turn: only allowed at intersections (tile with multiple road directions).
        //
        // FORBIDDEN:
        // - Moving against lane direction (driving wrong way).
        // - Crossing into oncoming traffic lanes (except at intersections for turns).
        // - Lane changes to oncoming lanes.
        let mut consider = |bit: u8, nidx: usize, move_dir: RoadDir| {
            let Some(next) = road_at_idx(nidx) else {
                return;
            };

            // One-way roads: reject entering lane tiles that don't match the one-way direction.
            // NOTE: do NOT gate on `move_dir` (lane changes are perpendicular moves).
            if let crate::game::roads::RoadFlow::OneWay(one_way_dir) = next.flow
                && next.dir != RoadDir::None
                && next.dir != one_way_dir
            {
                return;
            }

            // Check lane type restrictions for turn-lane entry.
            // IMPORTANT: apply this only when entering an intersection tile from a lane tile.
            // (Intersection tiles themselves may keep default lane_type values and shouldn't affect circulation.)
            if cur.dir != RoadDir::None && next.dir == RoadDir::None {
                // At intersection - check if lane type allows this movement
                let is_left_turn = move_dir == cur.dir.left();
                let is_right_turn = move_dir == cur.dir.right();
                let is_straight = move_dir == cur.dir;

                match cur.lane_type {
                    crate::game::roads::LaneType::LeftTurnOnly => {
                        // Only allow left turn
                        if !is_left_turn {
                            return;
                        }
                    }
                    crate::game::roads::LaneType::RightTurnOnly => {
                        // Only allow right turn
                        if !is_right_turn {
                            return;
                        }
                    }
                    crate::game::roads::LaneType::StraightOnly => {
                        // Only allow straight
                        if !is_straight {
                            return;
                        }
                    }
                    crate::game::roads::LaneType::Regular => {}
                }
            }

            // Intersection tiles: when exiting a cluster, only allow lanes that match movement dir.
            if cur.dir == RoadDir::None && next.dir != RoadDir::None {
                if next.dir != move_dir {
                    return;
                }
                mask |= 1 << bit;
                return;
            }

            // Entering an intersection: block reverse moves into the cluster.
            if cur.dir != RoadDir::None && next.dir == RoadDir::None {
                if move_dir == cur.dir.opposite() {
                    return;
                }
                mask |= 1 << bit;
                return;
            }

            // Intersection tiles: allow internal cluster connections.
            if cur.dir == RoadDir::None || next.dir == RoadDir::None {
                // Prevent jumping between roads of different kinds through intersections (MVP stability).
                // (E.g., mixing highway and street tiles in same intersection cluster.)
                if cur.kind != next.kind && cur.dir != RoadDir::None && next.dir != RoadDir::None {
                    return;
                }
                mask |= 1 << bit;
                return;
            }

            // Straight: into lane tile with same dir.
            if move_dir == cur.dir && next.dir == cur.dir {
                mask |= 1 << bit;
                return;
            }

            // Lane change: perpendicular move but still in same dir.
            if next.dir == cur.dir {
                let left = cur.dir.left();
                let right = cur.dir.right();
                if (move_dir == left || move_dir == right) && lanes_on_same_road_side(cur, next) {
                    mask |= 1 << bit;
                    return;
                }
            }

            // Turn: perpendicular move into new direction lane tile.
            let left = cur.dir.left();
            let right = cur.dir.right();

            // CRITICAL: Ensure we don't cross into oncoming traffic lanes during turns.
            // For multi-lane roads, lanes are divided: lower indices = one direction, higher = opposite.
            // Turns must stay within the same "side" of the road.

            // Left turn: from leftmost lane → into leftmost lane of new direction.
            if move_dir == left
                && next.dir == left
                && cur.is_leftmost_for_dir()
                && next.is_leftmost_for_dir()
                && lanes_on_same_road_side(cur, next)
            {
                mask |= 1 << bit;
                return;
            }
            // Right turn: from rightmost lane → into rightmost lane of new direction.
            if move_dir == right
                && next.dir == right
                && cur.is_rightmost_for_dir()
                && next.is_rightmost_for_dir()
                && lanes_on_same_road_side(cur, next)
            {
                mask |= 1 << bit;
            }
        };

        // W
        if x > 0 {
            consider(0, idx - 1, RoadDir::West);
        }
        // E
        if x + 1 < w {
            consider(1, idx + 1, RoadDir::East);
        }
        // y decreases -> world down -> South
        if y > 0 {
            consider(2, idx - w, RoadDir::South);
        }
        // y increases -> world up -> North
        if y + 1 < h {
            consider(3, idx + w, RoadDir::North);
        }

        // Dead-end U-turn (two-way roads only). If the tile strictly ahead in `cur.dir` is not a
        // drivable road (map edge / water / gap), the vehicle has reached a PHYSICAL dead-end and
        // cannot continue. Allow it to cross to the opposite-direction carriageway — the
        // perpendicular-adjacent lane tile whose `dir == cur.dir.opposite()` (same road kind) — so
        // road-A* can build "into the spur -> turn around at the tip -> back out". Only genuine
        // dead-ends qualify: on a through road the forward tile IS a road, so no U-turn edge is
        // added and no oncoming appears in the flow. This is what lets a bus/service vehicle leave
        // a stop on the far side of a street's last intersection (road-A*-fallback departure; the
        // lanelet planner has no mid-road U-turns by design). Guarded by the `uturn_*` unit tests
        // here and the router-independent oncoming oracle pin (`simcity_data/route_oncoming_pins`).
        if cur.dir != RoadDir::None && !matches!(cur.flow, crate::game::roads::RoadFlow::OneWay(_))
        {
            let fwd = cur.dir.delta();
            let fx = x as i32 + fwd.x;
            let fy = y as i32 + fwd.y;
            let forward_is_road = fx >= 0
                && fy >= 0
                && (fx as usize) < w
                && (fy as usize) < h
                && road_at_idx((fy as usize) * w + (fx as usize)).is_some();
            if !forward_is_road {
                for perp in [cur.dir.left(), cur.dir.right()] {
                    let pd = perp.delta();
                    let nx = x as i32 + pd.x;
                    let ny = y as i32 + pd.y;
                    if nx < 0 || ny < 0 || (nx as usize) >= w || (ny as usize) >= h {
                        continue;
                    }
                    let Some(opp) = road_at_idx((ny as usize) * w + (nx as usize)) else {
                        continue;
                    };
                    if opp.kind == cur.kind && opp.dir == cur.dir.opposite() {
                        let bit = match perp {
                            RoadDir::West => 0,
                            RoadDir::East => 1,
                            RoadDir::South => 2,
                            RoadDir::North => 3,
                            RoadDir::None => continue,
                        };
                        mask |= 1 << bit;
                    }
                }
            }
        }

        graph.edges[idx] = mask;
    }
}

/// Check if two lanes are on the same side of a multi-lane road.
/// For roads with even number of lanes, lower half = one direction, upper half = opposite.
/// This prevents turns from crossing into oncoming traffic.
fn lanes_on_same_road_side(cur: RoadCell, next: RoadCell) -> bool {
    let cur_lanes = cur.lanes_total();
    let next_lanes = next.lanes_total();

    // Different road types or lane counts - be conservative
    if cur.kind != next.kind || cur_lanes != next_lanes {
        return false;
    }

    let half_lanes = cur_lanes / 2;

    // For single-direction roads (2 lanes), all lanes are same direction
    if cur_lanes <= 2 {
        return true;
    }

    // Check if both lanes are in the same half (same traffic direction)
    let cur_side = if cur.lane < half_lanes { 0 } else { 1 };
    let next_side = if next.lane < half_lanes { 0 } else { 1 };

    cur_side == next_side
}
