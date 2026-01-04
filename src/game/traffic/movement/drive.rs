use super::super::*;
use crate::game::transport::PathPool;

pub fn cleanup_right_on_red_markers(
    intersections: Res<IntersectionIndex>,
    path_pool: Res<PathPool>,
    mut commands: Commands,
    q: Query<(Entity, &Vehicle, &RightTurnOnRed), Without<Parked>>,
) {
    for (e, v, ror) in q.iter() {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            commands.entity(e).remove::<RightTurnOnRed>();
            continue;
        };
        let cur_id = intersections.intersection_id_at(cur);
        let next_id = path_pool
            .get_tile(v.path_handle, v.path_cursor + 1)
            .and_then(|t| intersections.intersection_id_at(t));

        let in_or_approaching =
            cur_id == Some(ror.intersection_id) || next_id == Some(ror.intersection_id);
        if !in_or_approaching {
            commands.entity(e).remove::<RightTurnOnRed>();
        }
    }
}

/// Move vehicles along their routes.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub fn move_vehicles(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    traffic_cfg: Res<TrafficConfig>,
    intersections: Res<IntersectionIndex>,
    reservations: Res<IntersectionReservations>,
    q_pedestrians: Query<&crate::game::pedestrians::PedestrianCrossing>,
    spatial: Res<TrafficSpatialIndex>,
    mut path_pool: ResMut<PathPool>,
    mut vehicle_agg: ResMut<VehicleAggSnapshot>,
    mut commands: Commands,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut ped_axis_mask: Local<
        std::collections::HashMap<crate::game::intersections::IntersectionId, u8>,
    >,
    mut vehicles: Query<
        (
            Entity,
            &mut Vehicle,
            &VehicleTrafficState,
            Option<&RightTurnOnRed>,
            Option<&TripPassenger>,
            Option<&CarOwner>,
            Option<&ServiceVehicle>,
            Option<&crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<Parked>,
    >,
) {
    let dt = time.delta_secs();
    let idm = idm_params_world(&cfg, &traffic_cfg);

    // Update telemetry counters for active (non-parked) vehicles while we already iterate them.
    vehicle_agg.active = VehicleAgg::default();

    // Snapshot pedestrian crossings by intersection id (axis-specific).
    // bit0 = axis_ns, bit1 = axis_ew
    ped_axis_mask.clear();
    for p in q_pedestrians.iter() {
        let m = ped_axis_mask.entry(p.intersection_id).or_insert(0);
        if p.axis_ns {
            *m |= 1 << 0;
        } else {
            *m |= 1 << 1;
        }
    }

    for (entity, mut v, state, ror, passenger, car_owner, service_vehicle, stuck_timer) in
        vehicles.iter_mut()
    {
        // --- Telemetry (cheap counters).
        {
            let a = &mut vehicle_agg.active;
            a.total = a.total.saturating_add(1);
            if path_pool.len(v.path_handle) == 0 || v.path_cursor >= path_pool.len(v.path_handle) {
                a.no_route = a.no_route.saturating_add(1);
            }
            if v.speed < 0.1 {
                a.zero_speed = a.zero_speed.saturating_add(1);
            }
            match state {
                VehicleTrafficState::FreeFlow => a.free_flow = a.free_flow.saturating_add(1),
                VehicleTrafficState::Approaching { .. } => {
                    a.approaching = a.approaching.saturating_add(1)
                }
                VehicleTrafficState::Stopped { .. } => a.stopped = a.stopped.saturating_add(1),
                VehicleTrafficState::WaitingForGreen { .. } => {
                    a.waiting = a.waiting.saturating_add(1)
                }
                VehicleTrafficState::CrossingIntersection { .. } => {
                    a.crossing = a.crossing.saturating_add(1)
                }
                VehicleTrafficState::Accelerating => {
                    a.accelerating = a.accelerating.saturating_add(1)
                }
            }
            if let Some(sv) = service_vehicle {
                match sv.state {
                    ServiceVehicleState::AtStation => {
                        a.service_at_station = a.service_at_station.saturating_add(1)
                    }
                    ServiceVehicleState::EnRoute => {
                        a.service_en_route = a.service_en_route.saturating_add(1)
                    }
                    ServiceVehicleState::OnScene => {
                        a.service_on_scene = a.service_on_scene.saturating_add(1)
                    }
                    ServiceVehicleState::Returning => {
                        a.service_returning = a.service_returning.saturating_add(1);
                        if path_pool.len(v.path_handle) == 0
                            || v.path_cursor >= path_pool.len(v.path_handle)
                        {
                            a.service_returning_no_route =
                                a.service_returning_no_route.saturating_add(1);
                        }
                        if v.speed < 0.1 {
                            a.service_returning_zero_speed =
                                a.service_returning_zero_speed.saturating_add(1);
                        }
                    }
                }
            }
        }
        if path_pool.len(v.path_handle) == 0 || v.path_cursor >= path_pool.len(v.path_handle) {
            // Arrived – despawn trip vehicles, keep service vehicles (idle).
            if service_vehicle.is_none() {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                commands.entity(entity).despawn();
            }
            continue;
        }

        // --- Desired speed from speed limits (RoadKind.speed_limit() is treated as km/h).
        //
        // IMPORTANT: intersection tiles are represented as road cells with `dir=None` (cluster
        // marker). They may have a different `RoadKind` than the approach/exit tiles, and sometimes
        // can even end up with a 0 km/h speed limit. We therefore derive the desired speed limit
        // from the adjacent **non-intersection** tiles (approach/exit) while inside the cluster.
        let current_tile = path_pool.get_tile(v.path_handle, v.path_cursor).unwrap();
        let current_is_intersection = is_intersection_tile(&grid, current_tile);

        let mut speed_limit_world = if current_is_intersection {
            0.0
        } else {
            road_speed_limit_world(&cfg, &traffic_cfg, current_tile, &grid)
        };

        // Fallback to adjacent tiles (prev/next) or, for intersection tiles, use them as the
        // primary speed limit source.
        if v.path_cursor > 0 {
            let prev = path_pool
                .get_tile(v.path_handle, v.path_cursor - 1)
                .unwrap();
            if !is_intersection_tile(&grid, prev) {
                speed_limit_world =
                    speed_limit_world.max(road_speed_limit_world(&cfg, &traffic_cfg, prev, &grid));
            }
        }
        if let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1)
            && !is_intersection_tile(&grid, next)
        {
            speed_limit_world =
                speed_limit_world.max(road_speed_limit_world(&cfg, &traffic_cfg, next, &grid));
        }
        if speed_limit_world <= 0.0 {
            // Defensive fallback: never allow a 0 speed limit to freeze vehicles.
            speed_limit_world = v.max_speed;
        }
        let mut v0 = speed_limit_world.min(v.max_speed).max(0.0);
        if let Some(ror) = ror.copied() {
            let cap = kmh_to_world_speed(&cfg, &traffic_cfg, RIGHT_ON_RED_TURN_MAX_KMH);
            // Clamp while we're in the intersection cluster OR still on the approach tile to it.
            let cur_id = intersections.intersection_id_at(current_tile);
            let next_id = path_pool
                .get_tile(v.path_handle, v.path_cursor + 1)
                .and_then(|t| intersections.intersection_id_at(t));
            if cur_id == Some(ror.intersection_id) || next_id == Some(ror.intersection_id) {
                v0 = v0.min(cap);
            }
        }

        // --- Leader detection (tile-local) + virtual leaders (stop lines / blocked next tile).
        let mut leader: Option<(f32, f32)> = spatial.leader_same_tile(entity);
        if let Some(next_tile) = path_pool.get_tile(v.path_handle, v.path_cursor + 1)
            && let Some(next_idx) = grid.idx(next_tile)
            && let Some((min_p, lead_v)) = spatial.tile_min_progress_speed(next_idx)
        {
            let gap_tiles = (1.0_f32 - v.progress) + min_p;
            let gap_world = gap_tiles.max(0.0) * cfg.tile_size.max(0.1);
            leader = Some(match leader {
                Some((g, gv)) if g <= gap_world => (g, gv),
                _ => (gap_world, lead_v),
            });
        }

        // Virtual leader: stop line (traffic lights/stop signs).
        if let VehicleTrafficState::Approaching {
            distance_to_stop, ..
        } = state
        {
            // IDM keeps a standstill gap of `s0` to a leader. For a virtual stop-line leader we want
            // the vehicle to come to rest *at* the stop line, not `s0` behind it. Achieve that by
            // shifting the virtual leader forward by `s0`.
            let gap_world = distance_to_stop.max(0.0) * cfg.tile_size.max(0.1) + idm.s0;
            let stop_leader = (gap_world, 0.0);
            leader = Some(match leader {
                Some((g, gv)) if g <= stop_leader.0 => (g, gv),
                _ => stop_leader,
            });
        }

        // Virtual leader: next tile blocked by capacity / admission / "don't block the box".
        //
        // NOTE: even when we are in Stopped/WaitingForGreen, we keep the kinematic update path and
        // simply force `blocked_next=true`. This avoids abrupt "snap to 0" while still preventing
        // any forward progress past the stop line.
        let mut blocked_next = false;
        let mut blocked_next_is_intersection = false;
        if let Some(next_tile) = path_pool.get_tile(v.path_handle, v.path_cursor + 1) {
            let current_is_intersection = is_intersection_tile(&grid, current_tile);
            let next_is_intersection = is_intersection_tile(&grid, next_tile);

            // Intersection admission: require a reservation to enter an intersection tile.
            if next_is_intersection && !current_is_intersection {
                blocked_next_is_intersection = true;

                // If we're explicitly waiting for green, never enter even if a reservation exists.
                // (Right-on-red is handled by transitioning out of WaitingForGreen once released.)
                if matches!(state, VehicleTrafficState::WaitingForGreen { .. }) {
                    blocked_next = true;
                } else {
                    let ok = if let Some(id) = intersections.intersection_id_at(next_tile) {
                        reservations.is_reserved_by(id, entity)
                    } else {
                        false
                    };
                    if !ok {
                        blocked_next = true;
                    }

                    // Yield to pedestrians already crossing.
                    if !blocked_next
                        && let Some(id) = intersections.intersection_id_at(next_tile)
                        && let Some(mask) = ped_axis_mask.get(&id).copied()
                        && mask != 0
                    {
                        if !intersections.traffic_lights.contains(&id) {
                            blocked_next = true;
                        } else {
                            let entry_dir = dir_between_adjacent(current_tile, next_tile);
                            let exit_dir = compute_exit_direction(
                                path_pool
                                    .remaining_from(v.path_handle, v.path_cursor)
                                    .unwrap_or(&[]),
                                &grid,
                                next_tile,
                            );
                            if entry_dir != RoadDir::None && exit_dir != RoadDir::None {
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

                                let is_right_turn = exit_dir == right;
                                let is_left_turn = exit_dir == left;

                                if is_left_turn {
                                    blocked_next = true;
                                } else if is_right_turn {
                                    let conflicts_ns =
                                        matches!(exit_dir, RoadDir::East | RoadDir::West);
                                    let conflicts_ew =
                                        matches!(exit_dir, RoadDir::North | RoadDir::South);
                                    if (conflicts_ns && (mask & (1 << 0)) != 0)
                                        || (conflicts_ew && (mask & (1 << 1)) != 0)
                                    {
                                        blocked_next = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Tile-capacity gate: only applies to **non-intersection** road tiles.
            // Intersection cluster tiles are managed via reservations/conflict zones instead.
            if !next_is_intersection
                && let Some(next_idx) = grid.idx(next_tile)
                && let Some(next_cell) = grid.get(next_tile)
                && next_cell.road.is_some()
                && next_idx < traffic.per_tick_vehicles.len()
            {
                let cap = next_cell.road.kind.capacity_per_lane_tile();
                let occ = traffic.per_tick_vehicles[next_idx];
                if occ >= cap {
                    blocked_next = true;
                }
            }

            // "Don't block the box": entering intersection requires free space to exit.
            if !blocked_next && next_is_intersection {
                let rem = path_pool
                    .remaining_from(v.path_handle, v.path_cursor)
                    .unwrap_or(&[]);
                let exit_tile = rem
                    .iter()
                    .position(|t| *t == next_tile)
                    .and_then(|start_i| {
                        let mut i = start_i;
                        while i < rem.len() && is_intersection_tile(&grid, rem[i]) {
                            i += 1;
                        }
                        rem.get(i).copied()
                    });

                if let Some(exit_tile) = exit_tile
                    && let Some(exit_idx) = grid.idx(exit_tile)
                    && let Some(exit_cell) = grid.get(exit_tile)
                    && exit_cell.road.is_some()
                    && exit_idx < traffic.per_tick_vehicles.len()
                {
                    let cap = exit_cell.road.kind.capacity_per_lane_tile();
                    let occ = traffic.per_tick_vehicles[exit_idx];
                    if occ >= cap {
                        blocked_next = true;
                    }
                }
            }
        }

        if blocked_next {
            let gap_tiles = if blocked_next_is_intersection {
                // Stop line is before the intersection boundary, on the approach tile.
                (TILE_CENTER_TO_EDGE_TILES - v.progress - STOP_LINE_OFFSET).max(0.0)
            } else {
                (1.0 - v.progress).max(0.0)
            };
            // Same logic as stop-line leader above: for an intersection admission block, shift
            // the virtual leader forward by `s0` so the vehicle can reach the stop line.
            let mut gap_world = gap_tiles * cfg.tile_size.max(0.1);
            if blocked_next_is_intersection {
                gap_world += idm.s0;
            }
            let block_leader = (gap_world, 0.0);
            leader = Some(match leader {
                Some((g, gv)) if g <= block_leader.0 => (g, gv),
                _ => block_leader,
            });
        }

        // Reverse movement for stuck vehicles (GDD: max 10 km/h, only when stuck)
        const MAX_REVERSE_SPEED_KMH: f32 = 10.0;
        const MAX_REVERSE_DISTANCE_TILES: f32 = 2.5; // 2-3 tiles max
        let can_reverse = stuck_timer
            .map(|stuck| stuck.secs >= crate::game::traffic::STUCK_REROUTE_SECS)
            .unwrap_or(false)
            && blocked_next
            && v.path_cursor > 0; // Can only reverse if not at start of path

        if can_reverse && v.reverse_distance < MAX_REVERSE_DISTANCE_TILES {
            // Allow reverse movement
            v.is_reversing = true;
            let max_reverse_speed =
                crate::game::traffic::kmh_to_world_speed(&cfg, &traffic_cfg, MAX_REVERSE_SPEED_KMH);
            v.speed = max_reverse_speed.min(v.speed + 2.0 * dt); // Gentle acceleration backwards
        } else if v.is_reversing && !can_reverse {
            // Stop reversing when no longer stuck or reached max distance
            v.is_reversing = false;
            v.speed = 0.0;
        } else if !v.is_reversing {
            // Normal forward movement
            // IDM speed update.
            if v0 > 0.0 {
                let accel = idm_accel_world(v.speed, v0, leader, &idm);
                v.speed = (v.speed + accel * dt).clamp(0.0, v0);
            } else {
                v.speed = 0.0;
            }
        }

        // Advance along the current tile (forward or backward).
        let tile_size = cfg.tile_size.max(0.1);
        let desired_dprog = if v.is_reversing {
            // Reverse: decrease progress
            -(v.speed * dt) / tile_size
        } else {
            // Forward: increase progress
            (v.speed * dt) / tile_size
        };
        let prev_p = v.progress;

        if v.is_reversing {
            // Reverse movement: decrease progress, but don't go below 0
            let desired_p = (prev_p + desired_dprog).max(0.0);
            v.progress = desired_p;
            // Update reverse distance
            v.reverse_distance += desired_dprog.abs();

            // If we've reversed to the start of current tile, move to previous tile
            if v.progress <= 0.0 && v.path_cursor > 0 {
                v.path_cursor = v.path_cursor.saturating_sub(1);
                v.progress = 1.0; // Start at end of previous tile
            }
        } else if path_pool
            .get_tile(v.path_handle, v.path_cursor + 1)
            .is_some()
            && blocked_next
        {
            let stop_before = 0.001;
            let max_p = if blocked_next_is_intersection {
                // Clamp to the stop line within the approach tile.
                (TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET).max(0.0)
            } else {
                1.0 - stop_before
            };
            let desired_p = prev_p + desired_dprog;
            let next_p = desired_p.min(max_p);
            v.progress = next_p;

            // Kinematic speed cap: if we hit the clamp this tick, adjust speed so we don't "snap".
            if next_p < desired_p {
                let actual_dprog = (next_p - prev_p).max(0.0);
                let denom = dt.max(1e-6);
                v.speed = (actual_dprog * tile_size) / denom;
            }
            // Reset reverse distance when moving forward
            v.reverse_distance = 0.0;
        } else {
            v.progress = prev_p + desired_dprog;
            // Reset reverse distance when moving forward
            v.reverse_distance = 0.0;
        }

        let mut last_tile_for_arrival = path_pool
            .get_tile(v.path_handle, v.path_cursor)
            .unwrap_or(TilePos { x: 0, y: 0 });
        while v.progress >= 1.0 && v.path_cursor < path_pool.len(v.path_handle) {
            v.progress -= 1.0;
            last_tile_for_arrival = path_pool
                .get_tile(v.path_handle, v.path_cursor)
                .unwrap_or(last_tile_for_arrival);
            v.path_cursor = v.path_cursor.saturating_add(1);
        }

        if v.path_cursor >= path_pool.len(v.path_handle) {
            if service_vehicle.is_none() {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                // CarTour Variant B: keep citizen-owned cars parked instead of despawning them.
                if car_owner.is_some() && passenger.is_some() {
                    // Release old path and create new single-tile path
                    path_pool.release(v.path_handle);
                    v.path_handle = path_pool.intern(vec![last_tile_for_arrival]);
                    v.path_cursor = 0;
                    v.progress = 0.0;
                    v.speed = 0.0;
                    commands
                        .entity(entity)
                        .insert((Parked { offset: 1.0 }, VehicleTrafficState::FreeFlow))
                        .remove::<TripPassenger>()
                        .remove::<RightTurnOnRed>();
                } else {
                    commands.entity(entity).despawn();
                }
            }
            continue;
        }

        // Lerp between current tile and next.
        let Some(curr) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        let next = path_pool
            .get_tile(v.path_handle, v.path_cursor + 1)
            .unwrap_or(curr);

        let curr_world = tile_to_world(&cfg, curr);
        let next_world = tile_to_world(&cfg, next);
        let lerped = curr_world.lerp(next_world, v.progress.clamp(0.0, 1.0));

        // Store current position for GPU interpolation (60fps rendering)
        // Transform will be updated by interpolation system for smooth movement
        v.prev_world_pos = v.curr_world_pos;
        v.curr_world_pos = lerped;
        v.last_update_time = time.elapsed_secs_f64() as f32;
    }
}
