use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, IntersectionIndex};
use crate::game::map::MapGrid;
use crate::game::roads::RoadDir;

use super::super::components::VehicleTrafficState;
use super::super::{
    TILE_CENTER_TO_EDGE_TILES, TrafficConfig, TrafficOccupancy, Vehicle, is_intersection_tile,
};
use crate::game::pedestrians::PedestrianCrossing;

use super::zones::{
    ConflictMask, ManeuverKind, StreamKey, ZONE_ALL, maneuver_kind, reservation_zones_for_maneuver,
};

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub(crate) enum ReservationState {
    /// Reserved but the vehicle is still on the approach tile.
    Approaching,
    /// Vehicle is inside the intersection cluster.
    Inside,
}

#[derive(Debug, Copy, Clone)]
pub(crate) struct IntersectionReservation {
    pub(crate) vehicle: Entity,
    pub(crate) state: ReservationState,
    pub(crate) created_at_sec: f64,
    pub(crate) zones: ConflictMask,
    pub(crate) stream: StreamKey,
    pub(crate) maneuver: ManeuverKind,
}

#[derive(Resource, Default)]
pub(crate) struct IntersectionReservations {
    pub(crate) by_intersection:
        std::collections::HashMap<IntersectionId, Vec<IntersectionReservation>>,
}

impl IntersectionReservations {
    pub(crate) fn is_reserved(&self, id: IntersectionId) -> bool {
        self.by_intersection.get(&id).is_some_and(|v| !v.is_empty())
    }

    pub(crate) fn is_reserved_by(&self, id: IntersectionId, vehicle: Entity) -> bool {
        self.by_intersection
            .get(&id)
            .is_some_and(|rs| rs.iter().any(|r| r.vehicle == vehicle))
    }

    fn can_reserve(
        &self,
        id: IntersectionId,
        vehicle: Entity,
        zones: ConflictMask,
        stream: StreamKey,
        maneuver: ManeuverKind,
    ) -> bool {
        let Some(rs) = self.by_intersection.get(&id) else {
            return true;
        };

        for r in rs.iter() {
            if r.vehicle == vehicle {
                continue;
            }
            if (r.zones & zones) == 0 {
                continue;
            }

            // Unlimited "platooning" for the same flow: if the maneuver and lane-path are the same
            // (same entry->exit, therefore same zone path), allow multiple vehicles concurrently.
            if r.stream == stream {
                continue;
            }

            // Right turns are merges, not crossings: allow right-turning traffic to coexist with
            // the straight flow coming from the **same entry direction** (same approach road),
            // even if our coarse zone approximation overlaps.
            let same_entry = r.stream.entry == stream.entry;
            let merge_compatible = same_entry
                && ((maneuver == ManeuverKind::RightTurn && r.maneuver == ManeuverKind::Straight)
                    || (maneuver == ManeuverKind::Straight
                        && r.maneuver == ManeuverKind::RightTurn));
            if merge_compatible {
                continue;
            }

            return false;
        }

        true
    }
}

#[derive(Copy, Clone)]
pub(crate) struct IntersectionReservationCandidate {
    priority: u8,
    dist_to_entry: f32,
    vehicle: Entity,
    zones: ConflictMask,
    stream: StreamKey,
    maneuver: ManeuverKind,
    is_right_on_red: bool,
    exit_tile_idx: usize,
    exit_tile_cap: u16,
}

