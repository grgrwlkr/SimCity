use super::swap_break::SwapDeadlocked;
use super::*;

/// Per-vehicle jam detector (in fixed-time seconds).
#[derive(Component, Debug, Clone, Copy)]
pub(crate) struct StuckTimer {
    pub(crate) secs: f32,
    pub(crate) last_tile: TilePos,
    pub(crate) last_progress: f32,
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
            handled += 1;
            continue;
        }

        // 1.5) If reroute failed and vehicle is still stuck, try reverse movement (GDD: max 10 km/h, 2-3 tiles)
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

        // 2) Last-resort guardrail: despawn non-service trip vehicles after a very long time stuck.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow};
    use crate::game::transport::{PathCache, PathPool, RegionGraph, RoadGraph};

    fn put_road(grid: &mut MapGrid, pos: TilePos, dir: RoadDir) {
        let mut cell = grid.get(pos).unwrap_or_default();
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    /// INVARIANT: stuck-recovery must never flip a vehicle onto an oncoming
    /// (opposing-direction) tile. U-turns are only legal through an intersection
    /// center lanelet (the arbiter path).
    ///
    /// RED (pre-fix): `resolve_stuck_vehicles` had a "safety U-turn" block that, for a
    /// dead-end TwoLane vehicle with no lanelet route, built `next_route = [current,
    /// uturn_tile, ..]` where `uturn_tile` is the adjacent *oncoming-direction* tile, and
    /// (since the lanelet replan returned `None`) interned that raw oncoming route into the
    /// PathPool — a non-center U-turn onto oncoming traffic. A car set up like the one below
    /// would end up with the oncoming tile (2,3) in its interned route.
    ///
    /// GREEN (post-fix): that block is deleted. A genuinely dead-end car finds no reroute,
    /// is not eligible for reverse (cursor==0), and simply holds its route (or, past the
    /// 180 s horizon, despawns). It is never flipped onto oncoming. We assert no tile in its
    /// resulting route has `road.dir == travel_dir.opposite()`.
    #[test]
    fn stuck_recovery_never_interns_oncoming_route() {
        // 5x5 grid. current=(2,2) heading East; forward (3,2) is NON-road -> dead end.
        // Oncoming lane (2,3) heads West (= East.opposite()), and is empty.
        let mut grid = MapGrid::new(5, 5);
        let current = TilePos { x: 2, y: 2 };
        let oncoming = TilePos { x: 2, y: 3 };
        put_road(&mut grid, current, RoadDir::East);
        put_road(&mut grid, oncoming, RoadDir::West);

        let travel_dir = RoadDir::East;
        let opp = travel_dir.opposite();
        assert_eq!(grid.get(oncoming).unwrap().road.dir, opp);

        let mut app = App::new();

        let mut path_pool = PathPool::default();
        let handle = path_pool.intern(vec![current]);

        app.insert_resource(Time::<Fixed>::from_seconds(0.1));
        app.insert_resource(MapConfig::default());
        app.insert_resource(grid);
        app.insert_resource(RoadGraph::default()); // empty -> road A* reroute fails
        app.insert_resource(RegionGraph::default());
        app.insert_resource(TrafficOccupancy::default());
        app.insert_resource(PathfindingConfig::default());
        app.insert_resource(PathCache::default());
        app.insert_resource(path_pool);
        app.insert_resource(IntersectionIndex::default());
        // LaneletReplanRes deps (empty -> replan_route_with_lanelets returns None):
        app.insert_resource(TrafficConfig::default());
        app.insert_resource(crate::game::transport::LaneGraph::default());
        app.insert_resource(crate::game::transport::LaneletGraph::default());
        app.insert_resource(crate::game::sim::SimRng::default());
        app.init_resource::<bevy::ecs::message::Messages<TripFinished>>();

        // Stuck past the reroute threshold (recovery fires) but UNDER the 180 s despawn
        // horizon, and not "wedged" (no motion timer), so the vehicle survives and we can
        // inspect its route. cursor==0 keeps it out of the reverse branch too.
        let vehicle = Vehicle {
            path_handle: handle,
            path_cursor: 0,
            tile_pos: current,
            ..Default::default()
        };
        let entity = app
            .world_mut()
            .spawn((
                vehicle,
                VehicleTrafficState::FreeFlow,
                StuckTimer {
                    secs: STUCK_REROUTE_SECS + 1.0,
                    last_tile: current,
                    last_progress: 0.0,
                },
            ))
            .id();

        app.add_systems(Update, resolve_stuck_vehicles);
        app.update();

        // Vehicle must still exist (not despawned at this timer level) ...
        assert!(
            app.world().get_entity(entity).is_ok(),
            "vehicle should survive (under despawn horizon), not be flipped or removed"
        );

        // ... and its entire interned route must contain NO oncoming-direction tile.
        let pool = app.world().resource::<PathPool>();
        let v = app.world().get::<Vehicle>(entity).unwrap();
        let len = pool.len(v.path_handle);
        let grid = app.world().resource::<MapGrid>();
        for i in 0..len {
            let tile = pool.get_tile(v.path_handle, i).unwrap();
            let dir = grid.get(tile).map_or(RoadDir::None, |c| c.road.dir);
            assert_ne!(
                dir, opp,
                "stuck recovery interned an oncoming-direction tile {tile:?} (dir {dir:?}) \
                 — U-turns must only go through the center lanelet"
            );
            assert_ne!(
                tile, oncoming,
                "stuck recovery flipped vehicle onto the oncoming tile {oncoming:?}"
            );
        }
    }
}
