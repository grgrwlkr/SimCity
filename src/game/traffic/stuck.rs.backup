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
            Option<&BusVehicle>,
            &mut StuckTimer,
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
    };

    for (e, mut v, state, passenger, service_vehicle, bus_vehicle, mut stuck) in q.iter_mut() {
        if handled >= MAX_UNSTUCK_PER_TICK {
            break;
        }
        if v.path_cursor >= path_pool.len(v.path_handle) {
            stuck.secs = 0.0;
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
        let goal = path_pool.get_tile(v.path_handle, path_pool.len(v.path_handle).saturating_sub(1)).unwrap_or(current);

        // 1) Emergency re-route: try to find an alternative path to the same goal.
        let route = find_road_path_cached(&mut ctx, current, goal);
        if !route.is_empty() {
            let old_route = path_pool.remaining_from(v.path_handle, v.path_cursor);
            if route != old_route {
                path_pool.release(v.path_handle);
                v.path_handle = path_pool.intern(route);
                v.path_cursor = 0;
            v.progress = 0.0;
            v.speed = v.speed.min(v.max_speed * 0.5);

            stuck.secs = 0.0;
            stuck.last_tile = current;
            stuck.last_progress = 0.0;
            stuck.uturn_attempted = false;
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
            && path_pool.remaining_from(v.path_handle, v.path_cursor).is_empty()
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
                        let mut next_route = Vec::with_capacity(from_uturn.len() + 1);
                        next_route.push(current);
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
        if stuck.secs >= STUCK_DESPAWN_SECS
            && service_vehicle.is_none()
            && bus_vehicle.is_none()
            && passenger.is_some()
        {
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
