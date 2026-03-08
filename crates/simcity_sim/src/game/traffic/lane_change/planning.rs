use super::*;
use crate::game::transport::{PathHandle, PathPool};

fn lane_change_target(grid: &MapGrid, current: TilePos, move_dir: RoadDir) -> Option<TilePos> {
    let cur_cell = grid.get(current)?;
    if cur_cell.water || !cur_cell.road.is_some() || cur_cell.road.dir == RoadDir::None {
        return None;
    }

    let delta = move_dir.delta();
    let target = TilePos {
        x: current.x + delta.x,
        y: current.y + delta.y,
    };
    let next_cell = grid.get(target)?;
    if next_cell.water || !next_cell.road.is_some() {
        return None;
    }

    let cur = cur_cell.road;
    let next = next_cell.road;

    if next.dir != cur.dir {
        return None;
    }
    if next.kind != cur.kind || next.lanes_total() != cur.lanes_total() {
        return None;
    }
    if next.lane.abs_diff(cur.lane) != 1 {
        return None;
    }

    Some(target)
}

pub(in super::super) fn oncoming_lane_offset(
    grid: &MapGrid,
    current: TilePos,
    travel_dir: RoadDir,
) -> Option<IVec2> {
    let cur_cell = grid.get(current)?;
    if cur_cell.water || !cur_cell.road.is_some() || cur_cell.road.dir == RoadDir::None {
        return None;
    }
    let cur = cur_cell.road;
    if cur.kind != RoadKind::TwoLane {
        return None;
    }

    // Oncoming lane is one tile to the left or right (perpendicular), same road kind/lane count,
    // adjacent lane index, and opposite `dir`.
    for side in [travel_dir.left(), travel_dir.right()] {
        let d = side.delta();
        let t = TilePos {
            x: current.x + d.x,
            y: current.y + d.y,
        };
        let Some(cell) = grid.get(t) else {
            continue;
        };
        if cell.water || !cell.road.is_some() || cell.road.dir == RoadDir::None {
            continue;
        }
        let next = cell.road;
        if next.kind != cur.kind || next.lanes_total() != cur.lanes_total() {
            continue;
        }
        if next.lane.abs_diff(cur.lane) != 1 {
            continue;
        }
        if next.dir != travel_dir.opposite() {
            continue;
        }
        return Some(d);
    }

    None
}

fn lane_change_safe_progress(
    target: TilePos,
    ego_progress: f32,
    grid: &MapGrid,
    spatial: &TrafficSpatialIndex,
    reserved: &std::collections::HashMap<TilePos, Vec<f32>>,
    min_gap_progress: f32,
) -> bool {
    if let Some(ti) = grid.idx(target)
        && spatial.tile_has_progress_within(ti, ego_progress, min_gap_progress)
    {
        return false;
    }
    if let Some(list) = reserved.get(&target) {
        for p in list.iter().copied() {
            if (p - ego_progress).abs() < min_gap_progress {
                return false;
            }
        }
    }
    true
}

