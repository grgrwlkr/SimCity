use super::swap_break::SwapDeadlocked;
use super::*;

/// Per-vehicle jam detector (in fixed-time seconds).
#[derive(Component, Debug, Clone, Copy)]
pub(super) struct StuckTimer {
    pub(super) secs: f32,
    pub(super) last_tile: TilePos,
    pub(super) last_progress: f32,
    pub(super) uturn_attempted: bool,
}

#[allow(clippy::type_complexity)]
pub(super) fn init_stuck_timers(
    mut commands: Commands,
    path_pool: Res<super::super::transport::PathPool>,
    q: Query<(Entity, &Vehicle), (With<Vehicle>, Without<StuckTimer>)>,
) {
    for (e, v) in q.iter() {
        let Some(tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        commands.entity(e).insert(StuckTimer {
            secs: 0.0,
            last_tile: tile,
            last_progress: v.progress,
            uturn_attempted: false,
        });
    }
}

pub(super) fn update_stuck_timers(
    time: Res<Time<Fixed>>,
    path_pool: Res<super::super::transport::PathPool>,
    mut q: Query<(&Vehicle, &VehicleTrafficState, &mut StuckTimer), Without<Parked>>,
) {
    let dt = time.delta_secs();
    for (v, state, mut stuck) in q.iter_mut() {
        let Some(tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            stuck.secs = 0.0;
            stuck.uturn_attempted = false;
            continue;
        };

        let progressed = tile != stuck.last_tile || (v.progress - stuck.last_progress).abs() > 0.02;

        // Legitimate waiting at lights/stop signs shouldn't trigger jam resolution.
        if progressed
            || matches!(
                *state,
                VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
            )
        {
            stuck.secs = 0.0;
            stuck.uturn_attempted = false;
        } else {
            stuck.secs += dt;
        }

        stuck.last_tile = tile;
        stuck.last_progress = v.progress;
    }
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn resolve_stuck_vehicles(
    time: Res<Time<Fixed>>,
    _cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<super::super::transport::PathPool>,
    intersections: Res<IntersectionIndex>,
    mut commands: Commands,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut q: Query<
        (
            Entity,
            &mut Vehicle,
            &VehicleTrafficState,
            Option<&TripPassenger>,
            Option<&ServiceVehicle>,
            &mut StuckTimer,
            Option<&SwapDeadlocked>,
        ),
        Without<Parked>,
    >,
) {
    let mut handled = 0usize;

    let mut ctx = PathfindingCtx {
        time_now_sec: time.elapsed_secs_f64(),
        cfg: &path_cfg,
        cache: &mut path_cache,
        graph: &graph,
        regions: Some(&regions),
        traffic: &traffic,
        grid: &grid,
        intersections: &intersections,
        max_iterations: None,
    };

    for (e, mut v, state, passenger, service_vehicle, mut stuck, swap_deadlocked) in q.iter_mut() {
        if handled >= MAX_UNSTUCK_PER_TICK {
            break;
        }
        if v.path_cursor >= path_pool.len(v.path_handle) {
            stuck.secs = 0.0;
            continue;
        }
        // Swap-deadlock failsafe: a vehicle the swap breaker flagged as having no straight escape is
        // removed after a short grace, bypassing the reroute/reverse resets below (which would
        // otherwise keep its timer pinned and never let it despawn). The flag is re-evaluated every
        // tick, so it only persists for a genuinely unbreakable swap.
        if swap_deadlocked.is_some()
            && service_vehicle.is_none()
            && stuck.secs >= SWAP_DEADLOCK_DESPAWN_SECS
        {
            if let Some(p) = passenger {
                finished.write(TripFinished {
                    citizen: p.citizen,
                    purpose: p.purpose,
                });
            }
            commands.entity(e).despawn();
            handled += 1;
            continue;
        }
        if matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        ) {
            continue;
        }
        if stuck.secs < STUCK_REROUTE_SECS {
            continue;
        }

        let Some(current) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        let goal = path_pool
            .get_tile(
                v.path_handle,
                path_pool.len(v.path_handle).saturating_sub(1),
            )
            .unwrap_or(current);

        // 1) Emergency re-route: try to find an alternative path to the same goal. Only count it as a
        //    real unstick (reset the timer + restart the path) when the route ACTUALLY changes. If the
        //    only path found is the same blocked one, do NOT reset stuck.secs — let it keep climbing so
        //    the despawn guardrail can eventually fire instead of resetting the timer forever (the bug
        //    that left deadlocked cars frozen indefinitely).
        let route = find_road_path_cached(&mut ctx, current, goal);
        if !route.is_empty()
            && Some(route.as_slice()) != path_pool.remaining_from(v.path_handle, v.path_cursor)
        {
            path_pool.release(v.path_handle);
            v.path_handle = path_pool.intern(route);
            v.path_cursor = 0;
            v.progress = 0.0;
            v.speed = v.speed.min(v.max_speed * 0.5);
            // Reset reverse state after reroute
            v.is_reversing = false;
            v.reverse_distance = 0.0;

            stuck.secs = 0.0;
            stuck.last_tile = current;
            stuck.last_progress = 0.0;
            stuck.uturn_attempted = false;
            handled += 1;
            continue;
        }

        // 1.5) If reroute failed and vehicle is still stuck, try reverse movement (GDD: max 10 km/h, 2-3 tiles)
        // This happens before U-turn attempt, as reverse is simpler and safer
        if v.path_cursor > 0 && v.reverse_distance < 2.5 {
            // Allow reverse movement - the move_vehicles system will handle it
            // Just reset stuck timer slightly to give reverse a chance
            stuck.secs = STUCK_REROUTE_SECS * 0.8; // Give some time for reverse to work
            handled += 1;
            continue;
        }

        // 2) Safety U-turn (doc open question #3): if we are at a dead end on a TwoLane (1+1),
        // try to pull into the adjacent oncoming lane tile and re-route from there.
        //
        // This is a conservative jam-recovery tactic, used only after re-routing fails, and only
        // once per stuck episode.
        if stuck.secs >= STUCK_REROUTE_SECS
            && !stuck.uturn_attempted
            && path_pool
                .remaining_from(v.path_handle, v.path_cursor)
                .map(|r| r.is_empty())
                .unwrap_or(true)
            && let Some(cur_cell) = grid.get(current)
            && cur_cell.road.is_some()
            && cur_cell.road.dir != RoadDir::None
        {
            let dir = cur_cell.road.dir;
            let front = TilePos {
                x: current.x + dir.delta().x,
                y: current.y + dir.delta().y,
            };
            let has_forward = grid.get(front).is_some_and(|c| {
                !c.water
                    && c.road.is_some()
                    && c.road.dir == dir
                    && c.road.kind == cur_cell.road.kind
            });

            if !has_forward
                && cur_cell.road.kind == RoadKind::TwoLane
                && let Some(off) = oncoming_lane_offset(&grid, current, dir)
            {
                let uturn_tile = TilePos {
                    x: current.x + off.x,
                    y: current.y + off.y,
                };

                let is_empty = grid.idx(uturn_tile).is_some_and(|idx| {
                    traffic.per_tick_vehicles.get(idx).copied().unwrap_or(0) == 0
                });
                if is_empty {
                    let from_uturn = find_road_path_cached(&mut ctx, uturn_tile, goal);
                    if !from_uturn.is_empty() {
                        let mut next_route = Vec::with_capacity(from_uturn.len() + 2);
                        next_route.push(current);
                        next_route.push(uturn_tile);
                        next_route.extend(from_uturn);

                        path_pool.release(v.path_handle);
                        v.path_handle = path_pool.intern(next_route);
                        v.path_cursor = 0;
                        v.progress = 0.0;
                        v.speed = 0.0;

                        stuck.secs = 0.0;
                        stuck.last_tile = current;
                        stuck.last_progress = 0.0;
                        stuck.uturn_attempted = false;
                        handled += 1;
                        continue;
                    }
                }
            }

            stuck.uturn_attempted = true;
        }

        // 3) Last-resort guardrail: despawn non-service trip vehicles after a very long time stuck.
        if stuck.secs >= STUCK_DESPAWN_SECS && service_vehicle.is_none() {
            if let Some(p) = passenger {
                finished.write(TripFinished {
                    citizen: p.citizen,
                    purpose: p.purpose,
                });
            }
            commands.entity(e).despawn();
            handled += 1;
        }
    }
}
