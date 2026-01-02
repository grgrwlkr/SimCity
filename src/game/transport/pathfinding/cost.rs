use crate::game::intersections::IntersectionIndex;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::traffic::TrafficOccupancy;

use super::PathfindingConfig;

pub(super) struct StepCostParams<'a> {
    pub(super) cur_idx: usize,
    pub(super) next_idx: usize,
    pub(super) move_dir: RoadDir,
    pub(super) w: usize,
    pub(super) cfg: &'a PathfindingConfig,
    pub(super) traffic: &'a TrafficOccupancy,
    pub(super) grid: &'a MapGrid,
    pub(super) intersections: &'a IntersectionIndex,
}

fn idx_to_pos(idx: usize, w: usize) -> TilePos {
    TilePos {
        x: (idx % w) as i32,
        y: (idx / w) as i32,
    }
}

pub(super) fn step_cost_for_edge(params: StepCostParams<'_>) -> u32 {
    let StepCostParams {
        cur_idx,
        next_idx,
        move_dir,
        w,
        cfg,
        traffic,
        grid,
        intersections,
    } = params;
    // Weight model (MVP):
    // travel_time = 1 / speed_limit
    // congestion_factor = 1 + k * congestion
    // desirability_factor = 1 / desirability
    //
    // edge_weight = travel_time * congestion_factor * desirability_factor
    // Scaled to u32 for A*.
    let cur = grid
        .get(idx_to_pos(cur_idx, w))
        .map(|c| c.road)
        .unwrap_or_default();
    let next = grid
        .get(idx_to_pos(next_idx, w))
        .map(|c| c.road)
        .unwrap_or_default();

    let road_kind = next.kind;

    let speed = road_kind.speed_limit().max(1.0);
    let capacity = (road_kind.capacity_per_lane_tile() as f32).max(1.0);
    let desirability = road_kind.desirability().max(0.1);

    let occupancy = traffic
        .per_tick_vehicles
        .get(next_idx)
        .copied()
        .unwrap_or(0) as f32;
    // We compute the weight for entering `next_idx` (cost-to-enter model).
    let congestion = (occupancy / capacity).clamp(0.0, cfg.congestion_max.max(0.0));

    let travel_time = 1.0 / speed;
    let desirability_factor = 1.0 / desirability;
    let base_cost = travel_time * desirability_factor;
    let congestion_factor = 1.0 + cfg.congestion_k * congestion;

    let raw = base_cost * congestion_factor * cfg.cost_scale.max(1.0);

    // Extra penalties to stabilize lane behavior:
    // - lane change: small penalty so we don't zig-zag
    // - turn: slightly larger penalty (turns are "harder" and limited anyway)
    let mut penalty = 0.0f32;
    if cur.dir != RoadDir::None && next.dir != RoadDir::None {
        let left = cur.dir.left();
        let right = cur.dir.right();
        if (move_dir == left || move_dir == right) && next.dir == cur.dir {
            penalty += cfg.lane_change_penalty.max(0.0);
        } else if (move_dir == left || move_dir == right) && next.dir == move_dir {
            penalty += cfg.turn_penalty.max(0.0);
        }
    }

    // Traffic light penalty: average wait time (half cycle duration)
    let next_pos = idx_to_pos(next_idx, w);
    let traffic_light_penalty = if intersections.has_traffic_light_at(next_pos) {
        // Average delay: half of a typical cycle (10s / 2 = 5s)
        // Convert to cost units (assuming 1.0 = 1 tile travel time)
        let avg_wait_secs = 5.0;
        avg_wait_secs * cfg.cost_scale.max(1.0)
    } else {
        0.0
    };

    (raw + penalty + traffic_light_penalty).max(1.0) as u32
}