pub(crate) fn reset_intersection_reservations(mut reservations: ResMut<IntersectionReservations>) {
    reservations.by_intersection.clear();
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_intersection_reservations(
    time: Res<Time<Fixed>>,
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    traffic: Res<TrafficOccupancy>,
    traffic_cfg: Res<TrafficConfig>,
    path_pool: Res<super::super::super::transport::PathPool>,
    mut reservations: ResMut<IntersectionReservations>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    q_pedestrians: Query<&PedestrianCrossing>,
    q_vehicles: Query<(Entity, &Vehicle, &VehicleTrafficState), Without<super::super::Parked>>,
    mut lights_by_id: Local<
        std::collections::HashMap<IntersectionId, crate::game::intersections::TrafficLight>,
    >,
    mut ped_axis_mask: Local<
        std::collections::HashMap<crate::game::intersections::IntersectionId, u8>,
    >,
    mut candidates_by_intersection: Local<
        std::collections::HashMap<IntersectionId, Vec<IntersectionReservationCandidate>>,
    >,
    mut exit_tile_reserved: Local<std::collections::HashMap<(IntersectionId, usize), u16>>,
) {
    let now = time.elapsed_secs_f64();

    // Build a small lookup of controllers by intersection id.
    lights_by_id.clear();
    for l in q_lights.iter() {
        lights_by_id.insert(l.intersection_id, l.clone());
    }

    // Pedestrian crossings inside intersections (axis-specific):
    // - axis_ns=true: pedestrian moves N/S (crossing E-W roadway)
    // - axis_ns=false: pedestrian moves E/W (crossing N-S roadway)
    ped_axis_mask.clear();
    for p in q_pedestrians.iter() {
        let m = ped_axis_mask.entry(p.intersection_id).or_insert(0);
        if p.axis_ns {
            *m |= 1 << 0;
        } else {
            *m |= 1 << 1;
        }
    }

    // Reuse candidate buffers across ticks.
    for v in candidates_by_intersection.values_mut() {
        v.clear();
    }
    exit_tile_reserved.clear();

    // Ensure any vehicle currently inside an intersection cluster owns a reservation (safety net).
    for (e, v, _) in q_vehicles.iter() {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        if !is_intersection_tile(&grid, cur) {
            continue;
        }
        let Some(id) = intersections.intersection_id_at(cur) else {
            continue;
        };
        let rs = reservations.by_intersection.entry(id).or_default();
        if !rs.iter().any(|r| r.vehicle == e) {
            rs.push(IntersectionReservation {
                vehicle: e,
                state: ReservationState::Inside,
                created_at_sec: now,
                zones: ZONE_ALL,
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            });
        }
    }

    // Greedy admission: allow multiple approaching vehicles per intersection as long as their
    // conflict zones don't overlap (coarse safety).
    for (e, v, state) in q_vehicles.iter() {
        if v.path_cursor + 1 >= path_pool.len(v.path_handle) {
            continue;
        }
        let stopped_or_waiting = matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        );

        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        if is_intersection_tile(&grid, cur) {
            continue;
        }
        let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1) else {
            continue;
        };
        if !is_intersection_tile(&grid, next) {
            continue;
        }

        let Some(id) = intersections.intersection_id_at(next) else {
            continue;
        };
        // Must have a non-conflicting zone set.
        let entry_dir = super::super::dir_between_adjacent(cur, next);
        if entry_dir == RoadDir::None {
            continue;
        }
        let exit_dir = super::super::compute_exit_direction(&path_pool.remaining_from(v.path_handle, v.path_cursor), &grid, next);

        // Yield to pedestrians: block only maneuvers that conflict with the currently-crossing axis.
        if let Some(mask) = ped_axis_mask.get(&id).copied() {
            let right = if traffic_cfg.drive_on_right {
                entry_dir.right()
            } else {
                entry_dir.left()
            };
            let left = if traffic_cfg.drive_on_right {
                entry_dir.left()
            } else {
                entry_dir.right()
            };

            let conflicts_ns = matches!(exit_dir, RoadDir::East | RoadDir::West); // turning onto E/W roadway
            let conflicts_ew = matches!(exit_dir, RoadDir::North | RoadDir::South); // turning onto N/S roadway

            let is_right_turn = exit_dir == right;
            let is_left_turn = exit_dir == left;

            if is_left_turn && mask != 0 {
                continue;
            }

            if is_right_turn
                && ((conflicts_ns && (mask & (1 << 0)) != 0)
                    || (conflicts_ew && (mask & (1 << 1)) != 0))
            {
                continue;
            }
        }

        // Don't block the box: only admit if the planned exit lane tile has space.
        let rem = path_pool.remaining_from(v.path_handle, v.path_cursor);
        let exit_tile = rem.iter().position(|t| *t == next).and_then(|start_i| {
            let mut i = start_i;
            while i < rem.len() && is_intersection_tile(&grid, rem[i]) {
                i += 1;
            }
            rem.get(i).copied()
        });
        let Some(exit_tile) = exit_tile else {
            continue;
        };
        let Some(exit_cell) = grid.get(exit_tile) else {
            continue;
        };
        if !exit_cell.road.is_some() || exit_cell.road.dir == RoadDir::None {
            continue;
        }
        let Some(exit_idx) = grid.idx(exit_tile) else {
            continue;
        };
        let cap = exit_cell.road.kind.capacity_per_lane_tile();
        if cap == 0 {
            continue;
        }
        let occ = traffic
            .per_tick_vehicles
            .get(exit_idx)
            .copied()
            .unwrap_or(0);
        if occ >= cap {
            continue;
        }

        let Some(zones) = reservation_zones_for_maneuver(&traffic_cfg, entry_dir, exit_dir) else {
            continue;
        };

        let stream = StreamKey {
            entry: entry_dir,
            exit: exit_dir,
        };
        let maneuver = maneuver_kind(&traffic_cfg, entry_dir, exit_dir);
        if !reservations.can_reserve(id, e, zones, stream, maneuver) {
            continue;
        }

        let mut priority = 1u8;
        let mut is_right_on_red = false;

        // Baseline maneuver priority for throughput:
        // - Straight flows should not be blocked by turns.
        // - Right turns are merges (prefer over left turns).
        // - Left turns are the primary "wait" maneuver (crossing).
        match maneuver {
            ManeuverKind::Straight => priority = priority.max(3),
            ManeuverKind::RightTurn => priority = priority.max(2),
            ManeuverKind::LeftTurn | ManeuverKind::Other => {}
        }

        // If there is a traffic light controller, only admit on green/yellow (or right-on-red).
        if intersections.traffic_lights.contains(&id) {
            let Some(light) = lights_by_id.get(&id) else {
                continue;
            };
            let dir = entry_dir;

            if light.is_green(dir) || light.is_yellow(dir) {
                priority = priority.max(2);
            } else {
                // Right turn on red (near-side turn only), after coming to a stop.
                if !stopped_or_waiting {
                    continue;
                }
                // Do not allow during all-red clearance.
                if light.is_all_red() {
                    continue;
                }

                // Only if the vehicle is stopped for THIS stop tile.
                let stopped_for_this = matches!(
                    *state,
                    VehicleTrafficState::Stopped { stop_tile, .. }
                        | VehicleTrafficState::WaitingForGreen { stop_tile, .. }
                        if stop_tile == cur
                );
                if !stopped_for_this {
                    continue;
                }

                let allowed_turn_dir = if traffic_cfg.drive_on_right {
                    dir.right()
                } else {
                    dir.left()
                };
                if exit_dir != allowed_turn_dir {
                    continue;
                }

                priority = 1;
                is_right_on_red = true;
            }
        } else {
            // Uncontrolled intersection: allow reservations for stopped vehicles (stop-sign deadlock fix).
            let stopped_for_this = matches!(
                *state,
                VehicleTrafficState::Stopped { stop_tile, .. } if stop_tile == cur
            );
            if stopped_for_this {
                priority = priority.max(2);
            }
        }

        // Distance to the intersection entry boundary (tile edge at progress=0.5).
        let dist = (TILE_CENTER_TO_EDGE_TILES - v.progress).clamp(0.0, 1.0);
        let cand = IntersectionReservationCandidate {
            priority,
            dist_to_entry: dist,
            vehicle: e,
            zones,
            stream,
            maneuver,
            is_right_on_red,
            exit_tile_idx: exit_idx,
            exit_tile_cap: cap,
        };

        candidates_by_intersection.entry(id).or_default().push(cand);
    }

    for (&id, cands) in candidates_by_intersection.iter_mut() {
        if cands.is_empty() {
            continue;
        }
        // sort by priority, then distance, then stable entity id
        cands.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.dist_to_entry.total_cmp(&b.dist_to_entry))
                .then_with(|| a.vehicle.to_bits().cmp(&b.vehicle.to_bits()))
        });

        for cand in cands.iter().copied() {
            // Right turn on red is a yield-maneuver: only allow it when the intersection is clear.
            if cand.is_right_on_red && reservations.is_reserved(id) {
                continue;
            }
            // Capacity gate: reserve exit tile capacity as well, so we never admit more vehicles
            // than the exit lane tile can accept in the same tick (prevents "queue inside box").
            let used = exit_tile_reserved
                .entry((id, cand.exit_tile_idx))
                .or_insert_with(|| {
                    traffic
                        .per_tick_vehicles
                        .get(cand.exit_tile_idx)
                        .copied()
                        .unwrap_or(0)
                });
            if *used >= cand.exit_tile_cap {
                continue;
            }
            if !reservations.can_reserve(id, cand.vehicle, cand.zones, cand.stream, cand.maneuver) {
                continue;
            }
            reservations
                .by_intersection
                .entry(id)
                .or_default()
                .push(IntersectionReservation {
                    vehicle: cand.vehicle,
                    state: ReservationState::Approaching,
                    created_at_sec: now,
                    zones: cand.zones,
                    stream: cand.stream,
                    maneuver: cand.maneuver,
                });
            *used = used.saturating_add(1);
        }
    }
}

