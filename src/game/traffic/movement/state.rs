use super::super::*;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Copy, Clone)]
struct ApproachInfo {
    intersection_id: crate::game::intersections::IntersectionId,
    intersection_key: crate::game::intersections::IntersectionKey,
    /// First intersection tile on the route within lookahead.
    first_intersection_tile: TilePos,
    /// Last non-intersection tile before the cluster entry.
    stop_tile: TilePos,
    /// Direction of travel into the intersection (derived from stop_tile -> first_intersection_tile).
    entry_dir: RoadDir,
    /// Planned exit direction once leaving the intersection cluster.
    exit_dir: RoadDir,
    /// Distance to stop line along the route (in tiles).
    dist_to_stop_line_tiles: f32,
}

fn compute_approach_info(
    grid: &MapGrid,
    intersections: &IntersectionIndex,
    path_pool: &crate::game::transport::PathPool,
    v: &Vehicle,
) -> Option<ApproachInfo> {
    let route = path_pool.remaining_from(v.path_handle, v.path_cursor)?;
    if route.len() < 2 {
        return None;
    }

    // Look ahead a bit (avoid scanning long routes per tick).
    let lookahead = (TRAFFIC_LIGHT_DETECTION_DISTANCE as usize).max(1);
    let mut first_i: Option<usize> = None;
    for (i, &t) in route.iter().enumerate().skip(1).take(lookahead) {
        if is_intersection_tile(grid, t) {
            first_i = Some(i);
            break;
        }
    }
    let i = first_i?;
    let first_intersection_tile = route[i];
    let stop_tile = route[i.saturating_sub(1)];

    let intersection_id = intersections.intersection_id_at(first_intersection_tile)?;
    let intersection_key = intersections.cluster_key_at(first_intersection_tile)?;

    let entry_dir = dir_between_adjacent(stop_tile, first_intersection_tile);
    if entry_dir == RoadDir::None {
        return None;
    }

    let exit_dir = compute_exit_direction(route, grid, first_intersection_tile);

    // Distance from current position to the stop line (tiles).
    // `progress` is between tile centers; subtract it from the remaining tile-steps to stop_tile,
    // then add stop-line offset within the stop_tile.
    let stop_line_progress = TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET;
    let dist_to_stop_line_tiles =
        (((i.saturating_sub(1)) as f32) - v.progress + stop_line_progress).max(0.0);

    Some(ApproachInfo {
        intersection_id,
        intersection_key,
        first_intersection_tile,
        stop_tile,
        entry_dir,
        exit_dir,
        dist_to_stop_line_tiles,
    })
}

