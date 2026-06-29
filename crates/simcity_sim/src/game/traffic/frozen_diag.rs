//! Temporary diagnostic: log the structure of the permanent vehicle-freeze cluster to expose
//! deadlock rings. READ-ONLY — no state mutation. Remove once gridlock root cause is confirmed.

use std::collections::HashMap;

use bevy::prelude::*;

use crate::game::map::MapGrid;
use crate::game::roads::RoadDir;
use crate::game::transport::PathPool;

use super::components::{Parked, Vehicle, VehicleMotionTimer, VehicleTrafficState};
use super::intersection::IntersectionReservations;
use super::movement::compute_approach_info;
use super::occupancy::TrafficOccupancy;
use super::stuck::StuckTimer;

/// Minimum continuous stopped time (seconds) to consider a vehicle "frozen".
const FROZEN_THRESHOLD_SECS: f32 = 30.0;

/// Emit one diagnostic snapshot per ~5 sim-seconds.
#[allow(clippy::type_complexity)]
#[allow(clippy::too_many_arguments)]
pub(super) fn log_frozen_cluster(
    time: Res<Time<Fixed>>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    path_pool: Res<PathPool>,
    traffic_cfg: Res<super::config::TrafficConfig>,
    intersections: Res<crate::game::intersections::IntersectionIndex>,
    reservations: Res<IntersectionReservations>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
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

    // Build light index (same as update_vehicle_traffic_state).
    let mut light_by_key: HashMap<
        crate::game::intersections::IntersectionKey,
        crate::game::intersections::TrafficLight,
    > = HashMap::new();
    for l in q_lights.iter() {
        light_by_key.insert(l.intersection_key, l.clone());
    }

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

        // Compute approach info for maneuver, light, and reservation fields.
        let approach = compute_approach_info(&grid, &intersections, &path_pool, v);

        let (entry_dir_str, exit_dir_str, maneuver_str, light_str, left_protected, reserved) =
            if let Some(ref info) = approach {
                let entry = info.entry_dir;
                let exit = info.exit_dir;

                let maneuver = if exit == RoadDir::None {
                    "None"
                } else if exit == entry {
                    "Straight"
                } else if exit == entry.opposite() {
                    "UTurn"
                } else {
                    // Mirror the left/right convention from state.rs lines 247-252:
                    // drive_on_right → left turn target is entry.left()
                    let left_target = if traffic_cfg.drive_on_right {
                        entry.left()
                    } else {
                        entry.right()
                    };
                    if exit == left_target { "Left" } else { "Right" }
                };

                let light = light_by_key.get(&info.intersection_key);
                let light_str = if let Some(l) = light {
                    if l.is_all_red() {
                        "allred"
                    } else if l.is_green(entry) {
                        "green"
                    } else if l.is_yellow(entry) {
                        "yellow"
                    } else {
                        "red"
                    }
                } else {
                    "none"
                };
                let left_protected = light.is_some_and(|l| l.is_left_protected(entry));
                let reserved = reservations.is_reserved_by(info.intersection_id, *entity);

                (
                    format!("{:?}", entry),
                    format!("{:?}", exit),
                    maneuver,
                    light_str,
                    left_protected,
                    reserved,
                )
            } else {
                (
                    "None".to_string(),
                    "None".to_string(),
                    "None",
                    "none",
                    false,
                    false,
                )
            };

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
                "[FROZEN_DIAG] e={:?} cur=({},{}) state={} spd={:.2} cursor={}/{} stopped={:.0}s stuck={:.0}s rev={}/{:.1} next=({},{}) next_occ={} next_intr={} next_peer={:?} entry_dir={} exit_dir={} maneuver={} light={} left_protected={} reserved={}",
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
                entry_dir_str,
                exit_dir_str,
                maneuver_str,
                light_str,
                left_protected,
                reserved,
            );
        } else {
            info!(
                "[FROZEN_DIAG] e={:?} cur=({},{}) state={} spd={:.2} cursor={}/{} stopped={:.0}s stuck={:.0}s rev={}/{:.1} next=(END) next_occ=0 next_intr=false next_peer=None entry_dir={} exit_dir={} maneuver={} light={} left_protected={} reserved={}",
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
                entry_dir_str,
                exit_dir_str,
                maneuver_str,
                light_str,
                left_protected,
                reserved,
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
