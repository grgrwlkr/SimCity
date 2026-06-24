use super::*;
use crate::game::transport::PathPool;

mod planning;
pub(super) use planning::{oncoming_lane_offset, plan_lane_changes};

/// Prevents frequent lane-change oscillations.
#[derive(Component, Debug, Clone, Copy)]
pub(super) struct LaneChangeCooldown {
    remaining_secs: f32,
}

/// Marker state to prefer staying left briefly while overtaking, then returning right.
#[derive(Component, Debug, Clone, Copy)]
pub(super) struct Overtaking {
    remaining_secs: f32,
}

/// Marker state for the "overtake oncoming lane" maneuver (TwoLane 1+1).
///
/// This is a **local tactic** (not part of routing). While present, we suppress normal lane-change
/// planning to avoid oscillations.
#[derive(Component, Debug, Clone, Copy)]
pub(super) struct OvertakeOncoming {
    remaining_secs: f32,
}

pub(super) fn tick_lane_change_cooldowns(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut LaneChangeCooldown)>,
) {
    let dt = time.delta_secs();
    for (e, mut cd) in q.iter_mut() {
        cd.remaining_secs -= dt;
        if cd.remaining_secs <= 0.0 {
            commands.entity(e).remove::<LaneChangeCooldown>();
        }
    }
}

pub(super) fn tick_overtaking(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut Overtaking)>,
) {
    let dt = time.delta_secs();
    for (e, mut ov) in q.iter_mut() {
        ov.remaining_secs -= dt;
        if ov.remaining_secs <= 0.0 {
            commands.entity(e).remove::<Overtaking>();
        }
    }
}

pub(super) fn tick_overtake_oncoming(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut OvertakeOncoming)>,
) {
    let dt = time.delta_secs();
    for (e, mut ov) in q.iter_mut() {
        ov.remaining_secs -= dt;
        if ov.remaining_secs <= 0.0 {
            commands.entity(e).remove::<OvertakeOncoming>();
        }
    }
}

fn route_has_near_intersection_n(route: &[TilePos], grid: &MapGrid, lookahead: usize) -> bool {
    for t in route.iter().skip(1).take(lookahead) {
        if let Some(c) = grid.get(*t)
            && c.road.is_some()
            && c.road.dir == RoadDir::None
        {
            return true;
        }
    }
    false
}

fn route_has_near_intersection(route: &[TilePos], grid: &MapGrid) -> bool {
    route_has_near_intersection_n(route, grid, LANE_CHANGE_INTERSECTION_LOOKAHEAD)
}

// (moved to `lane_change/planning.rs`)

pub(super) fn build_traffic_spatial_index_pre_lane_changes(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    path_pool: Res<PathPool>,
    q_vehicles: Query<(Entity, &Vehicle), Without<Parked>>,
    mut index: ResMut<TrafficSpatialIndex>,
) {
    index.rebuild(&cfg, &grid, &path_pool, &q_vehicles);
}

