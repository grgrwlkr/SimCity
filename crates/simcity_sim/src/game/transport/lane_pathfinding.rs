//! Lane-based A* pathfinding.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadKind;
use crate::game::traffic::TrafficOccupancy;
use crate::game::transport::pathfinding::PathfindingConfig;

use super::lane_graph::{LaneGraph, LaneId};

/// Context for congestion-aware lane edge costs.
///
/// Mirrors the road-A* congestion model in `pathfinding/cost.rs`, evaluated per
/// destination lane-tile. `jitter_seed` adds a small deterministic per-trip tie-break
/// so vehicles sharing the same OD pair don't all collapse onto a single corridor
/// (0 = disabled).
pub struct LaneCostCtx<'a> {
    pub grid: &'a MapGrid,
    pub traffic: &'a TrafficOccupancy,
    pub cfg: &'a PathfindingConfig,
    /// Per-trip-instance jitter seed (0 disables tie-break). MUST be drawn fresh per
    /// spawned trip (e.g. `sim_rng.rng.random_range(1..=u64::MAX)`), NOT keyed to the
    /// OD pair. If you key this to origin+destination, every vehicle with the same OD
    /// gets the identical seed → identical route → within-OD spread collapses (Rank-4
    /// regression: one corridor saturates).
    pub jitter_seed: u64,
}

