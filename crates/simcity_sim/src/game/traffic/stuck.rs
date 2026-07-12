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
            Option<&crate::game::public_transport::Bus>,
            &mut StuckTimer,
            Option<&SwapDeadlocked>,
            Option<&mut VehicleLaneletPlan>,
            Option<&VehicleMotionTimer>,
        ),
        Without<Parked>,
    >,
) {
    let mut handled = 0usize;
    let dt = time.delta_secs();

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

    for (
        e,
        mut v,
        state,
        passenger,
        service_vehicle,
        bus,
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
        let stopped_secs = motion.map(|m| m.stopped_secs).unwrap_or(0.0);
        let wedged = stopped_secs >= STUCK_REROUTE_SECS;
        // Rate-limit wedged reroute ATTEMPTS to one per retry window. Un-limited, a wedged vehicle
        // replans EVERY tick: per-trip jitter makes each replan "differ", so the route (and the
        // vehicle's cursor/progress) is reset every tick — the churn itself pins the car in place,
        // floods the path pool (observed live: 56k stuck-interns in ~20 min) and starves recovery.
        // Stateless window: fires on the tick where the continuously-stopped clock crosses a
        // multiple of the retry period. The despawn guardrail below stays on the raw timers.
        let wedged_retry_due = wedged
            && (stopped_secs - STUCK_REROUTE_SECS).rem_euclid(WEDGED_REROUTE_RETRY_SECS) < dt;
        let motion_despawn = stopped_secs >= STUCK_DESPAWN_SECS;
        // The motion arm exists to reach the despawn guardrail below — but a service vehicle is
        // exempt from that guardrail (despawning would leak its station's available_vehicles), so
        // for it the arm would only open a PER-TICK replan lane, bypassing the wedged throttle
        // above (the exact churn it prevents). Service vehicles stay on the throttled window.
        let recovery_due =
            wedged_retry_due || (motion_despawn && service_vehicle.is_none() && bus.is_none());
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
            && bus.is_none()
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
        ) && !recovery_due
        {
            continue;
        }
        if stuck.secs < STUCK_REROUTE_SECS && !recovery_due {
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

        // 1) Emergency re-route: try lanelet replan first (finer-grained, direction-correct),
        //    then fall back to coarse road A*. Only count it as a real unstick (reset the timer
        //    + restart the path) when the route ACTUALLY changes.
        //
        //    Gap fixed: previously the lanelet replan was gated behind the road-A* check and was
        //    never attempted when road A* returned empty or the same route. Now we always try
        //    lanelet replan; road A* is only used as a fallback tile route when lanelet returns None.
        //    If the only path found is the same blocked one, do NOT reset stuck.secs — let it keep
        //    climbing so the despawn guardrail can eventually fire instead of resetting the timer
        //    forever (the bug that left deadlocked cars frozen indefinitely).
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
        let mut route = find_road_path_cached(&mut ctx, current, goal);
        if route.is_empty() && wedged_retry_due && ctx.regions.is_some() {
            // The hierarchical region pre-pass prunes A* to a corridor around the region-level
            // start->goal path; a recovery route that must DETOUR far outside it (e.g. via a
            // dead-end spur's U-turn) is invisible to the pruned search (observed live: pruned
            // len=0 vs unpruned len=104 for a wedged bus). Retry unpruned — but ONLY inside the
            // throttled wedged-retry window: the per-tick nudge path must never pay full-map A*
            // (that churn class is exactly what the throttle above exists to prevent).
            let saved = ctx.regions.take();
            route = find_road_path_cached(&mut ctx, current, goal);
            ctx.regions = saved;
        }
        // Direction guard (insurance): road-A* is structurally dir-correct, but the interned
        // fallback must satisfy the same invariant as every other producer.
        let route = if route_direction_ok(&route, &grid) {
            route
        } else {
            replan.producer_stats.guard_refusals += 1;
            Vec::new()
        };
        let road_changed = !route.is_empty()
            && Some(route.as_slice()) != path_pool.remaining_from(v.path_handle, v.path_cursor);
        let lanelet_changed = lanelet_route.as_ref().is_some_and(|(tiles, _)| {
            Some(tiles.as_slice()) != path_pool.remaining_from(v.path_handle, v.path_cursor)
        });
        if road_changed || lanelet_changed {
            path_pool.release(v.path_handle);
            match lanelet_route {
                Some((tiles, sidecar)) => {
                    replan.producer_stats.stuck_lanelet += 1;
                    v.path_handle = path_pool.intern(tiles);
                    if let Some(plan) = lanelet_plan.as_deref_mut() {
                        plan.entries = sidecar;
                    }
                }
                None => {
                    replan.producer_stats.stuck_road_fallback += 1;
                    v.path_handle = path_pool.intern(route);
                    clear_lanelet_plan_on_reroute(lanelet_plan.as_deref_mut());
                }
            }
            v.path_cursor = 0;
            v.progress = 0.0;
            v.speed = v.speed.min(v.max_speed * 0.5);
            // Reset reverse state after reroute
            v.is_reversing = false;

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
        if v.path_cursor > 0 && !wedged {
            // Allow reverse movement - the move_vehicles system will handle it
            // Just reset stuck timer slightly to give reverse a chance
            stuck.secs = STUCK_REROUTE_SECS * 0.8; // Give some time for reverse to work
            handled += 1;
            continue;
        }

        // 2) Last-resort guardrail (TRUE last resort, AFTER reroute + reverse both failed to move
        // the car). Despawn non-service trip vehicles only once they are genuinely wedged with no
        // escape: reroute found no differing route, reverse couldn't back out. Trigger on EITHER the
        // state-resettable path timer OR the never-reset motion timer, so a vehicle wedged in
        // WaitingForGreen/Stopped (where `stuck.secs` is pinned/reset) can still be cleared once it
        // has been physically motionless past the despawn horizon.
        //
        // NOT hoisted above the reroute branch: with the clear-the-box exemption (drive.rs box→exit
        // gate) a car can ALWAYS step out of an intersection, so it no longer wedges Inside on
        // congestion — only a genuine permanent dead-end reaches here. Hoisting the motion arm made
        // this fire routinely on ordinary congestion-stopped cars (they vanished mid-jam); placing
        // it after reroute/reverse restores it to the band-aid-of-last-resort it should be.
        if (stuck.secs >= STUCK_DESPAWN_SECS || motion_despawn)
            && service_vehicle.is_none()
            && bus.is_none()
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
    use crate::game::roads::{LaneType, RoadCell, RoadFlow, RoadKind};
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
        app.init_resource::<RouteProducerStats>();
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

    /// (REVERTED) A wedged car that has a DIFFERING reroute available is REROUTED, not despawned.
    ///
    /// History: the motion-despawn was briefly HOISTED above the reroute branch (commit after
    /// 40d923e) so that a wedged car despawned BEFORE reroute could reset its timer. That hoist made
    /// the despawn fire routinely on ordinary congestion-stopped cars → cars vanished mid-jam (the
    /// live "cars disappear" symptom). With the clear-the-box exemption (drive.rs box→exit gate) a
    /// car can ALWAYS step out of an intersection, so the Inside-box wedge no longer forms and the
    /// aggressive despawn is no longer needed. The hoist is reverted: the despawn is once again a
    /// TRUE last resort AFTER reroute + reverse.
    ///
    /// So: a car wedged on the motion timer that STILL has a differing road-A* route must take that
    /// reroute (the escape) — NOT despawn. Despawn only fires when there is genuinely no escape.
    #[test]
    fn wedged_car_with_a_differing_reroute_is_rerouted_not_despawned() {
        use crate::game::traffic::components::VehicleMotionTimer;
        use crate::game::transport::{GraphVersion, rebuild_road_graph_inner};

        // Straight East corridor (0,0)->(3,0): road A* will find the full 4-tile path.
        let mut grid = MapGrid::new(5, 5);
        let start = TilePos { x: 0, y: 0 };
        let goal = TilePos { x: 3, y: 0 };
        for x in 0..4 {
            put_road(&mut grid, TilePos { x, y: 0 }, RoadDir::East);
        }

        let mut graph = RoadGraph::default();
        let gv = GraphVersion(1);
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let mut app = App::new();
        let mut path_pool = PathPool::default();
        // Interned route is the DEGENERATE 2-tile [start, goal]; road A* returns the real
        // [(0,0),(1,0),(2,0),(3,0)] which DIFFERS -> `road_changed` is true (reroute is available).
        let handle = path_pool.intern(vec![start, goal]);

        app.insert_resource(Time::<Fixed>::from_seconds(0.1));
        app.insert_resource(MapConfig::default());
        app.insert_resource(grid);
        app.insert_resource(graph);
        app.insert_resource(RegionGraph::default());
        app.insert_resource(TrafficOccupancy::default());
        app.insert_resource(PathfindingConfig::default());
        app.insert_resource(PathCache::default());
        app.insert_resource(path_pool);
        app.insert_resource(IntersectionIndex::default());
        app.insert_resource(TrafficConfig::default());
        app.insert_resource(crate::game::transport::LaneGraph::default());
        app.insert_resource(crate::game::transport::LaneletGraph::default());
        app.insert_resource(crate::game::sim::SimRng::default());
        app.init_resource::<RouteProducerStats>();
        app.init_resource::<bevy::ecs::message::Messages<TripFinished>>();

        let vehicle = Vehicle {
            path_handle: handle,
            path_cursor: 0,
            tile_pos: start,
            ..Default::default()
        };
        let entity = app
            .world_mut()
            .spawn((
                vehicle,
                VehicleTrafficState::FreeFlow,
                StuckTimer {
                    secs: 0.0, // NOT past the path-timer horizon: only the motion timer is.
                    last_tile: start,
                    last_progress: 0.0,
                },
                // Wedged past the despawn horizon on the never-reset motion timer.
                VehicleMotionTimer {
                    moving_secs: 0.0,
                    anchor_pos: bevy::prelude::Vec2::ZERO,
                    stopped_secs: STUCK_DESPAWN_SECS + 1.0,
                },
            ))
            .id();

        app.add_systems(Update, resolve_stuck_vehicles);
        app.update();

        // Sanity: a differing road-A* route really is available (so the reroute branch fires first).
        let mut ctx_cache = app.world_mut().remove_resource::<PathCache>().unwrap();
        let route = {
            let graph = app.world().resource::<RoadGraph>();
            let regions = app.world().resource::<RegionGraph>();
            let traffic = app.world().resource::<TrafficOccupancy>();
            let cfg = app.world().resource::<PathfindingConfig>();
            let grid = app.world().resource::<MapGrid>();
            let intersections = app.world().resource::<IntersectionIndex>();
            let mut ctx = PathfindingCtx {
                time_now_sec: 0.0,
                cfg,
                cache: &mut ctx_cache,
                graph,
                regions: Some(regions),
                traffic,
                grid,
                intersections,
            };
            find_road_path_cached(&mut ctx, start, goal)
        };
        app.insert_resource(ctx_cache);
        assert!(
            route.len() > 2,
            "precondition: road A* must return a multi-tile route that DIFFERS from the interned \
             [start, goal] (so a reroute is genuinely available); got {route:?}"
        );

        // The wedged car must SURVIVE (it was rerouted onto the escape), NOT be despawned. The
        // reroute reset its timer and restarted its path.
        assert!(
            app.world().get_entity(entity).is_ok(),
            "a wedged car with a differing reroute available must be rerouted onto the escape, not \
             despawned — despawn is the last resort only when there is no escape"
        );
        let v = app.world().get::<Vehicle>(entity).unwrap();
        assert_eq!(v.path_cursor, 0, "reroute restarts the path at cursor 0");
        let pool = app.world().resource::<PathPool>();
        assert!(
            pool.len(v.path_handle) > 2,
            "reroute must have replaced the degenerate [start, goal] route with the full A* route"
        );
    }

    /// (FIX 2) A car merely STOPPED in congestion — with a valid route, just a busy downstream — must
    /// NOT be despawned. The reverted last-resort despawn fires only when the car is wedged past the
    /// horizon AND reroute + reverse both fail; a car that is simply queued must survive.
    ///
    /// Here the car is NOT wedged on the motion timer and its `stuck.secs` is below the despawn
    /// horizon, so neither despawn arm can trigger — it falls into reverse/hold and lives.
    #[test]
    fn car_stopped_in_congestion_is_not_despawned() {
        use crate::game::traffic::components::VehicleMotionTimer;
        use crate::game::transport::{GraphVersion, rebuild_road_graph_inner};

        let mut grid = MapGrid::new(5, 5);
        for x in 0..4 {
            put_road(&mut grid, TilePos { x, y: 0 }, RoadDir::East);
        }
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &GraphVersion(1), &mut graph);

        let mut app = App::new();
        let mut path_pool = PathPool::default();
        // Full valid route already interned (road A* will return the SAME route → no reroute).
        let handle = path_pool.intern(vec![
            TilePos { x: 0, y: 0 },
            TilePos { x: 1, y: 0 },
            TilePos { x: 2, y: 0 },
            TilePos { x: 3, y: 0 },
        ]);

        app.insert_resource(Time::<Fixed>::from_seconds(0.1));
        app.insert_resource(MapConfig::default());
        app.insert_resource(grid);
        app.insert_resource(graph);
        app.insert_resource(RegionGraph::default());
        app.insert_resource(TrafficOccupancy::default());
        app.insert_resource(PathfindingConfig::default());
        app.insert_resource(PathCache::default());
        app.insert_resource(path_pool);
        app.insert_resource(IntersectionIndex::default());
        app.insert_resource(TrafficConfig::default());
        app.insert_resource(crate::game::transport::LaneGraph::default());
        app.insert_resource(crate::game::transport::LaneletGraph::default());
        app.insert_resource(crate::game::sim::SimRng::default());
        app.init_resource::<RouteProducerStats>();
        app.init_resource::<bevy::ecs::message::Messages<TripFinished>>();

        let vehicle = Vehicle {
            path_handle: handle,
            path_cursor: 1,
            tile_pos: TilePos { x: 1, y: 0 },
            ..Default::default()
        };
        let stopped_key = crate::game::intersections::IntersectionKey {
            aabb_min: TilePos { x: 3, y: 0 },
            aabb_max: TilePos { x: 3, y: 0 },
            tile_count: 1,
            tiles_hash: 0,
        };
        let entity = app
            .world_mut()
            .spawn((
                vehicle,
                // Stopped behind congestion (downstream busy), but with a valid route.
                VehicleTrafficState::Stopped {
                    intersection: stopped_key,
                    stop_tile: TilePos { x: 3, y: 0 },
                    queue_position: 1,
                },
                StuckTimer {
                    // Past the reroute threshold (so recovery runs) but UNDER the despawn horizon.
                    secs: STUCK_REROUTE_SECS + 1.0,
                    last_tile: TilePos { x: 1, y: 0 },
                    last_progress: 0.0,
                },
                // NOT wedged: motion timer well under the despawn horizon (it's been stopped only a
                // little — a normal congestion wait, not a permanent freeze).
                VehicleMotionTimer {
                    moving_secs: 0.0,
                    anchor_pos: bevy::prelude::Vec2::ZERO,
                    stopped_secs: 5.0,
                },
            ))
            .id();

        app.add_systems(Update, resolve_stuck_vehicles);
        app.update();

        assert!(
            app.world().get_entity(entity).is_ok(),
            "a car merely stopped in congestion (valid route, downstream busy, not wedged past the \
             horizon) must NOT be despawned"
        );
    }
}