pub(super) fn build_traffic_spatial_index(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    path_pool: Res<PathPool>,
    q_vehicles: Query<(Entity, &Vehicle), Without<Parked>>,
    mut index: ResMut<TrafficSpatialIndex>,
) {
    index.rebuild(&cfg, &grid, &path_pool, &q_vehicles);
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn plan_oncoming_overtakes(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
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
        Query<(Entity, &mut Vehicle, Option<&mut VehicleLaneletPlan>), Without<Parked>>,
    )>,
) {
    #[derive(Copy, Clone)]
    struct Plan {
        e: Entity,
        offset: IVec2,
        pass_tiles: usize,
    }

    let mut plans = Vec::<Plan>::new();

    for (e, v, state, cooldown, overtaking, oncoming, service_vehicle) in vehicles.p0().iter() {
        if plans.len() >= MAX_ONCOMING_OVERTAKES_PER_TICK {
            break;
        }
        if cooldown.is_some() || overtaking.is_some() || oncoming.is_some() {
            continue;
        }
        if service_vehicle.is_some() {
            continue;
        }
        if v.path_cursor + 1 >= path_pool.len(v.path_handle) {
            continue;
        }

        // Never start close to intersections (safety).
        if let Some(route) = path_pool.remaining_from(v.path_handle, v.path_cursor)
            && route_has_near_intersection_n(route, &grid, ONCOMING_OVERTAKE_INTERSECTION_LOOKAHEAD)
        {
            continue;
        }

        // Do not start while stopped/waiting/approaching a stop line.
        if matches!(
            *state,
            VehicleTrafficState::Approaching { .. }
                | VehicleTrafficState::Stopped { .. }
                | VehicleTrafficState::WaitingForGreen { .. }
                | VehicleTrafficState::CrossingIntersection { .. }
        ) {
            continue;
        }

        let Some(ego_tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        let Some(ego_cell) = grid.get(ego_tile) else {
            continue;
        };
        if ego_cell.water || !ego_cell.road.is_some() || ego_cell.road.dir == RoadDir::None {
            continue;
        }
        let ego_road = ego_cell.road;
        if ego_road.kind != RoadKind::TwoLane {
            continue;
        }
        let dir = ego_road.dir;

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

        // Only attempt if we have a close, slow leader and we're not already near our desired speed.
        let Some((_lead_e, gap_tiles, lead_speed)) = spatial.leader_ahead_entity(
            &grid,
            &path_pool,
            e,
            ego_tile,
            v.progress,
            v.path_handle,
            v.path_cursor,
        ) else {
            continue;
        };
        if gap_tiles > OVERTAKE_LOOKAHEAD_TILES {
            continue;
        }
        if lead_speed >= v0 * OVERTAKE_LEADER_SPEED_RATIO {
            continue;
        }
        if v.speed >= v0 * 0.95 {
            continue;
        }

        // Determine the oncoming lane offset (perpendicular) at the current position.
        let Some(offset) = oncoming_lane_offset(&grid, ego_tile, dir) else {
            continue;
        };

        // Pick a short, conservative pass length based on the current gap.
        let pass_tiles = ((gap_tiles + 1.5_f32).ceil() as usize).clamp(
            ONCOMING_OVERTAKE_MIN_PASS_TILES,
            ONCOMING_OVERTAKE_MAX_PASS_TILES,
        );
        let Some(route) = path_pool.remaining_from(v.path_handle, v.path_cursor) else {
            continue;
        };
        if route.len() <= pass_tiles + 1 {
            continue;
        }

        // Validate straight TwoLane segment and matching oncoming tiles for the planned range.
        let mut ok = true;
        for base in route.iter().take(pass_tiles + 1) {
            let base = *base;
            let Some(c) = grid.get(base) else {
                ok = false;
                break;
            };
            if c.water || !c.road.is_some() || c.road.dir != dir || c.road.kind != RoadKind::TwoLane
            {
                ok = false;
                break;
            }

            let on = TilePos {
                x: base.x + offset.x,
                y: base.y + offset.y,
            };
            let Some(oc) = grid.get(on) else {
                ok = false;
                break;
            };
            if oc.water
                || !oc.road.is_some()
                || oc.road.dir != dir.opposite()
                || oc.road.kind != RoadKind::TwoLane
            {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }

        // Conservative safety: require the oncoming lane to be completely clear for a large distance.
        let fwd = dir.delta();
        for j in 0..ONCOMING_OVERTAKE_CLEAR_TILES {
            let t = TilePos {
                x: ego_tile.x + offset.x + fwd.x * j as i32,
                y: ego_tile.y + offset.y + fwd.y * j as i32,
            };
            let Some(c) = grid.get(t) else {
                ok = false;
                break;
            };
            if c.water || !c.road.is_some() || c.road.dir == RoadDir::None {
                ok = false;
                break;
            }
            if let Some(ti) = grid.idx(t)
                && spatial.tile_has_any(ti)
            {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }

        plans.push(Plan {
            e,
            offset,
            pass_tiles,
        });
    }

    // Apply route rewrites in a second pass to satisfy the borrow checker.
    let mut q_mut = vehicles.p1();
    for p in plans {
        let Ok((_ent, mut vv, mut vv_plan)) = q_mut.get_mut(p.e) else {
            continue;
        };

        // Pull out to oncoming lane, move forward for `pass_tiles`, return.
        let Some(current) = path_pool.get_tile(vv.path_handle, vv.path_cursor) else {
            continue;
        };
        let Some(rem) = path_pool.remaining_from(vv.path_handle, vv.path_cursor) else {
            continue;
        };
        let mut new_route = Vec::with_capacity(rem.len() + p.pass_tiles + 2);
        new_route.push(current);

        // Pull out to oncoming lane at current position.
        new_route.push(TilePos {
            x: current.x + p.offset.x,
            y: current.y + p.offset.y,
        });

        // Advance oncoming lane in parallel to the current route.
        for i in 1..=p.pass_tiles {
            let Some(&base) = rem.get(i) else {
                break;
            };
            new_route.push(TilePos {
                x: base.x + p.offset.x,
                y: base.y + p.offset.y,
            });
        }

        // Return to our lane at the same longitudinal position.
        if let Some(&return_base) = rem.get(p.pass_tiles) {
            new_route.push(return_base);
        }

        // Continue with the original route after the return tile.
        new_route.extend(rem.iter().copied().skip(p.pass_tiles + 1));
        path_pool.release(vv.path_handle);
        vv.path_handle = path_pool.intern(new_route);
        vv.path_cursor = 0;
        clear_lanelet_plan_on_reroute(vv_plan.as_deref_mut());

        commands.entity(p.e).insert(LaneChangeCooldown {
            remaining_secs: ONCOMING_OVERTAKE_COOLDOWN_SECS,
        });
        commands.entity(p.e).insert(OvertakeOncoming {
            remaining_secs: ONCOMING_OVERTAKE_COOLDOWN_SECS,
        });
    }
}
