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
    mut replan: LaneletReplanRes,
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
            Option<&mut VehicleLaneletPlan>,
            Option<&VehicleMotionTimer>,
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

    for (
        e,
        mut v,
        state,
        passenger,
        service_vehicle,
        mut stuck,
        swap_deadlocked,
        mut lanelet_plan,
        motion,
    ) in q.iter_mut()
    {
        if handled >= MAX_UNSTUCK_PER_TICK {
            break;
        }
        // "Wedged" = continuously stopped (by actual speed, never reset by state) far longer than any
        // legitimate light cycle. `StuckTimer.secs` is reset to 0 every tick while WaitingForGreen /
        // Stopped (so a vehicle genuinely waiting at a red doesn't reroute), but that same reset hides
        // a vehicle that is PERMANENTLY wedged in those states — recovery never fires and it becomes a
        // forever-blocker that cascades into gridlock. The motion timer (Without state-based resets)
        // is the authority for "this is not a normal wait, get it moving (reroute) or, last resort,
        // despawn". Threshold = the reroute timeout, well past the ~34 s max signal cycle.
        let wedged = motion.is_some_and(|m| m.stopped_secs >= STUCK_REROUTE_SECS);
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
        // A legitimately-waiting vehicle is skipped — UNLESS it has been wedged far past any light
        // cycle, in which case it is not really waiting, it is stuck and must be rerouted/cleared.
        if matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        ) && !wedged
        {
            continue;
        }
        if stuck.secs < STUCK_REROUTE_SECS && !wedged {
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
            let travel_dir = grid.get(current).map_or(RoadDir::None, |c| c.road.dir);
            let jitter_seed = replan.jitter_seed();
            let lanelet_route = replan_route_with_lanelets(
                &replan.lane_graph,
                &replan.lanelet_graph,
                &grid,
                &traffic,
                &path_cfg,
                jitter_seed,
                current,
                goal,
                travel_dir,
            );
            path_pool.release(v.path_handle);
            match lanelet_route {
                Some((tiles, sidecar)) => {
                    v.path_handle = path_pool.intern(tiles);
                    if let Some(plan) = lanelet_plan.as_deref_mut() {
                        plan.entries = sidecar;
                    }
                }
                None => {
                    v.path_handle = path_pool.intern(route);
                    clear_lanelet_plan_on_reroute(lanelet_plan.as_deref_mut());
                }
            }
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
        // This happens before U-turn attempt, as reverse is simpler and safer.
        // NOT for a wedged vehicle: pinning stuck.secs back to 48 s every tick is exactly what made the
        // 180 s despawn guardrail unreachable (the car reverses 0 tiles because it is boxed in, so this
        // branch fires forever). A wedged car falls through to the despawn last resort instead.
        if v.path_cursor > 0 && v.reverse_distance < 2.5 && !wedged {
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

                        let travel_dir = cur_cell.road.dir;
                        let jitter_seed = replan.jitter_seed();
                        let lanelet_route = replan_route_with_lanelets(
                            &replan.lane_graph,
                            &replan.lanelet_graph,
                            &grid,
                            &traffic,
                            &path_cfg,
                            jitter_seed,
                            current,
                            goal,
                            travel_dir,
                        );
                        path_pool.release(v.path_handle);
                        match lanelet_route {
                            Some((tiles, sidecar)) => {
                                v.path_handle = path_pool.intern(tiles);
                                if let Some(plan) = lanelet_plan.as_deref_mut() {
                                    plan.entries = sidecar;
                                }
                            }
                            None => {
                                v.path_handle = path_pool.intern(next_route);
                                clear_lanelet_plan_on_reroute(lanelet_plan.as_deref_mut());
                            }
                        }
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
        // Trigger on EITHER the state-resettable timer OR the never-reset motion timer, so a vehicle
        // wedged in WaitingForGreen/Stopped (where stuck.secs is pinned/reset) can still be cleared
        // once it has been physically motionless past the despawn horizon — the guardrail was dead
        // code for exactly that population before.
        let motion_despawn = motion.is_some_and(|m| m.stopped_secs >= STUCK_DESPAWN_SECS);
        if (stuck.secs >= STUCK_DESPAWN_SECS || motion_despawn) && service_vehicle.is_none() {
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

/// Recover a *Returning* service vehicle that is hopelessly stuck.
///
/// A service vehicle is never despawned by the guardrail above (that would leak its station's
/// `available_vehicles` count), and rerouting only loops it back into the same jam — so a wedged one
/// blocks a road lane forever. Observed live: Returning service vehicles pinned at the oversized
/// intersection approach (where a lane-change tile-swap can't be deferred because the forward tile is
/// the cluster), permanently choking the corridor while passenger cars churn behind them.
///
/// Fix: consume the remaining route so `park_returned_service_vehicles` snaps it to its home station
/// next tick — the exact same safe path as a normally-completed return (restores the station count).
/// Only triggers for the `Returning` state, so a vehicle mid-mission (EnRoute/OnScene) is never
/// teleported away.
pub(super) fn recover_stuck_returning_service_vehicles(
    path_pool: Res<super::super::transport::PathPool>,
    mut q: Query<(&ServiceVehicle, &mut Vehicle, &StuckTimer), Without<Parked>>,
) {
    for (sv, mut v, stuck) in &mut q {
        if sv.state == ServiceVehicleState::Returning && stuck.secs >= STUCK_REROUTE_SECS {
            v.path_cursor = path_pool.len(v.path_handle);
            v.speed = 0.0;
        }
    }
}