#[allow(clippy::too_many_arguments)] // Bevy systems often need many parameters
pub fn update_vehicle_traffic_state(
    _time: Res<Time<Fixed>>,
    traffic_cfg: Res<TrafficConfig>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    reservations: Res<IntersectionReservations>,
    path_pool: Res<super::super::super::transport::PathPool>,
    mut commands: Commands,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    q_priorities: Query<&crate::game::intersections::IntersectionPriorityMarker>,
    mut q_vehicles: Query<
        (
            Entity,
            &Vehicle,
            &mut VehicleTrafficState,
            Option<&RightTurnOnRed>,
        ),
        Without<Parked>,
    >,
    mut light_by_key: Local<
        HashMap<
            crate::game::intersections::IntersectionKey,
            crate::game::intersections::TrafficLight,
        >,
    >,
    mut stop_sign_tiles: Local<HashSet<TilePos>>,
) {
    // Build light index once per tick (O(lights)) instead of scanning all lights per vehicle.
    light_by_key.clear();
    for l in q_lights.iter() {
        light_by_key.insert(l.intersection_key, l.clone());
    }

    // We only need to distinguish StopSign-driven stops from light-driven stops.
    // If a light gets removed while vehicles are stopped at it, we must release them.
    stop_sign_tiles.clear();
    for m in q_priorities.iter() {
        if m.priority == IntersectionPriority::StopSign {
            stop_sign_tiles.insert(m.pos);
        }
    }

    for (entity, vehicle, mut state, ror) in q_vehicles.iter_mut() {
        let Some(cur_tile) = path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor) else {
            // Invalid path handle/cursor: don't crash; let other systems clean up.
            continue;
        };

        // Safety net: if we're inside a cluster tile, always force CrossingIntersection.
        if is_intersection_tile(&grid, cur_tile) {
            if let Some(key) = intersections.cluster_key_at(cur_tile) {
                *state = VehicleTrafficState::CrossingIntersection { intersection: key };
            } else {
                *state = VehicleTrafficState::FreeFlow;
            }
            if ror.is_some() {
                commands.entity(entity).remove::<RightTurnOnRed>();
            }
            continue;
        }

        let Some(info) = compute_approach_info(&grid, &intersections, &path_pool, vehicle) else {
            // Not approaching any intersection soon: normalize to FreeFlow and clear stale markers.
            if !matches!(*state, VehicleTrafficState::FreeFlow) {
                *state = VehicleTrafficState::FreeFlow;
            }
            if ror.is_some() {
                commands.entity(entity).remove::<RightTurnOnRed>();
            }
            continue;
        };

        // Stop sign on the intersection tile: enforce a stop at the stop line; release handled by
        // `check_intersection_priority`.
        if stop_sign_tiles.contains(&info.first_intersection_tile) {
            if info.dist_to_stop_line_tiles <= STOP_LINE_EPS_TILES && vehicle.speed < 0.1 {
                *state = VehicleTrafficState::Stopped {
                    intersection: info.intersection_key,
                    stop_tile: info.stop_tile,
                    queue_position: 0,
                };
            } else {
                *state = VehicleTrafficState::Approaching {
                    intersection: info.intersection_key,
                    stop_tile: info.stop_tile,
                    distance_to_stop: info.dist_to_stop_line_tiles,
                };
            }
            if ror.is_some() {
                commands.entity(entity).remove::<RightTurnOnRed>();
            }
            continue;
        }

        let light = light_by_key.get(&info.intersection_key);
        let (is_green, is_yellow, is_all_red) = if let Some(l) = light {
            (
                l.is_green(info.entry_dir),
                l.is_yellow(info.entry_dir),
                l.is_all_red(),
            )
        } else {
            (false, false, false)
        };

        // Default "stop" behavior for red (or yellow when we can stop).
        // If we are already stopped/waiting for THIS stop line, keep that state even if the stored
        // `Vehicle.speed` is inconsistent (tests intentionally inject absurd values).
        let prev_state = *state;
        let keep_stopped_or_waiting = matches!(
            prev_state,
            VehicleTrafficState::WaitingForGreen {
                intersection,
                stop_tile,
            } if intersection == info.intersection_key && stop_tile == info.stop_tile
        ) || matches!(
            prev_state,
            VehicleTrafficState::Stopped {
                intersection,
                stop_tile,
                ..
            } if intersection == info.intersection_key && stop_tile == info.stop_tile
        );

        let stop_state = if keep_stopped_or_waiting {
            prev_state
        } else if info.dist_to_stop_line_tiles <= STOP_LINE_EPS_TILES && vehicle.speed < 0.1 {
            VehicleTrafficState::WaitingForGreen {
                intersection: info.intersection_key,
                stop_tile: info.stop_tile,
            }
        } else {
            VehicleTrafficState::Approaching {
                intersection: info.intersection_key,
                stop_tile: info.stop_tile,
                distance_to_stop: info.dist_to_stop_line_tiles,
            }
        };

        if light.is_none() {
            // Uncontrolled intersection without a stop sign: keep FreeFlow.
            if !matches!(*state, VehicleTrafficState::FreeFlow) {
                *state = VehicleTrafficState::FreeFlow;
            }
            if ror.is_some() {
                commands.entity(entity).remove::<RightTurnOnRed>();
            }
            continue;
        }

        // Signalized intersection.
        if is_green {
            // If we were waiting/stopped for this light, release.
            if matches!(
                *state,
                VehicleTrafficState::WaitingForGreen { intersection, .. }
                    | VehicleTrafficState::Stopped { intersection, .. }
                    if intersection == info.intersection_key
            ) {
                *state = VehicleTrafficState::Accelerating;
            } else {
                *state = VehicleTrafficState::FreeFlow;
            }
            if ror.is_some() {
                commands.entity(entity).remove::<RightTurnOnRed>();
            }
            continue;
        }

        if is_yellow {
            // Yellow: if stopping comfortably is impossible, proceed (GDD).
            let tile_size = cfg.tile_size.max(0.1);
            let speed_tiles = (vehicle.speed / tile_size).max(0.0);
            let decel_tiles = (vehicle.max_accel / tile_size).max(1e-3);
            let stop_dist_tiles = (speed_tiles * speed_tiles) / (2.0 * decel_tiles);

            if stop_dist_tiles > info.dist_to_stop_line_tiles + 1e-3 {
                *state = VehicleTrafficState::CrossingIntersection {
                    intersection: info.intersection_key,
                };
                if ror.is_some() {
                    commands.entity(entity).remove::<RightTurnOnRed>();
                }
                continue;
            }

            // Otherwise treat like red (stop if safe).
            *state = stop_state;
        } else {
            // Red (including all-red): stop.
            *state = stop_state;
        }

        // Right turn on red: if we have a reservation while the light is red (not all-red) and the
        // planned maneuver is the near-side turn, mark + release.
        let light_is_red = !is_green && !is_yellow;
        let allowed_turn_dir = if traffic_cfg.drive_on_right {
            info.entry_dir.right()
        } else {
            info.entry_dir.left()
        };
        let is_right_turn = info.exit_dir != RoadDir::None && info.exit_dir == allowed_turn_dir;
        let reserved = reservations.is_reserved_by(info.intersection_id, entity);
        let stopped_or_waiting = matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        );

        if light_is_red && !is_all_red && is_right_turn && reserved && stopped_or_waiting {
            if ror.is_none() {
                commands.entity(entity).insert(RightTurnOnRed {
                    intersection_id: info.intersection_id,
                });
            }
            *state = VehicleTrafficState::Accelerating;
        } else if ror.is_some() {
            commands.entity(entity).remove::<RightTurnOnRed>();
        }
    }
}

