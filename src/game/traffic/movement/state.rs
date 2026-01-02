use super::super::*;

#[allow(clippy::too_many_arguments)]
pub(in super::super) fn update_vehicle_traffic_state(
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
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    mut light_by_key: Local<
        std::collections::HashMap<
            crate::game::intersections::IntersectionKey,
            crate::game::intersections::TrafficLight,
        >,
    >,
    mut stop_sign_tiles: Local<std::collections::HashSet<TilePos>>,
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

    for (entity, vehicle, mut state) in q_vehicles.iter_mut() {
        let remaining_route = path_pool.remaining_from(vehicle.path_handle, vehicle.path_cursor);
        let route = &remaining_route;
        let current_tile = route.first().copied();
        if route.is_empty() {
            // No remaining route: leave non-light systems to handle completion/parking.
            if matches!(
                *state,
                VehicleTrafficState::Approaching { .. }
                    | VehicleTrafficState::WaitingForGreen { .. }
            ) {
                *state = VehicleTrafficState::FreeFlow;
            }
            continue;
        }

        // If we're already inside an intersection cluster tile, never apply stop-line logic.
        // Vehicles inside the box must keep moving to exit; otherwise we can deadlock the cluster.
        if let Some(cur) = current_tile
            && is_intersection_tile(&grid, cur)
            && let Some(key) = intersections.cluster_key_at(cur)
        {
            *state = VehicleTrafficState::CrossingIntersection { intersection: key };
            continue;
        }

        // Find nearest traffic light on route (by index).
        let Some((intersection_key, approach_tile, intersection_tile, distance_to_light_tile)) =
            find_traffic_light_ahead(
                route,
                vehicle.progress,
                TRAFFIC_LIGHT_DETECTION_DISTANCE,
                &intersections,
            )
        else {
            // No traffic light ahead – leave non-light logic (e.g. stop signs) to other systems.
            // We clear *light-driven* states here, but keep stop-sign stops.
            //
            // Important: if a traffic light is removed while a vehicle is in Stopped/WaitingForGreen,
            // `has_traffic_light_at(stop_tile)` becomes false. Without this guard, vehicles would
            // remain stuck indefinitely.
            match *state {
                VehicleTrafficState::WaitingForGreen { .. } => {
                    // Stop signs never use WaitingForGreen.
                    *state = VehicleTrafficState::FreeFlow;
                }
                VehicleTrafficState::Stopped { stop_tile, .. }
                | VehicleTrafficState::Approaching { stop_tile, .. } => {
                    if !stop_sign_tiles.contains(&stop_tile) {
                        *state = VehicleTrafficState::FreeFlow;
                    }
                }
                _ => {}
            };
            continue;
        };

        // We only enforce "red/green" behavior if there is a TrafficLight entity.
        let Some(light) = light_by_key.get(&intersection_key) else {
            *state = VehicleTrafficState::FreeFlow;
            continue;
        };

        // Approach direction is defined by the edge into the first intersection tile.
        let entry_dir = dir_between_adjacent(approach_tile, intersection_tile);
        if entry_dir == RoadDir::None {
            // Can't determine approach direction reliably – don't block.
            *state = VehicleTrafficState::FreeFlow;
            continue;
        }

        // Distance to the stop line (not to the intersection tile itself).
        //
        // `distance_to_light_tile` is measured to the INTERSECTION TILE CENTER. The boundary
        // between approach and intersection is `0.5` tiles before that center.
        let stop_distance =
            (distance_to_light_tile - TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET).max(0.0);

        // Yellow decision: if it's already too late to stop comfortably, proceed.
        // Otherwise treat yellow like red (prepare to stop at the stop line).
        //
        // This avoids the brittle "within N tiles" heuristic and produces more realistic behavior.
        let is_yellow = light.is_yellow(entry_dir);
        let too_late_to_stop = if is_yellow {
            let dist_to_stop_world = stop_distance * cfg.tile_size;
            let wpm = world_per_meter(&cfg, &traffic_cfg);
            let b_world = traffic_cfg.idm_comfortable_decel_mps2.max(0.0) * wpm;
            if b_world <= 0.0 {
                true
            } else {
                let v = vehicle.speed.max(0.0);
                let stopping_dist_world = (v * v) / (2.0 * b_world);
                stopping_dist_world > dist_to_stop_world
            }
        } else {
            false
        };

        let mut can_go = light.is_green(entry_dir) || (is_yellow && too_late_to_stop);
        let mut must_stop = light.is_red(entry_dir) || (is_yellow && !too_late_to_stop);

        // Right turn on red (near-side turn): if we already own a reservation for this intersection,
        // allow proceeding even while the light is red (but not during all-red clearance).
        let mut is_right_on_red = false;
        let mut right_on_red_intersection_id: Option<IntersectionId> = None;
        if light.is_red(entry_dir)
            && !light.is_all_red()
            && let Some(id) = intersections.intersection_id_at(intersection_tile)
            && reservations.is_reserved_by(id, entity)
        {
            let exit_dir = compute_exit_direction(
                &path_pool.remaining_from(vehicle.path_handle, vehicle.path_cursor),
                &grid,
                intersection_tile,
            );
            let allowed_turn_dir = if traffic_cfg.drive_on_right {
                entry_dir.right()
            } else {
                entry_dir.left()
            };
            if exit_dir != RoadDir::None && exit_dir == allowed_turn_dir {
                can_go = true;
                must_stop = false;
                is_right_on_red = true;
                right_on_red_intersection_id = Some(id);
            }
        }

        // If we were stopped/waiting, only release on green.
        if matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        ) {
            if can_go {
                *state = VehicleTrafficState::Accelerating;
                if is_right_on_red {
                    if let Some(id) = right_on_red_intersection_id {
                        commands.entity(entity).insert(RightTurnOnRed {
                            intersection_id: id,
                        });
                    }
                } else {
                    commands.entity(entity).remove::<RightTurnOnRed>();
                }
            } else {
                *state = VehicleTrafficState::WaitingForGreen {
                    intersection: intersection_key,
                    stop_tile: approach_tile,
                };
            }
            continue;
        }

        if must_stop {
            // Once we reached the stop line AND are already nearly stopped, lock into a full stop.
            // Otherwise keep using Approaching so IDM braking can reduce speed smoothly.
            let speed_tiles_per_sec = vehicle.speed / cfg.tile_size.max(0.1);
            if stop_distance <= STOP_LINE_EPS_TILES
                && speed_tiles_per_sec <= STOP_LOCK_SPEED_TILES_PER_SEC
            {
                *state = VehicleTrafficState::Stopped {
                    intersection: intersection_key,
                    stop_tile: approach_tile,
                    queue_position: 0,
                };
            } else {
                // Approach at normal speed; braking is computed from stop_distance.
                *state = VehicleTrafficState::Approaching {
                    intersection: intersection_key,
                    stop_tile: approach_tile,
                    distance_to_stop: stop_distance,
                };
            }
        } else if can_go {
            // Green (or close yellow) – proceed through intersection.
            // If we were previously braking/approaching, clear it to avoid slow crawling.
            if matches!(*state, VehicleTrafficState::Approaching { .. }) {
                *state = VehicleTrafficState::CrossingIntersection {
                    intersection: intersection_key,
                };
            }
        }
    }
}

