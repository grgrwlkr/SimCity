use std::collections::VecDeque;

use bevy::prelude::*;

use crate::game::map::TilePos;

use super::graph::PedestrianGraph;

/// Scratch buffers for pedestrian BFS routing.
///
/// This avoids per-query allocations like `vec![..len..]` and allows bounded BFS
/// (early cutoff by max steps) for cheap reachability checks.
#[derive(Resource, Debug, Default)]
pub struct PedestrianRoutingScratch {
    epoch: u32,
    seen_epoch: Vec<u32>,
    dist: Vec<u32>,
    prev: Vec<u32>, // parent idx; u32::MAX = unset for current gen
    q: VecDeque<usize>,
}

impl PedestrianRoutingScratch {
    fn ensure_len(&mut self, len: usize) {
        if self.seen_epoch.len() != len {
            self.seen_epoch.clear();
            self.seen_epoch.resize(len, 0);
        }
        if self.dist.len() != len {
            self.dist.clear();
            self.dist.resize(len, 0);
        }
        if self.prev.len() != len {
            self.prev.clear();
            self.prev.resize(len, u32::MAX);
        }
    }

    fn next_gen(&mut self) -> u32 {
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            // Wraparound safety: clear seen markers.
            self.seen_epoch.fill(0);
            self.epoch = 1;
        }
        self.epoch
    }

    /// Returns shortest path length in steps if reachable, but stops exploring beyond `max_steps`.
    pub fn shortest_path_steps_bounded(
        &mut self,
        graph: &PedestrianGraph,
        start: TilePos,
        goal: TilePos,
        max_steps: u32,
    ) -> Option<u32> {
        let (Some(start_i), Some(goal_i)) = (graph.idx(start), graph.idx(goal)) else {
            return None;
        };
        if !graph.walkable.get(start_i).copied().unwrap_or(false)
            || !graph.walkable.get(goal_i).copied().unwrap_or(false)
        {
            return None;
        }

        let len = graph.walkable.len();
        self.ensure_len(len);
        self.q.clear();

        let epoch = self.next_gen();
        self.seen_epoch[start_i] = epoch;
        self.dist[start_i] = 0;
        self.q.push_back(start_i);

        while let Some(i) = self.q.pop_front() {
            if i == goal_i {
                return Some(self.dist[i]);
            }
            let d = self.dist[i];
            if d >= max_steps {
                continue;
            }
            let nd = d.saturating_add(1);
            for n in graph.neighbors_idx(i) {
                if self.seen_epoch[n] == epoch {
                    continue;
                }
                self.seen_epoch[n] = epoch;
                self.dist[n] = nd;
                self.q.push_back(n);
            }
        }
        None
    }

    /// Returns a shortest path, but stops exploring beyond `max_steps`.
    pub fn shortest_path_bounded(
        &mut self,
        graph: &PedestrianGraph,
        start: TilePos,
        goal: TilePos,
        max_steps: u32,
    ) -> Option<Vec<TilePos>> {
        self.shortest_path_blocked_bounded(graph, start, goal, max_steps, |_| false)
    }

    /// Returns a shortest path, but treats `avoid` as blocked (even if walkable).
    pub fn shortest_path_avoid_bounded(
        &mut self,
        graph: &PedestrianGraph,
        start: TilePos,
        goal: TilePos,
        avoid: TilePos,
        max_steps: u32,
    ) -> Option<Vec<TilePos>> {
        self.shortest_path_blocked_bounded(graph, start, goal, max_steps, |p| p == avoid)
    }

    /// Returns a shortest path while treating any `blocked(pos) == true` tile as impassable,
    /// but stops exploring beyond `max_steps`.
    pub fn shortest_path_blocked_bounded(
        &mut self,
        graph: &PedestrianGraph,
        start: TilePos,
        goal: TilePos,
        max_steps: u32,
        mut blocked: impl FnMut(TilePos) -> bool,
    ) -> Option<Vec<TilePos>> {
        if blocked(start) || blocked(goal) {
            return None;
        }
        let (Some(start_i), Some(goal_i)) = (graph.idx(start), graph.idx(goal)) else {
            return None;
        };
        if !graph.walkable.get(start_i).copied().unwrap_or(false)
            || !graph.walkable.get(goal_i).copied().unwrap_or(false)
        {
            return None;
        }

        let len = graph.walkable.len();
        self.ensure_len(len);
        self.q.clear();

        let epoch = self.next_gen();
        self.seen_epoch[start_i] = epoch;
        self.dist[start_i] = 0;
        self.prev[start_i] = start_i as u32;
        self.q.push_back(start_i);

        while let Some(i) = self.q.pop_front() {
            if i == goal_i {
                break;
            }
            let d = self.dist[i];
            if d >= max_steps {
                continue;
            }
            let nd = d.saturating_add(1);
            for n in graph.neighbors_idx(i) {
                if self.seen_epoch[n] == epoch {
                    continue;
                }
                if nd > max_steps {
                    continue;
                }
                let p = graph.pos(n);
                if blocked(p) {
                    continue;
                }
                self.seen_epoch[n] = epoch;
                self.dist[n] = nd;
                self.prev[n] = i as u32;
                self.q.push_back(n);
            }
        }

        if self.seen_epoch[goal_i] != epoch {
            return None;
        }

        let mut out = Vec::<TilePos>::new();
        let mut cur = goal_i;
        for _ in 0..=len {
            out.push(graph.pos(cur));
            if cur == start_i {
                break;
            }
            cur = self.prev[cur] as usize;
        }
        out.reverse();
        Some(out)
    }
}
