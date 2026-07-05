use bevy::prelude::*;

use crate::game::map::MapGrid;
use crate::game::roads::RoadDir;
use crate::game::transport::PathPool;
use crate::game::transport::lanelet::pathfinding::{dir_between_adjacent, first_oncoming_pair};

use super::{
    DebugVehicleState, DebugVehicleTrafficState, Vehicle, VehicleTrafficState,
    components::{DEBUG_ROUTE_SAMPLE_LEN, Parked, VehicleLaneletPlan},
};

/// Max offender tiles sampled into [`TrafficViolationAudit::offender_tiles`].
pub const AUDIT_OFFENDER_SAMPLE_LEN: usize = 4;

/// Live audit of lane-direction violations (встречка) and in-box route provenance.
/// Recomputed every sim tick in `PostSim`; mirrored into `DebugTrafficSnapshot` for BRP/MCP.
#[derive(Resource, Debug, Default, Clone)]
pub struct TrafficViolationAudit {
    /// Vehicles whose current route step travels AGAINST the lane direction of a real road tile.
    pub wrong_way_now: u32,
    /// Cumulative offender-ticks (rate signal: grows while any vehicle stays wrong-way).
    pub wrong_way_ticks_total: u64,
    /// Wrong-way vehicles currently reversing.
    pub wrong_way_reversing_now: u32,
    /// Wrong-way vehicles WITHOUT a lanelet sidecar (fallback / hand-built route suspects).
    pub wrong_way_no_sidecar_now: u32,
    /// Vehicles currently inside an intersection box (dir == None road tile).
    pub in_box_now: u32,
    /// In-box vehicles with NO lanelet plan (road-A*/hand-built in-box path: corner-cut suspects).
    pub in_box_no_sidecar_now: u32,
    /// First few offender tiles for quick inspection; `offender_count` entries are valid.
    pub offender_tiles: [(i32, i32); AUDIT_OFFENDER_SAMPLE_LEN],
    /// Valid entries in `offender_tiles`.
    pub offender_count: u8,
    /// Vehicles whose REMAINING ROUTE (any future step, not just the current one) contains a step
    /// against a lane direction — planned встречка visible on the route overlay long before the
    /// vehicle reaches it.
    pub route_oncoming_now: u32,
    /// Cumulative vehicle-ticks with an oncoming step somewhere in the remaining route.
    pub route_oncoming_ticks_total: u64,
    /// First route offender: the vehicle's CURRENT tile (to find it on screen), (-1,-1) when none.
    pub route_offender_vehicle_tile: (i32, i32),
    /// First route offender: the offending step `from -> to`, (-1,-1) when none.
    pub route_offender_step_from: (i32, i32),
    pub route_offender_step_to: (i32, i32),
}

/// Cumulative route-intern counters per producer (attribution: which pipeline made the route).
#[derive(Resource, Debug, Default, Clone)]
pub struct RouteProducerStats {
    /// Spawn: combined lane+lanelet A* succeeded.
    pub spawn_lanelet: u32,
    /// Spawn: fell back to tile road-A* (dir-guarded at intern like every producer; turn-blind
    /// in-box).
    pub spawn_road_fallback: u32,
    /// Stuck reroute: lanelet replan succeeded.
    pub stuck_lanelet: u32,
    /// Stuck reroute: interned raw road-A* route.
    pub stuck_road_fallback: u32,
    /// A rewriter's hand-built route was REFUSED by the direction guard (would step onto an
    /// oncoming lane) — the rewrite is skipped and the old route kept.
    pub guard_refusals: u32,
    /// Lane change interned its hand-built lateral route.
    pub lane_change_handbuilt: u32,
    /// Swap-break interned its hand-built route.
    pub swap_break_handbuilt: u32,
}