fn find_leader_ahead(
    ego: (TilePos, f32),
    path_pool: &PathPool,
    path_handle: PathHandle,
    path_cursor: usize,
    grid: &MapGrid,
    spatial: &TrafficSpatialIndex,
) -> Option<(f32, f32)> {
    let (tile, progress) = ego;
    spatial.leader_ahead(grid, path_pool, tile, progress, path_handle, path_cursor)
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(in super::super) fn plan_lane_changes(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    intersections: Res<IntersectionIndex>,
    traffic_cfg: Res<TrafficConfig>,
    spatial: Res<TrafficSpatialIndex>,
    mut path_pool: ResMut<PathPool>,
    mut commands: Commands,
    mut vehicles: ParamSet<(
        Query<
            (
                Entity,
                &Vehicle,
                &VehicleTrafficState,
                Option<&LaneChangeCooldown>,
                Option<&Overtaking>,
                Option<&OvertakeOncoming>,
                Option<&ServiceVehicle>,
            ),
            Without<Parked>,
        >,
        Query<(Entity, &mut Vehicle), Without<Parked>>,
    )>,
    mut reserved: Local<std::collections::HashMap<TilePos, Vec<f32>>>,
) {
    let idm = idm_params_world(&cfg, &traffic_cfg);
    let min_gap_progress = (idm.s0 / cfg.tile_size.max(0.1)).clamp(0.12, 0.45);

    // A small "reservation" map to avoid multiple vehicles committing into the same
    // target lane position range in a single tick.
    reserved.clear();

    // Collect desires first (so we can prioritize), then apply with a guardrail limit.
    #[derive(Debug)]
    struct Desire {
        e: Entity,
        target: TilePos,
        priority: u8,
        ego_tile: TilePos,
        ego_progress: f32,
        goal: TilePos,
    }
    let mut desires = Vec::<Desire>::new();

    for (e, v, state, cooldown, overtaking, oncoming, service_vehicle) in vehicles.p0().iter() {
        if cooldown.is_some() {
            continue;
        }
        if oncoming.is_some() {
            continue;
        }
        if service_vehicle.is_some() {
            continue;
        }
        if v.path_cursor + 1 >= path_pool.len(v.path_handle) {
            continue;
        }

        // Don't lane change inside/near intersections.
        let Some(ego_tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };

        // CRITICAL: Never allow lane changes ON intersection tiles
        if let Some(ego_cell) = grid.get(ego_tile)
            && ego_cell.road.is_some()
            && ego_cell.road.dir == RoadDir::None
        {
            continue; // Currently on intersection tile - no lane changes!
        }

        // CRITICAL: Fix lane 2-3 tiles before intersection (no lane changes when approaching)
        // This ensures vehicles are in correct lane for their maneuver before entering intersection
        if let Some(route) = path_pool.remaining_from(v.path_handle, v.path_cursor) {
            // Check if intersection is within 3 tiles
            let tiles_to_intersection = route
                .iter()
                .skip(1)
                .take(4) // Check next 3 tiles + current
                .position(|&t| {
                    grid.get(t)
                        .is_some_and(|c| c.road.is_some() && c.road.dir == RoadDir::None)
                });

            if let Some(dist) = tiles_to_intersection
                && dist <= 3
            {
                // Too close to intersection - lane is locked!
                continue;
            }

            if route_has_near_intersection(route, &grid) {
                continue;
            }
        }
        let Some(ego_cell) = grid.get(ego_tile) else {
            continue;
        };
        if ego_cell.water || !ego_cell.road.is_some() || ego_cell.road.dir == RoadDir::None {
            continue;
        }

        // Do not change lanes while stopped/waiting/approaching a stop line.
        if matches!(
            *state,
            VehicleTrafficState::Approaching { .. }
                | VehicleTrafficState::Stopped { .. }
                | VehicleTrafficState::WaitingForGreen { .. }
                | VehicleTrafficState::CrossingIntersection { .. }
        ) {
            continue;
        }

        let dir = ego_cell.road.dir;
        let goal = path_pool
            .get_tile(
                v.path_handle,
                path_pool.len(v.path_handle).saturating_sub(1),
            )
            .unwrap_or(ego_tile);
        if goal == ego_tile {
            continue;
        }

        let profile_factor = if v.speed_factor.is_finite() {
            v.speed_factor
                .clamp(DRIVER_PROFILE_FACTOR_MIN, DRIVER_PROFILE_FACTOR_MAX)
        } else {
            DRIVER_PROFILE_MEDIUM_FACTOR
        };
        let v0 = (road_speed_limit_world(&cfg, &traffic_cfg, ego_tile, &grid) * profile_factor)
            .min(v.max_speed)
            .max(0.0);
        if v0 <= 0.0 {
            continue;
        }

        // Candidate adjacent lanes.
        let left_target = lane_change_target(&grid, ego_tile, dir.left());
        let right_target = lane_change_target(&grid, ego_tile, dir.right());

        // Leader heuristics (for overtake decision).
        let leader = find_leader_ahead(
            (ego_tile, v.progress),
            &path_pool,
            v.path_handle,
            v.path_cursor,
            &grid,
            &spatial,
        );

        let mut want_left = false;
        let mut want_right = false;

        // Overtake: move left if a slow leader is close.
        if let (Some(_lt), Some((gap_tiles, lead_speed))) = (left_target, leader)
            && gap_tiles <= OVERTAKE_LOOKAHEAD_TILES
            && lead_speed < v0 * OVERTAKE_LEADER_SPEED_RATIO
            && v.speed < v0 * 0.95
        {
            want_left = true;
        }

        // Return right after overtaking, or lane preference when cruising:
        // - Fast vehicles (high speed_factor) prefer left lanes.
        // - Slow vehicles (low speed_factor) keep right.
        if right_target.is_some() || left_target.is_some() {
            if let Some(ov) = overtaking {
                // If we're overtaking but not currently blocked, start returning right in the second half.
                if ov.remaining_secs <= (OVERTAKE_HOLD_SECS * 0.5)
                    && leader.is_none_or(|(_, lead_v)| lead_v >= v0 * 0.95)
                {
                    want_right = true;
                }
            } else if leader.is_none_or(|(_, lead_v)| lead_v >= v0 * 0.95) {
                // Cruising: speed-dependent lane preference.
                if profile_factor > KEEP_RIGHT_SPEED_THRESHOLD {
                    // Fast drivers prefer left (passing) lane.
                    want_left = true;
                } else {
                    // Slow drivers keep right.
                    want_right = true;
                }
            }
        }

        // Build a desire (priority: overtake-left > return-right > prefer-left > keep-right).
        if want_left {
            if let Some(target) = left_target {
                // CRITICAL: Never allow lane change target to be on intersection tile
                if let Some(target_cell) = grid.get(target) {
                    if target_cell.road.is_some() && target_cell.road.dir == RoadDir::None {
                        // Target is on intersection - skip this lane change
                    } else if let Some(target) = left_target {
                        let priority = if overtaking.is_some() { 2 } else { 1 };
                        desires.push(Desire {
                            e,
                            target,
                            priority,
                            ego_tile,
                            ego_progress: v.progress,
                            goal,
                        });
                    }
                }
            }
        } else if want_right && let Some(target) = right_target {
            // CRITICAL: Never allow lane change target to be on intersection tile
            if let Some(target_cell) = grid.get(target) {
                if target_cell.road.is_some() && target_cell.road.dir == RoadDir::None {
                    // Target is on intersection - skip this lane change
                } else {
                    desires.push(Desire {
                        e,
                        target,
                        priority: if overtaking.is_some() { 1 } else { 0 },
                        ego_tile,
                        ego_progress: v.progress,
                        goal,
                    });
                }
            }
        }
    }

    // Highest priority first (stable tie-breaker by entity id).
    desires.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.e.to_bits().cmp(&b.e.to_bits()))
    });

    let mut done = 0usize;
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

    for d in desires {
        if done >= MAX_LANE_CHANGES_PER_TICK {
            break;
        }

        // Capacity check (coarse).
        if let Some(ti) = grid.idx(d.target)
            && let Some(cell) = grid.get(d.target)
            && cell.road.is_some()
            && ti < traffic.per_tick_vehicles.len()
        {
            let cap = cell.road.kind.capacity_per_lane_tile();
            if traffic.per_tick_vehicles[ti] >= cap {
                continue;
            }
        } else {
            continue;
        }

        // Safe gap check (fine-ish, based on progress ranges).
        if !lane_change_safe_progress(
            d.target,
            d.ego_progress,
            &grid,
            &spatial,
            &reserved,
            min_gap_progress,
        ) {
            continue;
        }

        // Re-route from the target lane to the goal, then prepend current tile as the lane-change step.
        let current = d.ego_tile;
        let goal = d.goal;
        let route_from_target = find_road_path_cached(&mut ctx, d.target, goal);
        if route_from_target.is_empty() {
            continue;
        }
        if route_from_target.get(1).copied() == Some(current) {
            // Avoid immediate ping-pong.
            continue;
        }

        // Update vehicle route for lane change
        if let Ok((_e, mut v)) = vehicles.p1().get_mut(d.e) {
            // Keep current tile; insert lane-change as the first step.
            let mut new_route = Vec::with_capacity(route_from_target.len() + 1);
            new_route.push(current);
            new_route.extend(route_from_target);
            // Release old path and intern new one
            path_pool.release(v.path_handle);
            v.path_handle = path_pool.intern(new_route);
            v.path_cursor = 0;
        } else {
            continue;
        }

        // Reserve this position on the target tile to avoid same-tick overlaps.
        reserved.entry(d.target).or_default().push(d.ego_progress);

        // Apply cooldown + overtake marker if we moved left.
        commands.entity(d.e).insert(LaneChangeCooldown {
            remaining_secs: LANE_CHANGE_COOLDOWN_SECS,
        });
        if d.priority >= 2 {
            commands.entity(d.e).insert(Overtaking {
                remaining_secs: OVERTAKE_HOLD_SECS,
            });
        }

        done += 1;
    }
}
