use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::RngExt;

use crate::game::intersections::IntersectionId;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::sim::SimRng;
use crate::game::transport::lanelet::pathfinding::{find_route, route_is_direction_correct};
use crate::game::transport::{
    LaneCostCtx, LaneGraph, LaneId, LaneletGraph, LaneletId, PathfindingConfig,
};

use super::TrafficOccupancy;

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
    use crate::game::map::MapConfig;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow, RoadKind};
    use crate::game::traffic::components::Vehicle;
    use crate::game::transport::{GraphVersion, LaneletGraph, PathPool};
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
}