/// Find traffic light ahead on route
fn find_traffic_light_ahead(
    route: &[TilePos],
    progress: f32,
    max_distance: f32,
    intersections: &IntersectionIndex,
) -> Option<(IntersectionKey, TilePos, TilePos, f32)> {
    // Returns:
    // - intersection_key
    // - approach_tile (tile BEFORE the intersection/light tile)
    // - intersection_tile (the tile that owns the traffic light, inside the cluster)
    // - distance_to_intersection_tile_start (in tiles, from current progress to the boundary)
    //
    // NOTE: We intentionally do NOT return "current tile is light tile" here. Vehicles inside the
    // intersection cluster must not re-enter stop-line logic; callers should treat them as
    // CrossingIntersection.

    let mut distance = 1.0 - progress; // Remaining distance to end of current tile

    for i in 1..route.len() {
        if distance > max_distance {
            return None;
        }
        let tile = route[i];
        if intersections.has_traffic_light_at(tile)
            && let Some(key) = intersections.cluster_key_at(tile)
            && let Some(&approach) = route.get(i.wrapping_sub(1))
        {
            return Some((key, approach, tile, distance));
        }
        distance += 1.0;
    }
    None
}

pub(in super::super) fn compute_exit_direction(
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

/// Check intersection priority rules (yield/stop signs)
pub(in super::super) fn check_intersection_priority(
    grid: Res<MapGrid>,
    cfg: Res<MapConfig>,
    intersections: Res<IntersectionIndex>,
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    q_intersections: Query<&crate::game::intersections::IntersectionPriorityMarker>,
    mut priority_by_tile: Local<std::collections::HashMap<TilePos, IntersectionPriority>>,
) {
    // Build a cheap lookup once per tick (O(markers)) instead of scanning all markers per vehicle.
    priority_by_tile.clear();
    for m in q_intersections.iter() {
        priority_by_tile.insert(m.pos, m.priority);
    }

    // For intersections without traffic lights, apply priority rules
    for (_entity, vehicle, mut state) in q_vehicles.iter_mut() {
        let route = path_pool.remaining_from(vehicle.path_handle, vehicle.path_cursor);
        let Some(current_tile) = route.first().copied() else {
            continue;
        };

        let next_tile = route.get(1).copied();

        // Clear transient state once we're no longer in (or immediately before) the *same* intersection.
        //
        // Important: stop signs release vehicles on the approach tile (still not `dir=None`), so we
        // must not clear CrossingIntersection until the vehicle actually enters the cluster.
        if let VehicleTrafficState::CrossingIntersection { intersection } = *state {
            let still_related = if is_intersection_tile(&grid, current_tile) {
                intersections.cluster_key_at(current_tile) == Some(intersection)
            } else if let Some(nt) = next_tile
                && is_intersection_tile(&grid, nt)
            {
                intersections.cluster_key_at(nt) == Some(intersection)
            } else {
                false
            };

            if !still_related {
                *state = VehicleTrafficState::FreeFlow;
            }
        }

        // Check the NEXT tile (route[1]) so rules apply *before* entering the intersection.
        let Some(next_tile) = next_tile else {
            continue;
        };

        // Skip if has traffic light (lights handle priority).
        let has_traffic_light = intersections.has_traffic_light_at(next_tile);
        if has_traffic_light {
            continue;
        }

        // Only apply stop/yield rules on the approach tile (not once we're already inside).
        if is_intersection_tile(&grid, current_tile) {
            continue;
        }

        // Check if this is an intersection (dir == None)
        if is_intersection_tile(&grid, next_tile) {
            // This is an intersection - check for priority rules
            // Fast lookup for explicit priorities computed in `IntersectionsPlugin`.
            let found_priority = priority_by_tile.get(&next_tile).copied();

            // Fallback heuristic (mostly for minimal test worlds where the intersections plugin
            // isn't present): classify "main road" by adjacent lane count.
            let mut is_main_road = false;
            if found_priority.is_none() {
                for neighbor_pos in [
                    TilePos {
                        x: next_tile.x - 1,
                        y: next_tile.y,
                    },
                    TilePos {
                        x: next_tile.x + 1,
                        y: next_tile.y,
                    },
                    TilePos {
                        x: next_tile.x,
                        y: next_tile.y - 1,
                    },
                    TilePos {
                        x: next_tile.x,
                        y: next_tile.y + 1,
                    },
                ] {
                    if let Some(neighbor_cell) = grid.get(neighbor_pos)
                        && neighbor_cell.road.kind.lanes() >= 4
                    {
                        is_main_road = true;
                        break;
                    }
                }
            }

            // Apply priority rules based on intersection type
            match found_priority.unwrap_or(if is_main_road {
                IntersectionPriority::MainRoad
            } else {
                IntersectionPriority::None
            }) {
                IntersectionPriority::StopSign => {
                    let Some(intersection_key) = intersections.cluster_key_at(next_tile) else {
                        continue;
                    };
                    // If we've already been released for this intersection, don't re-apply stop sign
                    // logic while still on the approach tile. Otherwise we'd oscillate between
                    // Stopped <-> CrossingIntersection and move at half speed.
                    if matches!(
                        *state,
                        VehicleTrafficState::CrossingIntersection { intersection }
                            if intersection == intersection_key
                    ) {
                        continue;
                    }

                    // Stop sign - must come to complete stop BEFORE entering the intersection.
                    // Stop line is on the approach tile (current_tile), not on the intersection tile.
                    // Distance from current position to the intersection boundary (center-to-center model).
                    let dist_to_intersection =
                        (TILE_CENTER_TO_EDGE_TILES - vehicle.progress).max(0.0);
                    let dist_to_stop = (dist_to_intersection - STOP_LINE_OFFSET).max(0.0);
                    let speed_tiles_per_sec = vehicle.speed / cfg.tile_size.max(0.1);

                    if dist_to_stop <= STOP_LINE_EPS_TILES
                        && speed_tiles_per_sec <= STOP_LOCK_SPEED_TILES_PER_SEC
                    {
                        // First tick fully stopped at stop line: lock.
                        // Next tick: release to CrossingIntersection so admission/reservations can proceed.
                        if matches!(
                            *state,
                            VehicleTrafficState::Stopped { stop_tile, .. } if stop_tile == current_tile
                        ) {
                            *state = VehicleTrafficState::CrossingIntersection {
                                intersection: intersection_key,
                            };
                        } else {
                            *state = VehicleTrafficState::Stopped {
                                intersection: intersection_key,
                                stop_tile: current_tile,
                                queue_position: 0,
                            };
                        }
                    } else {
                        // Keep updating distance so IDM braking sees a decreasing gap.
                        *state = VehicleTrafficState::Approaching {
                            intersection: intersection_key,
                            stop_tile: current_tile,
                            distance_to_stop: dist_to_stop,
                        };
                    }
                }
                IntersectionPriority::YieldSign => {
                    // Yield sign - MVP: keep FreeFlow (could slow slightly later).
                }
                IntersectionPriority::MainRoad => {
                    // Main road - has priority, continue normally
                }
                IntersectionPriority::None => {
                    // Default right-of-way rules apply (not implemented yet)
                }
            }
        }
    }
}
