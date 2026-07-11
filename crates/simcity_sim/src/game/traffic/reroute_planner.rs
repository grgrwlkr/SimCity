use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::RngExt;

use crate::game::intersections::IntersectionId;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::sim::SimRng;
use crate::game::transport::lanelet::pathfinding::{find_route, route_is_direction_correct};
use crate::game::transport::{
    LaneCostCtx, LaneGraph, LaneId, LaneletGraph, LaneletId, PathHandle, PathPool,
    PathfindingConfig, PathfindingCtx, find_road_path_cached,
};

use super::{TrafficOccupancy, Vehicle, VehicleLaneletPlan};

/// Resources needed to re-run the lanelet-aware planner at a reroute site, bundled so individual
/// systems stay under Bevy's 16-param `IntoSystem` limit. `traffic`/`path_cfg` are NOT bundled here:
/// some callers already hold those (and an extra `Res` of the same type in one system is rejected),
/// so they stay as explicit args to `replan_route_with_lanelets`.
#[derive(SystemParam)]
pub(crate) struct LaneletReplanRes<'w> {
    pub lane_graph: Res<'w, LaneGraph>,
    pub lanelet_graph: Res<'w, LaneletGraph>,
    pub sim_rng: ResMut<'w, SimRng>,
    /// Route-intern attribution counters (bundled here so callers stay under the param limit).
    pub producer_stats: ResMut<'w, super::RouteProducerStats>,
}

impl LaneletReplanRes<'_> {
    pub(crate) fn jitter_seed(&mut self) -> u64 {
        self.sim_rng.rng.random_range(1..=u64::MAX)
    }
}

/// Direction gate for hand-built / fallback routes: `true` iff no step of `route` travels against
/// a real road tile's lane direction. The SAME predicate as the lanelet post-guard (`find_route`),
/// applied by every rewriter to its non-lanelet route BEFORE interning — a route producer that
/// bypasses the planner must not bypass the guard. A refusal means "skip the rewrite, keep the old
/// route", never "drive it anyway".
pub(crate) fn route_direction_ok(route: &[TilePos], grid: &MapGrid) -> bool {
    route_is_direction_correct(route, grid)
}

/// Re-plan a mid-trip reroute through the SAME lanelet-aware planner that spawn uses, so the
/// `VehicleLaneletPlan` sidecar is re-populated instead of cleared. Without this, a rerouted vehicle
/// permanently loses its sidecar (only spawn writes it), the arbiter can't resolve a maneuver-legal
/// lanelet for it, drops it as a grant candidate, and the intersection under-admits into gridlock.
///
/// Returns `None` when start/goal lanes are unresolvable, or `find_route` yields an empty route — in
/// every such case the caller keeps its existing road-A* path + cleared sidecar.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(crate) fn replan_route_with_lanelets(
    lg: &LaneGraph,
    llg: &LaneletGraph,
    grid: &MapGrid,
    traffic: &TrafficOccupancy,
    path_cfg: &PathfindingConfig,
    jitter_seed: u64,
    cur_tile: TilePos,
    goal_tile: TilePos,
    travel_dir: RoadDir,
) -> Option<(Vec<TilePos>, Vec<(usize, IntersectionId, LaneletId)>)> {
    let start_lane = lg.get_rightmost_lane(cur_tile, travel_dir)?;
    let goal_dir = grid.get(goal_tile)?.road.dir;
    let goal_lane = lg.get_rightmost_lane(goal_tile, goal_dir)?;
    if start_lane == LaneId::INVALID || goal_lane == LaneId::INVALID {
        return None;
    }

    let ctx = LaneCostCtx {
        grid,
        traffic,
        cfg: path_cfg,
        jitter_seed,
    };
    let (tiles, sidecar) = find_route(lg, llg, &ctx, start_lane, goal_lane);
    if tiles.is_empty() {
        return None;
    }
    Some((tiles, sidecar))
}

/// Who produced the applied route — callers attribute their own stats by this.
#[allow(dead_code)] // Consumed by the upcoming bus/service lanelet-routing migration tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RouteProducer {
    Lanelet,
    RoadFallback,
}