/// Find a path through the lane graph, weighting edges by speed limit + live congestion.
pub fn find_lane_path(
    graph: &LaneGraph,
    ctx: &LaneCostCtx<'_>,
    start: LaneId,
    goal: LaneId,
) -> Vec<LaneId> {
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
            let step_cost = lane_edge_cost(ctx, graph, next_id);
            let ng = g.saturating_add(step_cost);

            if ng < best_g[next_id.as_usize()] {
                best_g[next_id.as_usize()] = ng;
                came_from[next_id.as_usize()] = Some(idx);
                let f = ng.saturating_add(heuristic_lane(next_id, goal, graph));
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

/// Integer edge cost for entering `next_id`. Mirrors `pathfinding::cost::step_cost_for_edge`
/// (speed/desirability base + congestion factor + cost_scale), keyed on the destination
/// lane-tile, plus a deterministic per-trip tie-break jitter.
pub(crate) fn lane_edge_cost(ctx: &LaneCostCtx<'_>, graph: &LaneGraph, next_id: LaneId) -> u32 {
    let Some(lane) = graph.get_lane(next_id) else {
        return 1;
    };
    let kind = lane.kind;

    let speed = kind.speed_limit().max(1.0);
    let capacity = (kind.capacity_per_lane_tile() as f32).max(1.0);
    let desirability = kind.desirability().max(0.1);

    let occupancy = ctx
        .grid
        .idx(lane.pos)
        .and_then(|i| ctx.traffic.per_tick_vehicles.get(i).copied())
        .unwrap_or(0) as f32;
    let congestion = (occupancy / capacity).clamp(0.0, ctx.cfg.congestion_max.max(0.0));

    let base_cost = (1.0 / speed) * (1.0 / desirability);
    let congestion_factor = 1.0 + ctx.cfg.congestion_k * congestion;
    let raw = base_cost * congestion_factor * ctx.cfg.cost_scale.max(1.0);

    let base = raw.max(1.0) as u32;
    base.saturating_add(lane_jitter(ctx.jitter_seed, next_id.0))
}

/// Uncongested per-tile base cost for a road kind: `floor((1/speed)*(1/desirability)*cost_scale)`.
/// This is the floor of `lane_edge_cost` with zero congestion and no jitter. Used to price lanelet
/// internal-path tiles, which have no road kind of their own (they carry `dir == None`).
// Wired into production with the lanelet pathfinder (find_route task); test-only until then.
#[allow(dead_code)]
pub(crate) fn base_tile_cost(kind: RoadKind, cfg: &PathfindingConfig) -> u32 {
    let speed = kind.speed_limit().max(1.0);
    let desirability = kind.desirability().max(0.1);
    ((1.0 / speed) * (1.0 / desirability) * cfg.cost_scale.max(1.0)).max(1.0) as u32
}

/// Deterministic per-edge tie-break, derived from a per-trip-instance seed and a stable node id.
/// Range stays a small fraction of base costs so it only breaks ties, never reroutes around
/// real congestion. Pure integer hashing => no RNG state, fully reproducible.
pub(crate) fn lane_jitter(seed: u64, id: u32) -> u32 {
    if seed == 0 {
        return 0;
    }
    // splitmix64-style mix of (seed, node id).
    let mut z = seed ^ (id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z % (LANE_JITTER_RANGE as u64)) as u32
}

/// Max additive tie-break in integer A* units. Base lane costs are
/// `(1/speed)*(1/desirability)*cost_scale` ≈ 25 for TwoLane (cost_scale=1000),
/// so a jitter ceiling of 8 only separates otherwise-equal alternatives.
const LANE_JITTER_RANGE: u32 = 8;

#[derive(Copy, Clone, Eq, PartialEq)]
struct HeapState {
    f: u32,
    g: u32,
    idx: LaneId,
}

impl Ord for HeapState {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .f
            .cmp(&self.f)
            .then_with(|| other.g.cmp(&self.g))
            .then_with(|| other.idx.0.cmp(&self.idx.0))
    }
}

impl PartialOrd for HeapState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Minimum possible per-tile lane edge base cost. Scales the admissible heuristic so A* does not
/// degrade to Dijkstra once turn/lane-change penalties exist on the combined lane+lanelet graph.
/// Global minimum over `RoadKind` of `floor((1/speed_limit) * (1/desirability) * cost_scale)`:
/// SixLane `(1/80) * (1/1.6) * 1000 = 7.81 -> 7`. Penalties and jitter are excluded from the
/// heuristic (added only to real edges), so `h` stays a lower bound on the true cost (admissible).
pub(crate) const MIN_PER_TILE_BASE: u32 = 7;

/// Scaled Manhattan distance heuristic between two tiles. Admissible because every real edge costs
/// at least `MIN_PER_TILE_BASE` and a path of Manhattan length `m` costs at least
/// `m * MIN_PER_TILE_BASE`.
pub(crate) fn heuristic_tiles(a: TilePos, b: TilePos) -> u32 {
    let dx = (a.x - b.x).unsigned_abs();
    let dy = (a.y - b.y).unsigned_abs();
    (dx + dy).saturating_mul(MIN_PER_TILE_BASE)
}

/// Scaled Manhattan distance heuristic for lanes (see [`heuristic_tiles`]).
pub(crate) fn heuristic_lane(a: LaneId, b: LaneId, graph: &LaneGraph) -> u32 {
    match (graph.get_lane(a), graph.get_lane(b)) {
        (Some(lane_a), Some(lane_b)) => heuristic_tiles(lane_a.pos, lane_b.pos),
        _ => u32::MAX,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::MapGrid;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::traffic::TrafficOccupancy;
    use crate::game::transport::GraphVersion;
    use crate::game::transport::lane_graph::build_lane_graph_inner;
    use crate::game::transport::pathfinding::PathfindingConfig;

    fn set_lane(grid: &mut MapGrid, pos: TilePos, lane: u8, dir: RoadDir) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    /// Two parallel eastbound corridors over x=0..4 (y=0 lane0, y=1 lane1).
    fn parallel_corridors() -> MapGrid {
        let mut grid = MapGrid::new(4, 2);
        for x in 0..4 {
            set_lane(&mut grid, TilePos { x, y: 0 }, 0, RoadDir::East);
            set_lane(&mut grid, TilePos { x, y: 1 }, 1, RoadDir::East);
        }
        grid
    }

    #[test]
    fn heuristic_is_scaled_and_admissible_on_optimal_path() {
        let grid = parallel_corridors();
        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));
        let start = graph.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let goal = graph.get_lane_id(TilePos { x: 3, y: 0 }, 0).unwrap();

        // Scaled property: heuristic == Manhattan * MIN_PER_TILE_BASE (fails on the old raw dx+dy).
        let pa = graph.get_lane(start).unwrap().pos;
        let pg = graph.get_lane(goal).unwrap().pos;
        let manhattan = (pa.x - pg.x).unsigned_abs() + (pa.y - pg.y).unsigned_abs();
        assert_eq!(
            heuristic_lane(start, goal, &graph),
            manhattan * MIN_PER_TILE_BASE
        );

        // Admissibility on the optimal path: with an admissible heuristic, find_lane_path returns the
        // optimal path, so the true min cost from path[i] to goal is the suffix sum of real edge
        // costs. Assert h(node, goal) <= that true remaining cost for every node on the path.
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let cfg = PathfindingConfig::default();
        let ctx = LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: 0,
        };
        let path = find_lane_path(&graph, &ctx, start, goal);
        assert!(!path.is_empty());
        let mut suffix = 0u32;
        for i in (0..path.len()).rev() {
            let h = heuristic_lane(path[i], goal, &graph);
            assert!(
                h <= suffix,
                "heuristic {h} exceeds true remaining cost {suffix} at path idx {i}"
            );
            if i > 0 {
                suffix = suffix.saturating_add(lane_edge_cost(&ctx, &graph, path[i]));
            }
        }
    }

    #[test]
    fn congestion_pushes_lane_path_onto_parallel_corridor() {
        let grid = parallel_corridors();
        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));

        // Congest the lower corridor (y=0) at x=1 and x=2.
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let i10 = grid.idx(TilePos { x: 1, y: 0 }).unwrap();
        let i20 = grid.idx(TilePos { x: 2, y: 0 }).unwrap();
        traffic.per_tick_vehicles[i10] = 8;
        traffic.per_tick_vehicles[i20] = 8;

        let cfg = PathfindingConfig::default();
        let ctx = LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: 0, // tie-break disabled: isolate congestion behavior
        };

        let start = graph
            .get_lane_id(TilePos { x: 0, y: 0 }, 0)
            .expect("start lane");
        let goal = graph
            .get_lane_id(TilePos { x: 3, y: 0 }, 0)
            .expect("goal lane");

        let path = find_lane_path(&graph, &ctx, start, goal);
        assert_eq!(path.first().copied(), Some(start));
        assert_eq!(path.last().copied(), Some(goal));

        // Path must detour onto the y=1 corridor to avoid congested y=0 tiles.
        let visited_y1 = path
            .iter()
            .any(|id| graph.get_lane(*id).map(|l| l.pos.y == 1).unwrap_or(false));
        assert!(visited_y1, "expected detour onto parallel corridor y=1");

        let touches_congested = path.iter().any(|id| {
            graph
                .get_lane(*id)
                .map(|l| l.pos == TilePos { x: 1, y: 0 } || l.pos == TilePos { x: 2, y: 0 })
                .unwrap_or(false)
        });
        assert!(!touches_congested, "expected to avoid congested y=0 tiles");
    }

    #[test]
    fn single_trip_returns_valid_connected_path() {
        let grid = parallel_corridors();
        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));

        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let cfg = PathfindingConfig::default();
        let ctx = LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: 0,
        };

        let start = graph
            .get_lane_id(TilePos { x: 0, y: 0 }, 0)
            .expect("start lane");
        let goal = graph
            .get_lane_id(TilePos { x: 3, y: 0 }, 0)
            .expect("goal lane");

        let path = find_lane_path(&graph, &ctx, start, goal);
        assert!(!path.is_empty(), "expected a non-empty path");
        assert_eq!(path.first().copied(), Some(start));
        assert_eq!(path.last().copied(), Some(goal));

        // Every consecutive pair must be a real graph edge (connected path).
        for w in path.windows(2) {
            let from = w[0];
            let to = w[1];
            assert!(
                graph.get_connections(from).contains(&to),
                "path edge {from:?} -> {to:?} is not a graph connection",
            );
        }
    }

    #[test]
    fn distinct_seeds_spread_equal_parallel_corridors() {
        let grid = parallel_corridors();
        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));

        // No congestion: both corridors are equal-cost, so only the tie-break can differ.
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let cfg = PathfindingConfig::default();

        // Endpoints on opposite corridors so the y=0-first and y=1-first routes
        // are equal in hop count *and* equal in base cost: (0,0)->(3,1) costs the
        // same whether you switch lanes early (x=0) or late (x=3). Only the
        // per-edge jitter can break that tie.
        let start = graph
            .get_lane_id(TilePos { x: 0, y: 0 }, 0)
            .expect("start lane");
        let goal = graph
            .get_lane_id(TilePos { x: 3, y: 1 }, 1)
            .expect("goal lane");

        let path_for = |seed: u64| {
            let ctx = LaneCostCtx {
                grid: &grid,
                traffic: &traffic,
                cfg: &cfg,
                jitter_seed: seed,
            };
            find_lane_path(&graph, &ctx, start, goal)
        };

        // Collect distinct route classes across 64 deterministic seeds.
        // The 4×2 grid (x=0..3, y=0..1) supports up to 4 switch points (x=0,1,2,3),
        // so up to 4 structurally different routes exist. We assert robust spread:
        // at least 2 distinct routes appear AND no single route monopolises all seeds.
        use std::collections::HashSet;
        let routes: Vec<Vec<LaneId>> = (1u64..=64).map(&path_for).collect();
        let distinct: HashSet<Vec<LaneId>> = routes.iter().cloned().collect();
        let distinct_count = distinct.len();
        let max_freq = distinct
            .iter()
            .map(|r| routes.iter().filter(|x| *x == r).count())
            .max()
            .unwrap_or(0);

        assert!(
            distinct_count >= 2,
            "expected >= 2 distinct route classes across 64 seeds (got {}); \
             jitter tie-break must spread equal-cost corridors",
            distinct_count
        );
        assert!(
            max_freq < routes.len(),
            "one route class claimed all {} seeds — spread is absent",
            routes.len()
        );

        // Determinism: same seed always yields the same path.
        assert_eq!(path_for(7), path_for(7), "same seed must be reproducible");
    }
}
