//! Lane-based A* pathfinding.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::game::map::TilePos;

use super::lane_graph::{LaneGraph, LaneId};

/// Find a path through the lane graph.
pub fn find_lane_path(graph: &LaneGraph, start: LaneId, goal: LaneId) -> Vec<LaneId> {
    if start == goal {
        return vec![start];
    }

    let mut came_from: Vec<Option<LaneId>> = vec![None; graph.lanes.len()];
    let mut best_g: Vec<u32> = vec![u32::MAX; graph.lanes.len()];
    let mut heap = BinaryHeap::<HeapState>::new();

    best_g[start.as_usize()] = 0;
    heap.push(HeapState {
        g: 0,
        f: heuristic_lane(start, goal, graph),
        idx: start,
    });

    while let Some(HeapState { g, idx, .. }) = heap.pop() {
        if g != best_g[idx.as_usize()] {
            continue; // Stale entry
        }

        if idx == goal {
            return reconstruct_lane_path(&came_from, start, goal);
        }

        // Explore neighbors
        for &next_id in graph.get_connections(idx) {
            let step_cost = 1u32; // Base cost per lane transition
            let ng = g + step_cost;

            if ng < best_g[next_id.as_usize()] {
                best_g[next_id.as_usize()] = ng;
                came_from[next_id.as_usize()] = Some(idx);
                let f = ng + heuristic_lane(next_id, goal, graph);
                heap.push(HeapState {
                    g: ng,
                    f,
                    idx: next_id,
                });
            }
        }
    }

    Vec::new() // No path found
}

#[derive(Copy, Clone, Eq, PartialEq)]
struct HeapState {
    f: u32,
    g: u32,
    idx: LaneId,
}

impl Ord for HeapState {
    fn cmp(&self, other: &Self) -> Ordering {
        other.f.cmp(&self.f).then_with(|| other.g.cmp(&self.g))
    }
}

impl PartialOrd for HeapState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Manhattan distance heuristic for lanes.
fn heuristic_lane(a: LaneId, b: LaneId, graph: &LaneGraph) -> u32 {
    let Some(lane_a) = graph.get_lane(a) else {
        return u32::MAX;
    };
    let Some(lane_b) = graph.get_lane(b) else {
        return u32::MAX;
    };

    let dx = (lane_a.pos.x - lane_b.pos.x).unsigned_abs();
    let dy = (lane_a.pos.y - lane_b.pos.y).unsigned_abs();
    dx + dy
}

fn reconstruct_lane_path(came_from: &[Option<LaneId>], start: LaneId, goal: LaneId) -> Vec<LaneId> {
    let mut path = vec![goal];
    let mut current = goal;

    while current != start {
        let Some(prev) = came_from[current.as_usize()] else {
            break;
        };
        path.push(prev);
        current = prev;
    }

    path.reverse();
    path
}

/// Convert lane path to tile positions (for backward compatibility).
pub fn lane_path_to_tiles(path: &[LaneId], graph: &LaneGraph) -> Vec<TilePos> {
    path.iter()
        .filter_map(|&lane_id| graph.get_lane(lane_id).map(|l| l.pos))
        .collect()
}
