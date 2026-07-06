//! Congestion-aware lane edge costs and admissible heuristic helpers.
//!
//! Consumed by the combined RoadLane+Lanelet A* (`lanelet::pathfinding`); the legacy
//! standalone lane A* that lived here has been removed.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_tiles_is_scaled_manhattan() {
        // Regression pin: the heuristic is Manhattan * MIN_PER_TILE_BASE (not raw dx+dy),
        // so A* over penalty-bearing lane costs does not degrade to Dijkstra.
        let a = TilePos { x: 0, y: 0 };
        let b = TilePos { x: 3, y: 2 };
        assert_eq!(heuristic_tiles(a, b), 5 * MIN_PER_TILE_BASE);
    }
}
