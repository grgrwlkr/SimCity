//! Temporary diagnostic: log the structure of the permanent vehicle-freeze cluster to expose
//! deadlock rings. READ-ONLY — no state mutation. Remove once gridlock root cause is confirmed.

use std::collections::HashMap;

use bevy::prelude::*;

use crate::game::map::MapGrid;
use crate::game::transport::PathPool;

use super::components::{Parked, Vehicle, VehicleMotionTimer, VehicleTrafficState};
use super::occupancy::TrafficOccupancy;
use super::stuck::StuckTimer;

/// Minimum continuous stopped time (seconds) to consider a vehicle "frozen".
const FROZEN_THRESHOLD_SECS: f32 = 30.0;

/// Emit one diagnostic snapshot per ~5 sim-seconds.
#[allow(clippy::type_complexity)]
pub(super) fn log_frozen_cluster(
    time: Res<Time<Fixed>>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    path_pool: Res<PathPool>,
    vehicles: Query<
        (
            Entity,
            &Vehicle,
            &VehicleTrafficState,
            &VehicleMotionTimer,
            Option<&StuckTimer>,
        ),
        Without<Parked>,
    >,
    mut acc: Local<f32>,
) {
    *acc += time.delta_secs();
    if *acc < 5.0 {
        return;
    }
    *acc = 0.0;

    // ---- collect frozen vehicles ----
    let frozen: Vec<_> = vehicles
        .iter()
        .filter(|(_, _, _, mt, _)| mt.stopped_secs >= FROZEN_THRESHOLD_SECS)
        .collect();

    let n = frozen.len();
    if n == 0 {
        return;
    }

    info!("[FROZEN_DIAG] ==== {} frozen ====", n);

    // Map current tile → entity for frozen vehicles.
    let mut frozen_tile_map: HashMap<(i32, i32), Entity> = HashMap::new();
    for (entity, v, _, _, _) in &frozen {
        let cur = path_pool
            .get_tile(v.path_handle, v.path_cursor)
            .unwrap_or(v.tile_pos);
        frozen_tile_map.insert((cur.x, cur.y), *entity);
    }

    // ---- per-vehicle log line ----
    let mut edge: HashMap<Entity, Entity> = HashMap::new(); // A → B: B occupies A's next tile

    for (entity, v, state, mt, stuck) in &frozen {
        let cur = path_pool
            .get_tile(v.path_handle, v.path_cursor)
            .unwrap_or(v.tile_pos);
        let path_len = path_pool.len(v.path_handle);
        let next_opt = path_pool.get_tile(v.path_handle, v.path_cursor + 1);

        let state_str = match state {
            VehicleTrafficState::FreeFlow => "FreeFlow",
            VehicleTrafficState::Approaching { .. } => "Approaching",
            VehicleTrafficState::Stopped { .. } => "Stopped",
            VehicleTrafficState::WaitingForGreen { .. } => "WaitingForGreen",
            VehicleTrafficState::Accelerating => "Accelerating",
            VehicleTrafficState::CrossingIntersection { .. } => "CrossingIntersection",
        };
        let stuck_secs = stuck.map(|s| s.secs).unwrap_or(0.0);

        if let Some(next) = next_opt {
            let next_occ = grid
                .idx(next)
                .and_then(|i| traffic.per_tick_vehicles.get(i).copied())
                .unwrap_or(0);
            let next_intr = super::is_intersection_tile(&grid, next);
            let next_peer = frozen_tile_map
                .get(&(next.x, next.y))
                .copied()
                .filter(|&peer| peer != *entity);

            if let Some(peer) = next_peer {
                edge.insert(*entity, peer);
            }

            info!(
                "[FROZEN_DIAG] e={:?} cur=({},{}) state={} spd={:.2} cursor={}/{} stopped={:.0}s stuck={:.0}s rev={}/{:.1} next=({},{}) next_occ={} next_intr={} next_peer={:?}",
                entity,
                cur.x,
                cur.y,
                state_str,
                v.speed,
                v.path_cursor,
                path_len,
                mt.stopped_secs,
                stuck_secs,
                v.is_reversing,
                v.reverse_distance,
                next.x,
                next.y,
                next_occ,
                next_intr,
                next_peer,
            );
        } else {
            info!(
                "[FROZEN_DIAG] e={:?} cur=({},{}) state={} spd={:.2} cursor={}/{} stopped={:.0}s stuck={:.0}s rev={}/{:.1} next=(END) next_occ=0 next_intr=false next_peer=None",
                entity,
                cur.x,
                cur.y,
                state_str,
                v.speed,
                v.path_cursor,
                path_len,
                mt.stopped_secs,
                stuck_secs,
                v.is_reversing,
                v.reverse_distance,
            );
        }
    }

    // ---- summary counts ----
    let mut blocked_by_frozen = 0u32;
    let mut blocked_by_other = 0u32;
    let mut next_free = 0u32;

    for (entity, v, _, _, _) in &frozen {
        let next_opt = path_pool.get_tile(v.path_handle, v.path_cursor + 1);
        if let Some(next) = next_opt {
            let next_occ = grid
                .idx(next)
                .and_then(|i| traffic.per_tick_vehicles.get(i).copied())
                .unwrap_or(0);
            let has_frozen_peer = frozen_tile_map
                .get(&(next.x, next.y))
                .filter(|&&peer| peer != *entity)
                .is_some();
            if has_frozen_peer {
                blocked_by_frozen += 1;
            } else if next_occ > 0 {
                blocked_by_other += 1;
            } else {
                next_free += 1;
            }
        } else {
            next_free += 1;
        }
    }

    info!(
        "[FROZEN_DIAG] blocked_by_frozen_peer={} blocked_by_other={} next_free={}",
        blocked_by_frozen, blocked_by_other, next_free
    );

    // ---- ring detection ----
    let mut globally_seen: std::collections::HashSet<Entity> = std::collections::HashSet::new();

    for (start_entity, _, _, _, _) in &frozen {
        let start = *start_entity;
        if globally_seen.contains(&start) {
            continue;
        }

        let mut walk: Vec<Entity> = Vec::new();
        let mut local_seen: HashMap<Entity, usize> = HashMap::new();
        let mut cur = start;

        loop {
            if let Some(&cycle_start_idx) = local_seen.get(&cur) {
                // Found a cycle
                let cycle: Vec<Entity> = walk[cycle_start_idx..].to_vec();
                info!("[FROZEN_DIAG] CYCLE len={} {:?}", cycle.len(), cycle);
                for &e in &cycle {
                    globally_seen.insert(e);
                }
                break;
            }
            local_seen.insert(cur, walk.len());
            walk.push(cur);

            if let Some(&next_entity) = edge.get(&cur) {
                cur = next_entity;
            } else {
                // No frozen peer to follow — not a cycle from this start
                break;
            }
        }
    }
}