pub(crate) fn cleanup_intersection_reservations(
    time: Res<Time<Fixed>>,
    intersections: Res<IntersectionIndex>,
    mut reservations: ResMut<IntersectionReservations>,
    q_vehicles: Query<&Vehicle>,
) {
    let now = time.elapsed_secs_f64();
    let timeout_secs = 6.0;

    // Snapshot keys to avoid borrowing issues while mutating.
    let ids: Vec<IntersectionId> = reservations.by_intersection.keys().copied().collect();
    for id in ids {
        let Some(list) = reservations.by_intersection.get_mut(&id) else {
            continue;
        };

        list.retain_mut(|r| {
            let Ok(v) = q_vehicles.get(r.vehicle) else {
                return false;
            };
            if v.path_cursor >= path_pool.len(v.path_handle) {
                return false;
            }

            let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
                return false;
            };
            let cur_id = intersections.intersection_id_at(cur);
            if cur_id == Some(id) {
                r.state = ReservationState::Inside;
            }

            match r.state {
                ReservationState::Approaching => {
                    // Vehicle rerouted away: drop.
                    let next_id = v
                        .route
                        .get(v.route_idx + 1)
                        .and_then(|t| intersections.intersection_id_at(*t));
                    if next_id != Some(id) {
                        return false;
                    }
                    // If it doesn't enter within a small time budget, release to avoid deadlocks.
                    if now - r.created_at_sec > timeout_secs {
                        return false;
                    }
                }
                ReservationState::Inside => {
                    // Release once the vehicle exits the intersection cluster.
                    if cur_id != Some(id) {
                        return false;
                    }
                }
            }
            true
        });

        if list.is_empty() {
            reservations.by_intersection.remove(&id);
        }
    }
}
