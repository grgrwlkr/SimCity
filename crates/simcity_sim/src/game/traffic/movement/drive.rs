use super::super::*;
use crate::game::transport::PathPool;

/// Decide whether the tile-capacity gate should block a vehicle's step from its current tile onto
/// `next_tile`, given the box/road classification of both tiles and the next tile's occupancy/cap.
///
/// Rules:
/// - A step onto an intersection box tile (`next_is_intersection`) is NEVER capacity-blocked here —
///   box tiles are governed by reservations / conflict zones, not road capacity.
/// - A step LEAVING an intersection box (`current_is_intersection && !next_is_intersection`) is
///   NEVER capacity-blocked — CLEAR-THE-BOX priority: a committed in-box car must always be able to
///   step out onto its exit road even when that road is momentarily full, otherwise it wedges Inside
///   the box and pins the perpendicular axis. The transient `occ == cap+1` overfill is same-lane,
///   same-direction, behind a moving lead — not a collision.
/// - A normal road→road step (`!current_is_intersection && !next_is_intersection`) IS blocked when
///   `occ >= cap`, preserving road capacity so open-road traffic cannot overfill a tile.
const fn capacity_blocks_step(
    current_is_intersection: bool,
    next_is_intersection: bool,
    occ: u16,
    cap: u16,
) -> bool {
    if next_is_intersection || current_is_intersection {
        return false;
    }
    occ >= cap
}

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
    // Mutable: the box-entry gate takes the DEFERRED conflict-tile reservation (`try_admit`) at the
    // exact tick a vehicle steps onto its first box tile (an `Approaching` grant no longer pre-locks
    // the box). Serialized by construction — `move_vehicles` iterates vehicles sequentially, so each
    // entrant's `active_mask` write is visible to the next conflicting entrant's check.
    mut reservations: ResMut<IntersectionReservations>,
    matrices: Res<crate::game::transport::LaneletConflictMatrices>,
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
            Option<&crate::game::public_transport::Bus>,
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

    for (entity, mut v, state, ror, passenger, car_owner, service_vehicle, bus, stuck_timer) in
        vehicles.iter_mut()
    {
        // --- Telemetry (cheap counters).
        {
            let a = &mut vehicle_agg.active;
            a.total = a.total.saturating_add(1);
            if bus.is_some() {
                a.buses = a.buses.saturating_add(1);
            }
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
            if service_vehicle.is_none() && bus.is_none() {
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
        let Some(current_tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            // PathPool corruption/invalid handle: avoid crashing the whole sim tick.
            continue;
        };
        let current_is_intersection = is_intersection_tile(&grid, current_tile);

        let mut speed_limit_world = if current_is_intersection {
            0.0
        } else {
            road_speed_limit_world(&cfg, &traffic_cfg, current_tile, &grid)
        };

        // Fallback to adjacent tiles (prev/next) or, for intersection tiles, use them as the
        // primary speed limit source.
        if v.path_cursor > 0
            && let Some(prev) = path_pool.get_tile(v.path_handle, v.path_cursor - 1)
            && !is_intersection_tile(&grid, prev)
        {
            speed_limit_world =
                speed_limit_world.max(road_speed_limit_world(&cfg, &traffic_cfg, prev, &grid));
        }
        if let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1)
            && !is_intersection_tile(&grid, next)
        {
            speed_limit_world =
                speed_limit_world.max(road_speed_limit_world(&cfg, &traffic_cfg, next, &grid));
        }
        if speed_limit_world <= 0.0 {
            // Defensive fallback: never allow a 0 speed limit to freeze vehicles.
            // Try prev/next tiles first, then use vehicle's max_speed.
            speed_limit_world = v.max_speed;

            // Try to get speed from adjacent non-intersection tiles
            if v.path_cursor > 0
                && let Some(prev) = path_pool.get_tile(v.path_handle, v.path_cursor - 1)
                && !is_intersection_tile(&grid, prev)
            {
                let prev_speed = road_speed_limit_world(&cfg, &traffic_cfg, prev, &grid);
                if prev_speed > 0.0 {
                    speed_limit_world = prev_speed;
                }
            }
            if let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1)
                && !is_intersection_tile(&grid, next)
            {
                let next_speed = road_speed_limit_world(&cfg, &traffic_cfg, next, &grid);
                if next_speed > 0.0 {
                    speed_limit_world = speed_limit_world.max(next_speed);
                }
            }
        }
        let profile_factor = if service_vehicle.is_some() {
            SERVICE_VEHICLE_SPEED_LIMIT_FACTOR
        } else if v.speed_factor.is_finite() {
            v.speed_factor
                .clamp(DRIVER_PROFILE_FACTOR_MIN, DRIVER_PROFILE_FACTOR_MAX)
        } else {
            DRIVER_PROFILE_MEDIUM_FACTOR
        };
        let mut v0 = (speed_limit_world * profile_factor)
            .min(v.max_speed)
            .max(0.0);
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
            let gap_world = (gap_tiles.max(0.0) * cfg.tile_size.max(0.1)
                - VEHICLE_VISUAL_LENGTH_TILES * cfg.tile_size.max(0.1))
            .max(0.0);
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
        // Set when the vehicle is eligible to enter the box but is still on the approach tile, below
        // the box boundary (`progress < TILE_CENTER_TO_EDGE_TILES`), and has NOT yet taken its precise
        // conflict-tile reservation. It is allowed to creep forward but must be HARD-clamped at the
        // boundary so it cannot physically cross into the box without first holding `active_mask`.
        let mut clamp_to_box_boundary = false;
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
                    // DEFERRED-RESERVATION ENTRY GATE (collision-safety enforcement point). An
                    // `Approaching` grant only makes the vehicle ELIGIBLE to attempt entry; the
                    // conflict-tile reservation (`active_mask`) is taken HERE, the moment the vehicle
                    // is at the box boundary (`progress >= TILE_CENTER_TO_EDGE_TILES`), via the
                    // conflict matrix against the cars ACTUALLY INSIDE the box. Because `move_vehicles`
                    // processes vehicles one at a time, each successful entrant's `active_mask` bit is
                    // set before the next conflicting candidate is checked — so two conflicting
                    // vehicles can NEVER both enter the box in the same tick (the second's `try_admit`
                    // fails → it waits at the boundary and retries next tick).
                    //
                    // BOUNDARY-GATED HOLD (fixes the approach-long starvation): the tile boundary is at
                    // `progress == TILE_CENTER_TO_EDGE_TILES` (0.5); below it the vehicle's body is
                    // still entirely on the APPROACH tile, NOT in the box. Taking the precise
                    // conflict-tile reservation back when the car first became eligible (progress ~0,
                    // far from the box) made it HOLD the box's conflict tile for its ENTIRE slow
                    // approach — permanently refusing every conflicting maneuver even though the box is
                    // physically empty (the live "left turn frozen at an empty box" freeze). We now let
                    // an eligible car roll up to the boundary WITHOUT grabbing `active_mask`, and only
                    // take the reservation once it is actually at/over the boundary (entering the box).
                    // Collision-safety is unchanged: the hold is taken exactly when the car's center
                    // crosses into the box, still serialized one-at-a-time within the tick.
                    let at_boundary = v.progress >= TILE_CENTER_TO_EDGE_TILES;
                    let ok = if let Some(id) = intersections.intersection_id_at(next_tile) {
                        match reservations.entry_reservation(id, entity) {
                            // Coarse whole-box grant already reserved the entire box exclusively at
                            // grant time — no per-lanelet check possible, admit.
                            Some((_, true)) => true,
                            // Precise grant: take the deferred conflict-tile reservation only once the
                            // car is at the box boundary (it is otherwise still on the approach tile and
                            // must not hold the box). Idempotent (returns true once this vehicle is
                            // already a holder, e.g. it cleared the gate last tick but hasn't physically
                            // crossed yet). Below the boundary it is "ok" to keep rolling forward toward
                            // the boundary, but holds nothing — `clamp_to_box_boundary` hard-clamps it
                            // to the boundary so it physically cannot cross without first holding.
                            Some((Some(local_idx), false)) => {
                                if at_boundary {
                                    reservations.ledger_mut(id).try_admit(
                                        entity,
                                        local_idx,
                                        matrices.row_for(id, local_idx),
                                    )
                                } else {
                                    clamp_to_box_boundary = true;
                                    true
                                }
                            }
                            // Has a reservation but no lanelet row (in-box safety-net): admit.
                            Some((None, false)) => true,
                            // No reservation at all: not eligible.
                            None => false,
                        }
                    } else {
                        false
                    };
                    if !ok {
                        // Entry into an intersection requires passing the entry gate (an eligible
                        // reservation AND a matrix-clear box) — full stop at the line otherwise. The
                        // stuck-vehicle failsafe is the stall-tracker reroute nudge
                        // (nudge_lanelet_stall_reroute) — never a forced admission: the conflict
                        // model is not bypassable.
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
            //
            // CLEAR-THE-BOX EXEMPTION: never capacity-block a vehicle that is LEAVING an
            // intersection box (current tile is a `dir==None` box tile, next tile is the exit road
            // tile). Clearing the box has priority over exit-road capacity: a committed in-box car
            // whose exit road congests MID-CROSSING would otherwise freeze INSIDE the box, pinning
            // the perpendicular axis → gridlock (and triggering the despawn band-aid). Letting it
            // step out momentarily overfills the exit tile to occ=cap+1, then it advances — a
            // transient overfill in the SAME lane / SAME direction behind a moving lead, never a
            // collision. The capacity gate is preserved for road→road steps (`!current_is_intersection`)
            // so open-road traffic still cannot overfill a road, and for box-ENTRY via the separate
            // "don't block the box" gate below.
            if let Some(next_idx) = grid.idx(next_tile)
                && let Some(next_cell) = grid.get(next_tile)
                && next_cell.road.is_some()
                && next_idx < traffic.per_tick_vehicles.len()
            {
                let cap = next_cell.road.kind.capacity_per_lane_tile();
                let occ = traffic.per_tick_vehicles[next_idx];
                if capacity_blocks_step(current_is_intersection, next_is_intersection, occ, cap) {
                    blocked_next = true;
                }
            }

            // NOTE: the legacy "don't block the box" gate (refuse box ENTRY while the exit road is at
            // capacity) was REMOVED — it conflicts with clear-the-box. Clear-the-box guarantees a
            // committed in-box car always steps out onto its exit road even when that road is full
            // (the box→exit step is capacity-exempt above), so an admitted car ALWAYS exits. Refusing
            // entry because the exit is momentarily full therefore only FREEZES a deadlock cycle:
            // car A waits at box1's approach because box1's exit is held by B, which waits at box2's
            // approach because box2's exit is held by C, … — a circular wait that never unwinds even
            // though each car would exit fine if it just entered. Box ENTRY is now gated only by
            // collision-safety: the conflict-matrix `try_admit` against cars actually Inside the box
            // (the `next_is_intersection && !current_is_intersection` reservation gate above). Road
            // capacity is still preserved for open-road road→road steps via `capacity_blocks_step`.
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

        // Reverse movement for stuck vehicles (max 10 km/h, only when stuck). WITHIN the current
        // tile only: progress floors at 0.0 below, so a reversing car never crosses a tile
        // boundary — cross-tile backing is deliberately not modeled (no rear-collision model, and
        // ПДД 8.12 prohibits reversing at intersections).
        const MAX_REVERSE_SPEED_KMH: f32 = 10.0;
        let can_reverse = stuck_timer
            .map(|stuck| stuck.secs >= crate::game::traffic::STUCK_REROUTE_SECS)
            .unwrap_or(false)
            && blocked_next
            && v.path_cursor > 0; // Can only reverse if not at start of path

        if can_reverse {
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
            // Reverse: decrease progress, floored at 0.0 (the tile's start boundary). The cursor
            // NEVER decrements — backing across a tile boundary (in particular back INTO an
            // intersection box) is structurally impossible; pinned by
            // stuck_reverse_never_backs_into_intersection_box.
            v.progress = (prev_p + desired_dprog).max(0.0);
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
        } else {
            let mut next_p = prev_p + desired_dprog;

            // Hard overlap safety floor (pure safety net under the soft IDM model).
            //
            // Work in a CONTINUOUS longitudinal coordinate along the route: a vehicle's position is
            // `path_cursor + progress` (tile units). The follower's post-step position must satisfy
            //   follower_pos_next <= leader_pos - min_gap_tiles
            // where `min_gap_tiles` is the bumper-to-bumper minimum gap. We translate that bound into
            // a clamp on `next_p` for the CURRENT tile (the follower's cursor is the reference, so the
            // leader contributes a `+1.0` per cursor it is ahead).
            //
            // The leader is whichever is nearest-ahead — the SAME leader IDM already uses:
            //   * same-tile leader  -> leader_pos = lead_p           (same cursor)
            //   * next-tile leader  -> leader_pos = 1.0 + next_min_p (one cursor ahead)
            // If both exist we clamp to the NEARER one (the smaller positional cap). This makes the
            // hard clamp a strict floor under the soft model: it can only REDUCE next_p, never below
            // prev_p, and is a no-op whenever IDM already keeps a safe gap.
            let min_gap_tiles =
                ((idm.s0 + VEHICLE_VISUAL_LENGTH_TILES * tile_size) / tile_size).max(0.0);

            let mut leader_cap: Option<f32> = None;
            // Same-tile leader (continuous pos == lead_p, same cursor).
            if let Some(lead_p) = spatial.leader_same_tile_progress(entity) {
                let cap = lead_p - min_gap_tiles;
                leader_cap = Some(leader_cap.map_or(cap, |c: f32| c.min(cap)));
            }
            // Next-tile (boundary-crossing) leader (continuous pos == 1.0 + next_min_p, +1 cursor).
            // This is the realistic overlap case: a leader that just crossed onto the next tile while
            // the follower sits near the boundary, protected only by the soft virtual leader above.
            if let Some(next_tile) = path_pool.get_tile(v.path_handle, v.path_cursor + 1)
                && let Some(next_idx) = grid.idx(next_tile)
                && let Some((next_min_p, _lead_v)) = spatial.tile_min_progress_speed(next_idx)
            {
                let cap = (1.0 + next_min_p) - min_gap_tiles;
                leader_cap = Some(leader_cap.map_or(cap, |c: f32| c.min(cap)));
            }

            if let Some(cap) = leader_cap {
                let max_p = cap.max(prev_p);
                if next_p > max_p {
                    next_p = max_p;
                    let actual_dprog = (next_p - prev_p).max(0.0);
                    let denom = dt.max(1e-6);
                    v.speed = (actual_dprog * tile_size) / denom;
                }
            }

            v.progress = next_p;
        }

        // BOUNDARY HARD-CLAMP (deferred-reservation collision-safety floor). An eligible car that has
        // not yet taken its precise conflict-tile reservation (it was below the box boundary at the
        // gate) must not cross INTO the box this tick: hold it just below the boundary so it physically
        // stays on the approach tile until a later tick where it is at the boundary and its `try_admit`
        // succeeds. Without this, a fast car could jump from `progress < 0.5` straight past `0.5` into
        // the box in one step, entering WITHOUT holding `active_mask` (a collision hole). The clamp is
        // a strict floor (only reduces progress, never below `prev_p`).
        if clamp_to_box_boundary && !v.is_reversing {
            // Clamp to EXACTLY the boundary (not below): the car must be allowed to REACH
            // `progress == TILE_CENTER_TO_EDGE_TILES` so that next tick `at_boundary` is true and it
            // can take its `try_admit` reservation. Stopping it strictly below the boundary would
            // deadlock it there forever (it could never become "at boundary").
            let boundary_cap = TILE_CENTER_TO_EDGE_TILES.max(prev_p);
            if v.progress > boundary_cap {
                v.progress = boundary_cap;
                v.speed = v
                    .speed
                    .min(0.0_f32.max((v.progress - prev_p) * tile_size / dt.max(1e-6)));
            }
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
            if service_vehicle.is_none() && bus.is_none() {
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
    }
}

#[cfg(test)]
mod tests {
    use super::capacity_blocks_step;

    /// FIX 1 (clear-the-box): a vehicle ON an intersection box tile whose next tile is its exit road
    /// tile at FULL occupancy (`occ == cap`) must NOT be capacity-blocked — it always steps out of
    /// the box, draining it so the perpendicular axis can flow. Without this it freezes Inside the
    /// box and gridlocks (the wedge the despawn band-aid was papering over).
    #[test]
    fn leaving_box_onto_full_exit_road_is_not_capacity_blocked() {
        // current = box tile (dir==None → intersection), next = exit ROAD tile, exit road is FULL.
        assert!(
            !capacity_blocks_step(
                /* current_is_intersection */ true, /* next_is_intersection */ false,
                /* occ */ 2, /* cap */ 2,
            ),
            "a car LEAVING the intersection box must always be allowed to exit, even onto a full \
             exit road (clear-the-box priority)"
        );
        // And even when the exit road is over capacity (a transient overfill from a prior box-exit),
        // the leaving car is still not blocked.
        assert!(!capacity_blocks_step(true, false, 3, 2));
    }

    /// COMPLEMENT: a NORMAL road→road step onto a full next road tile IS still capacity-blocked, so
    /// open-road traffic cannot overfill a road tile. Only the box→exit step is exempt.
    #[test]
    fn road_to_road_onto_full_tile_is_still_capacity_blocked() {
        assert!(
            capacity_blocks_step(
                /* current_is_intersection */ false, /* next_is_intersection */ false,
                /* occ */ 2, /* cap */ 2,
            ),
            "road capacity must still gate a normal road→road move onto a full tile"
        );
        // Under capacity → not blocked.
        assert!(!capacity_blocks_step(false, false, 1, 2));
    }

    /// COMPLEMENT: a step INTO a box tile is never gated by this road-capacity check (box tiles are
    /// governed by reservations / the don't-block-the-box gate), regardless of the box's occupancy.
    #[test]
    fn entering_box_is_not_capacity_blocked_here() {
        assert!(!capacity_blocks_step(false, true, 5, 2));
        assert!(!capacity_blocks_step(true, true, 5, 2));
    }
}