pub fn compute_exit_direction(
    route: &[TilePos],
    grid: &MapGrid,
    first_intersection_tile: TilePos,
) -> RoadDir {
    let Some(start_i) = route.iter().position(|t| *t == first_intersection_tile) else {
        return RoadDir::None;
    };
    let mut i = start_i;
    while i < route.len() && is_intersection_tile(grid, route[i]) {
        i += 1;
    }
    if i == 0 || i >= route.len() {
        return RoadDir::None;
    }
    let last_intersection = route[i - 1];
    let exit_tile = route[i];
    dir_between_adjacent(last_intersection, exit_tile)
}

pub fn check_intersection_priority(
    grid: Res<MapGrid>,
    _cfg: Res<MapConfig>,
    intersections: Res<IntersectionIndex>,
    path_pool: Res<super::super::super::transport::PathPool>,
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState), Without<Parked>>,
    q_intersections: Query<&crate::game::intersections::IntersectionPriorityMarker>,
    mut priority_by_tile: Local<
        std::collections::HashMap<TilePos, crate::game::intersections::IntersectionPriority>,
    >,
) {
    // Build marker lookup once per tick.
    priority_by_tile.clear();
    for m in q_intersections.iter() {
        priority_by_tile.insert(m.pos, m.priority);
    }

    for (_e, v, mut st) in q_vehicles.iter_mut() {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        if is_intersection_tile(&grid, cur) {
            if let Some(key) = intersections.cluster_key_at(cur) {
                *st = VehicleTrafficState::CrossingIntersection { intersection: key };
            }
            continue;
        }
        let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1) else {
            continue;
        };
        if !is_intersection_tile(&grid, next) {
            continue;
        }

        let Some(priority) = priority_by_tile.get(&next).copied() else {
            continue;
        };
        if priority != IntersectionPriority::StopSign {
            continue;
        }

        let Some(key) = intersections.cluster_key_at(next) else {
            continue;
        };

        // If we already released for this intersection and we're still on the approach tile,
        // do not oscillate back to stopped.
        if matches!(*st, VehicleTrafficState::CrossingIntersection { intersection } if intersection == key)
        {
            continue;
        }

        // Release once we've come to a stop at the stop line (simulated by being in Stopped).
        let should_release = matches!(
            *st,
            VehicleTrafficState::Stopped { stop_tile, .. } if stop_tile == cur
        );
        if should_release {
            *st = VehicleTrafficState::CrossingIntersection { intersection: key };
        }
    }
}