/// Scan all active vehicles for lane-direction violations and in-box provenance. Cheap:
/// O(vehicles), a few hundred entities at 10 Hz.
#[allow(clippy::type_complexity)]
pub(super) fn audit_traffic_violations(
    grid: Res<MapGrid>,
    path_pool: Res<PathPool>,
    mut audit: ResMut<TrafficViolationAudit>,
    q: Query<(&Vehicle, Option<&VehicleLaneletPlan>), Without<Parked>>,
) {
    let prev_wrong_way = audit.wrong_way_now;
    let a = &mut *audit;
    a.wrong_way_now = 0;
    a.wrong_way_reversing_now = 0;
    a.wrong_way_no_sidecar_now = 0;
    a.in_box_now = 0;
    a.in_box_no_sidecar_now = 0;
    a.offender_count = 0;
    a.route_oncoming_now = 0;
    a.route_offender_vehicle_tile = (-1, -1);
    a.route_offender_step_from = (-1, -1);
    a.route_offender_step_to = (-1, -1);

    for (v, plan) in &q {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        // Full-remaining-route check: any FUTURE step against a lane direction (what the route
        // overlay shows as a line running down an oncoming lane). Cheap: O(route len).
        if let Some(rem) = path_pool.remaining_from(v.path_handle, v.path_cursor)
            && let Some((from, to)) = first_oncoming_pair(rem, &grid)
        {
            a.route_oncoming_now += 1;
            if a.route_offender_vehicle_tile == (-1, -1) {
                a.route_offender_vehicle_tile = (cur.x, cur.y);
                a.route_offender_step_from = (from.x, from.y);
                a.route_offender_step_to = (to.x, to.y);
            }
        }
        let Some(cell) = grid.get(cur) else { continue };
        if !cell.road.is_some() {
            continue;
        }
        let has_sidecar = plan.is_some_and(|p| !p.entries.is_empty());
        let dir = cell.road.dir;
        if dir == RoadDir::None {
            a.in_box_now += 1;
            if !has_sidecar {
                a.in_box_no_sidecar_now += 1;
            }
            continue;
        }
        let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1) else {
            continue;
        };
        if dir_between_adjacent(cur, next) == dir.opposite() {
            a.wrong_way_now += 1;
            if v.is_reversing {
                a.wrong_way_reversing_now += 1;
            }
            if !has_sidecar {
                a.wrong_way_no_sidecar_now += 1;
            }
            let n = a.offender_count as usize;
            if n < AUDIT_OFFENDER_SAMPLE_LEN {
                a.offender_tiles[n] = (cur.x, cur.y);
                a.offender_count += 1;
            }
        }
    }
    a.wrong_way_ticks_total += a.wrong_way_now as u64;
    a.route_oncoming_ticks_total += a.route_oncoming_now as u64;

    // Edge-triggered log: fires when offenders appear, not every tick they persist.
    if a.wrong_way_now > prev_wrong_way {
        warn!(
            "wrong-way audit: {} vehicle(s) against lane dir (reversing={}, no_sidecar={}), first at {:?}",
            a.wrong_way_now,
            a.wrong_way_reversing_now,
            a.wrong_way_no_sidecar_now,
            &a.offender_tiles[..a.offender_count as usize],
        );
    }
}

/// Update or attach per-vehicle debug snapshots for MCP inspection.
pub(super) fn update_debug_vehicle_state(
    path_pool: Res<PathPool>,
    mut commands: Commands,
    q_vehicles: Query<(Entity, &Vehicle, Option<&VehicleTrafficState>)>,
) {
    for (e, v, state) in q_vehicles.iter() {
        let current = path_pool
            .get_tile(v.path_handle, v.path_cursor)
            .unwrap_or(v.tile_pos);
        let next = path_pool
            .get_tile(v.path_handle, v.path_cursor + 1)
            .unwrap_or(current);
        let path_len = path_pool.len(v.path_handle) as u32;
        let traffic_state = state
            .copied()
            .map(DebugVehicleTrafficState::from)
            .unwrap_or_default();

        let mut sample_x = [0; DEBUG_ROUTE_SAMPLE_LEN];
        let mut sample_y = [0; DEBUG_ROUTE_SAMPLE_LEN];
        let mut sample_len = 0u32;
        for (slot, i) in (0..DEBUG_ROUTE_SAMPLE_LEN).enumerate() {
            let idx = v.path_cursor + i;
            let Some(pos) = path_pool.get_tile(v.path_handle, idx) else {
                break;
            };
            sample_x[slot] = pos.x;
            sample_y[slot] = pos.y;
            sample_len += 1;
        }

        commands.entity(e).insert(DebugVehicleState {
            tile_x: current.x,
            tile_y: current.y,
            next_tile_x: next.x,
            next_tile_y: next.y,
            speed: v.speed,
            max_speed: v.max_speed,
            speed_factor: v.speed_factor,
            progress: v.progress,
            state: traffic_state,
            path_cursor: v.path_cursor as u32,
            path_len,
            route_sample_start: v.path_cursor as u32,
            route_sample_len: sample_len,
            route_sample_x: sample_x,
            route_sample_y: sample_y,
            is_reversing: v.is_reversing,
        });
    }
}