/// An opaque planned route. Fields are private ON PURPOSE: the ONLY ways to use one are
/// `apply_route` (existing vehicle) and `into_spawn_parts` (new entity), which keep the
/// VehicleLaneletPlan sidecar in sync with the interned path — the arbiter validates sidecar
/// entries only by intersection id, so a stale sidecar silently resolves the WRONG conflict row.
#[allow(dead_code)] // Consumed by the upcoming bus/service lanelet-routing migration tasks.
pub(crate) struct PlannedRoute {
    tiles: Vec<TilePos>,
    sidecar: Vec<(usize, IntersectionId, LaneletId)>,
    producer: RouteProducer,
}

impl PlannedRoute {
    #[allow(dead_code)] // Consumed by the upcoming bus/service lanelet-routing migration tasks.
    pub(crate) fn producer(&self) -> RouteProducer {
        self.producer
    }

    /// Spawn-time consumption: intern the route and hand out the Vehicle/bundle pieces.
    #[allow(dead_code)] // Consumed by the upcoming bus/service lanelet-routing migration tasks.
    pub(crate) fn into_spawn_parts(self, pool: &mut PathPool) -> (PathHandle, VehicleLaneletPlan) {
        let handle = pool.intern(self.tiles);
        (
            handle,
            VehicleLaneletPlan {
                entries: self.sidecar,
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn for_tests(
        tiles: Vec<TilePos>,
        sidecar: Vec<(usize, IntersectionId, LaneletId)>,
        producer: RouteProducer,
    ) -> Self {
        Self {
            tiles,
            sidecar,
            producer,
        }
    }
}

/// Tile->tile planning, lanelet-first with a dir-guarded road-A* fallback (the same policy cars
/// use at spawn). `None` = nothing legal routes (caller keeps its current behavior for that case).
#[allow(dead_code)] // Consumed by the upcoming bus/service lanelet-routing migration tasks.
pub(crate) fn plan_tiles_lanelet_first(
    replan: &mut LaneletReplanRes,
    road_ctx: &mut PathfindingCtx<'_>,
    from: TilePos,
    to: TilePos,
) -> Option<PlannedRoute> {
    let jitter_seed = replan.jitter_seed();
    plan_tiles_lanelet_first_inner(
        &replan.lane_graph,
        &replan.lanelet_graph,
        jitter_seed,
        &mut replan.producer_stats,
        road_ctx,
        from,
        to,
    )
    // NB: `Res`/`ResMut` поля коэрсятся к `&LaneGraph`/`&mut RouteProducerStats` deref-коэрцией;
    // если компилятор попросит — писать явно `&mut *replan.producer_stats`.
}

/// SystemParam-free core (unit-testable). Kept private to the traffic module.
#[allow(dead_code)] // Called by `plan_tiles_lanelet_first`, dead in the plain lib build until then.
pub(crate) fn plan_tiles_lanelet_first_inner(
    lg: &LaneGraph,
    llg: &LaneletGraph,
    jitter_seed: u64,
    stats: &mut super::RouteProducerStats,
    road_ctx: &mut PathfindingCtx<'_>,
    from: TilePos,
    to: TilePos,
) -> Option<PlannedRoute> {
    let travel_dir = road_ctx
        .grid
        .get(from)
        .map_or(RoadDir::None, |c| c.road.dir);
    if let Some((tiles, sidecar)) = replan_route_with_lanelets(
        lg,
        llg,
        road_ctx.grid,
        road_ctx.traffic,
        road_ctx.cfg,
        jitter_seed,
        from,
        to,
        travel_dir,
    ) {
        return Some(PlannedRoute {
            tiles,
            sidecar,
            producer: RouteProducer::Lanelet,
        });
    }
    let tiles = find_road_path_cached(road_ctx, from, to);
    if tiles.is_empty() {
        return None;
    }
    if !route_direction_ok(&tiles, road_ctx.grid) {
        stats.guard_refusals = stats.guard_refusals.saturating_add(1);
        return None;
    }
    Some(PlannedRoute {
        tiles,
        sidecar: Vec::new(),
        producer: RouteProducer::RoadFallback,
    })
}

/// The ONLY way to put a `PlannedRoute` onto an existing vehicle: release -> intern -> cursor 0
/// -> progress 0 -> sidecar written (lanelet) or cleared (fallback). No call site can desync the
/// sidecar from the path.
#[allow(dead_code)] // Consumed by the upcoming bus/service lanelet-routing migration tasks.
pub(crate) fn apply_route(
    vehicle: &mut Vehicle,
    plan: Option<&mut VehicleLaneletPlan>,
    pool: &mut PathPool,
    planned: PlannedRoute,
) {
    pool.release(vehicle.path_handle);
    vehicle.path_handle = pool.intern(planned.tiles);
    vehicle.path_cursor = 0;
    vehicle.progress = 0.0;
    if let Some(p) = plan {
        p.entries = planned.sidecar;
    }
}

/// R3 (stale routes): active routes are NOT re-derived when the player edits roads — a vehicle
/// keeps driving a route computed against the OLD grid, potentially against a flipped lane
/// direction or across deleted road tiles, until stuck-recovery notices ~a minute later. This
/// system starts a sweep once per `GraphVersion` bump (i.e. only after a structural map edit):
/// every active route is re-validated against the NEW grid (all tiles still roads + no step
/// against a lane direction). Invalid routes are replanned in place through the lanelet-aware
/// planner; when no legal continuation exists (e.g. the road under the vehicle was deleted), the
/// route is truncated to the current tile so the normal arrival/stuck guardrails take over — the
/// vehicle never drives the stale, now-illegal tail.
///
/// Budgeted: one road edit in a big city can invalidate hundreds of routes, and replanning them
/// all inside a single 100 ms fixed tick is a visible hitch. At most `max_route_plans_per_tick`
/// replans run per tick (validation itself is cheap and unbudgeted); the sweep carries over to
/// subsequent ticks until a full pass finds no out-of-budget work. Vehicles fixed earlier in the
/// sweep re-validate as legal and are skipped, so carry-over does not re-replan them.
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
pub(crate) fn invalidate_routes_on_graph_change(
    gv: Res<super::super::transport::GraphVersion>,
    mut last_seen: Local<Option<u64>>,
    mut sweep_pending: Local<bool>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    path_cfg: Res<PathfindingConfig>,
    traffic_cfg: Res<super::TrafficConfig>,
    mut path_pool: ResMut<super::super::transport::PathPool>,
    mut replan: LaneletReplanRes,
    mut q: Query<
        (&mut super::Vehicle, Option<&mut super::VehicleLaneletPlan>),
        Without<super::Parked>,
    >,
) {
    let first_run = last_seen.is_none();
    let changed = *last_seen != Some(gv.0);
    *last_seen = Some(gv.0);
    if changed && !first_run {
        *sweep_pending = true;
    }
    if !*sweep_pending {
        return;
    }

    let budget = traffic_cfg.max_route_plans_per_tick.max(1);
    let mut replans = 0usize;
    let mut out_of_budget = false;
    for (mut v, mut plan) in q.iter_mut() {
        let Some(rem) = path_pool.remaining_from(v.path_handle, v.path_cursor) else {
            continue;
        };
        // Nothing left to validate (idle/arrived/already-truncated routes) — in particular a
        // route truncated by an earlier sweep tick must not consume budget again every tick.
        if rem.len() <= 1 {
            continue;
        }
        let all_roads = rem
            .iter()
            .all(|t| grid.get(*t).is_some_and(|c| !c.water && c.road.is_some()));
        if all_roads && route_direction_ok(rem, &grid) {
            continue;
        }
        if replans >= budget {
            out_of_budget = true;
            break;
        }
        replans += 1;
        let Some(current) = rem.first().copied() else {
            continue;
        };
        let goal = rem.last().copied().unwrap_or(current);
        let travel_dir = grid.get(current).map_or(RoadDir::None, |c| c.road.dir);
        let jitter_seed = replan.jitter_seed();
        let new_route = replan_route_with_lanelets(
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
        match new_route {
            Some((tiles, sidecar)) => {
                v.path_handle = path_pool.intern(tiles);
                if let Some(p) = plan.as_deref_mut() {
                    p.entries = sidecar;
                }
            }
            None => {
                v.path_handle = path_pool.intern(vec![current]);
                super::clear_lanelet_plan_on_reroute(plan.as_deref_mut());
            }
        }
        v.path_cursor = 0;
    }
    *sweep_pending = out_of_budget;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::intersections::IntersectionIndex;
    use crate::game::map::MapConfig;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow, RoadKind};
    use crate::game::traffic::components::Vehicle;
    use crate::game::transport::lane_graph::build_lane_graph_inner;
    use crate::game::transport::{
        GraphVersion, LaneletGraph, PathCache, PathPool, PathfindingCtx, RoadGraph,
        rebuild_road_graph_inner,
    };
    use bevy::app::App;

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

    /// R3 regression: after the player flips a road's direction under an active route, the vehicle
    /// must NOT keep driving the stale route against the new lane direction — the invalidation
    /// pass replans (or truncates) it on the very next graph rebuild.
    #[test]
    fn stale_route_is_invalidated_when_lane_direction_flips() {
        let mut grid = MapGrid::new(6, 3);
        for x in 0..6 {
            put_road(&mut grid, TilePos { x, y: 1 }, RoadDir::East);
        }

        let mut app = App::new();
        let mut path_pool = PathPool::default();
        let route: Vec<TilePos> = (0..6).map(|x| TilePos { x, y: 1 }).collect();
        let handle = path_pool.intern(route);

        app.insert_resource(grid);
        app.insert_resource(MapConfig::default());
        app.insert_resource(TrafficOccupancy::default());
        app.insert_resource(PathfindingConfig::default());
        app.insert_resource(path_pool);
        app.insert_resource(GraphVersion(1));
        app.insert_resource(crate::game::traffic::TrafficConfig::default());
        app.insert_resource(crate::game::transport::LaneGraph::default());
        app.insert_resource(LaneletGraph::default());
        app.insert_resource(crate::game::sim::SimRng::default());
        app.init_resource::<crate::game::traffic::RouteProducerStats>();
        app.add_systems(bevy::app::Update, invalidate_routes_on_graph_change);

        let vehicle = app
            .world_mut()
            .spawn(Vehicle {
                path_handle: handle,
                path_cursor: 1,
                tile_pos: TilePos { x: 1, y: 1 },
                ..Default::default()
            })
            .id();

        // Tick 1: baseline (system latches the current version, no invalidation).
        app.update();

        // Player flips the whole road to WEST; CommandApply bumps the GraphVersion.
        {
            let mut grid = app.world_mut().resource_mut::<MapGrid>();
            for x in 0..6 {
                put_road(&mut grid, TilePos { x, y: 1 }, RoadDir::West);
            }
        }
        app.world_mut().resource_mut::<GraphVersion>().0 = 2;
        app.update();

        // The stale eastbound tail must be gone: with an empty LaneGraph no legal replan exists,
        // so the route is truncated to the current tile (guardrails take over from there).
        let v = app.world().get::<Vehicle>(vehicle).unwrap();
        let pool = app.world().resource::<PathPool>();
        let rem = pool
            .remaining_from(v.path_handle, v.path_cursor)
            .unwrap_or(&[]);
        let grid = app.world().resource::<MapGrid>();
        assert!(
            route_direction_ok(rem, grid),
            "route still steps against the flipped lane direction: {rem:?}"
        );
        assert!(
            rem.len() <= 1,
            "no legal continuation exists (empty lane graph) — route must be truncated, got {rem:?}"
        );
    }

    /// Budget carry-over: with `max_route_plans_per_tick = 1` and TWO invalidated routes, the
    /// sweep must fix exactly one route per tick and carry the remainder to the next tick —
    /// never replan an unbounded number of vehicles inside one fixed tick (a visible hitch on
    /// every structural edit), and never lose the remainder (a stale route driving against
    /// flipped lanes).
    #[test]
    fn graph_change_replans_are_budgeted_and_carry_over() {
        let mut grid = MapGrid::new(6, 3);
        for x in 0..6 {
            put_road(&mut grid, TilePos { x, y: 1 }, RoadDir::East);
        }

        let mut app = App::new();
        let mut path_pool = PathPool::default();
        // Distinct lengths so the two routes cannot alias to one interned path.
        let route_a: Vec<TilePos> = (0..6).map(|x| TilePos { x, y: 1 }).collect();
        let route_b: Vec<TilePos> = (0..5).map(|x| TilePos { x, y: 1 }).collect();
        let handle_a = path_pool.intern(route_a);
        let handle_b = path_pool.intern(route_b);

        app.insert_resource(grid);
        app.insert_resource(MapConfig::default());
        app.insert_resource(TrafficOccupancy::default());
        app.insert_resource(PathfindingConfig::default());
        app.insert_resource(path_pool);
        app.insert_resource(GraphVersion(1));
        app.insert_resource(crate::game::traffic::TrafficConfig {
            max_route_plans_per_tick: 1,
            ..Default::default()
        });
        app.insert_resource(crate::game::transport::LaneGraph::default());
        app.insert_resource(LaneletGraph::default());
        app.insert_resource(crate::game::sim::SimRng::default());
        app.init_resource::<crate::game::traffic::RouteProducerStats>();
        app.add_systems(bevy::app::Update, invalidate_routes_on_graph_change);

        let vehicles: Vec<_> = [handle_a, handle_b]
            .into_iter()
            .map(|handle| {
                app.world_mut()
                    .spawn(Vehicle {
                        path_handle: handle,
                        path_cursor: 1,
                        tile_pos: TilePos { x: 1, y: 1 },
                        ..Default::default()
                    })
                    .id()
            })
            .collect();

        // Tick 1: baseline (system latches the current version, no invalidation).
        app.update();

        // Player flips the whole road to WEST; CommandApply bumps the GraphVersion.
        {
            let mut grid = app.world_mut().resource_mut::<MapGrid>();
            for x in 0..6 {
                put_road(&mut grid, TilePos { x, y: 1 }, RoadDir::West);
            }
        }
        app.world_mut().resource_mut::<GraphVersion>().0 = 2;

        let stale_count = |app: &mut App| {
            let pool = app.world().resource::<PathPool>();
            vehicles
                .iter()
                .filter(|&&e| {
                    let v = app.world().get::<Vehicle>(e).unwrap();
                    let rem = pool
                        .remaining_from(v.path_handle, v.path_cursor)
                        .unwrap_or(&[]);
                    // Truncated-to-current == fixed; a multi-tile eastbound tail == still stale.
                    rem.len() > 1
                })
                .count()
        };

        // Sweep tick 1: budget is 1 — exactly ONE of the two stale routes may be fixed.
        app.update();
        assert_eq!(
            stale_count(&mut app),
            1,
            "budget=1 must fix exactly one route on the first sweep tick"
        );

        // Sweep tick 2 (same GraphVersion): the carried-over remainder must be fixed now.
        app.update();
        assert_eq!(
            stale_count(&mut app),
            0,
            "the sweep must carry over and fix the remaining stale route on the next tick"
        );
    }

    /// Shared plumbing for `plan_tiles_lanelet_first_inner` fixtures: a real `RoadGraph` +
    /// default `PathCache`/`TrafficOccupancy`/`IntersectionIndex` built over `grid`.
    fn make_pathfinding_parts(
        grid: &MapGrid,
    ) -> (
        RoadGraph,
        PathfindingConfig,
        PathCache,
        TrafficOccupancy,
        IntersectionIndex,
    ) {
        let gv = GraphVersion(1);
        let mut road_graph = RoadGraph::default();
        rebuild_road_graph_inner(grid, &gv, &mut road_graph);
        let cfg = PathfindingConfig::default();
        let cache = PathCache::default();
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let intersections = IntersectionIndex::default();
        (road_graph, cfg, cache, traffic, intersections)
    }

    #[test]
    fn adapter_inner_lanelet_success_has_lanelet_producer() {
        let mut grid = MapGrid::new(8, 3);
        for x in 0..8 {
            put_road(&mut grid, TilePos { x, y: 1 }, RoadDir::East);
        }
        let gv = GraphVersion(1);
        let lg = build_lane_graph_inner(&grid, &gv);
        let llg = LaneletGraph::default();
        let (road_graph, cfg, mut cache, traffic, intersections) = make_pathfinding_parts(&grid);
        let mut ctx = PathfindingCtx {
            time_now_sec: 0.0,
            cfg: &cfg,
            cache: &mut cache,
            graph: &road_graph,
            regions: None,
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };
        let mut stats = crate::game::traffic::RouteProducerStats::default();

        let planned = plan_tiles_lanelet_first_inner(
            &lg,
            &llg,
            42,
            &mut stats,
            &mut ctx,
            TilePos { x: 0, y: 1 },
            TilePos { x: 7, y: 1 },
        )
        .expect("straight road must be plannable");
        assert!(matches!(planned.producer(), RouteProducer::Lanelet));
    }

    #[test]
    fn adapter_inner_falls_back_to_road_astar_when_lanes_missing() {
        let mut grid = MapGrid::new(8, 3);
        for x in 0..8 {
            put_road(&mut grid, TilePos { x, y: 1 }, RoadDir::East);
        }
        let llg = LaneletGraph::default();
        let (road_graph, cfg, mut cache, traffic, intersections) = make_pathfinding_parts(&grid);
        let mut ctx = PathfindingCtx {
            time_now_sec: 0.0,
            cfg: &cfg,
            cache: &mut cache,
            graph: &road_graph,
            regions: None,
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };
        let mut stats = crate::game::traffic::RouteProducerStats::default();

        // lanes are unresolvable (default LaneGraph) -> lanelet planner must decline, but the
        // real road graph is intact, so the dir-guarded road-A* fallback lives.
        let planned = plan_tiles_lanelet_first_inner(
            &LaneGraph::default(),
            &llg,
            42,
            &mut stats,
            &mut ctx,
            TilePos { x: 0, y: 1 },
            TilePos { x: 7, y: 1 },
        )
        .expect("road-A* fallback must succeed");
        assert!(matches!(planned.producer(), RouteProducer::RoadFallback));
    }

    #[test]
    fn adapter_inner_returns_none_when_nothing_routes() {
        // No roads anywhere: neither the lanelet planner nor road-A* can find a route.
        let grid = MapGrid::new(8, 3);
        let llg = LaneletGraph::default();
        let cfg = PathfindingConfig::default();
        let mut cache = PathCache::default();
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let intersections = IntersectionIndex::default();
        let road_graph = RoadGraph::default();
        let mut ctx = PathfindingCtx {
            time_now_sec: 0.0,
            cfg: &cfg,
            cache: &mut cache,
            graph: &road_graph,
            regions: None,
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };
        let mut stats = crate::game::traffic::RouteProducerStats::default();

        assert!(
            plan_tiles_lanelet_first_inner(
                &LaneGraph::default(),
                &llg,
                42,
                &mut stats,
                &mut ctx,
                TilePos { x: 0, y: 1 },
                TilePos { x: 7, y: 1 },
            )
            .is_none()
        );
    }

    #[test]
    fn apply_route_resets_cursor_and_syncs_sidecar() {
        let mut pool = PathPool::default();
        let old = pool.intern(vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }]);
        let mut v = Vehicle {
            path_handle: old,
            path_cursor: 1,
            progress: 0.7,
            ..Default::default()
        };
        let mut plan = crate::game::traffic::VehicleLaneletPlan {
            entries: vec![(
                3,
                crate::game::intersections::IntersectionId(9),
                LaneletId(9),
            )],
        };
        // fallback-план: сайдкар обязан ОЧИСТИТЬСЯ
        let planned = PlannedRoute::for_tests(
            vec![TilePos { x: 5, y: 5 }, TilePos { x: 6, y: 5 }],
            Vec::new(),
            RouteProducer::RoadFallback,
        );
        apply_route(&mut v, Some(&mut plan), &mut pool, planned);
        assert_eq!(v.path_cursor, 0);
        assert_eq!(v.progress, 0.0);
        assert!(
            plan.entries.is_empty(),
            "fallback must CLEAR the stale sidecar"
        );
        assert_eq!(
            pool.remaining_from(v.path_handle, 0).unwrap()[0],
            TilePos { x: 5, y: 5 }
        );
        // lanelet-план: сайдкар обязан ЗАПИСАТЬСЯ
        let planned = PlannedRoute::for_tests(
            vec![TilePos { x: 7, y: 5 }, TilePos { x: 8, y: 5 }],
            vec![(
                1,
                crate::game::intersections::IntersectionId(2),
                LaneletId(4),
            )],
            RouteProducer::Lanelet,
        );
        apply_route(&mut v, Some(&mut plan), &mut pool, planned);
        assert_eq!(plan.entries.len(), 1);
    }
}
