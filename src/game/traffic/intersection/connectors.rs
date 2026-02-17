use std::collections::{HashMap, HashSet, VecDeque};

use bevy::prelude::*;

use crate::game::intersections::{IntersectionCluster, IntersectionId, IntersectionIndex};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::traffic::{
    DebugIntersectionConnectorState, DebugManeuverKind, DebugRoadDir, Parked, TrafficConfig,
    Vehicle, VehicleTrafficState,
};
use crate::game::transport::PathPool;

use super::zones::{ManeuverKind, maneuver_kind};

/// Cached per-cluster data used for deterministic connector path generation.
struct ClusterCache {
    /// All tiles belonging to this intersection cluster.
    tiles: Vec<TilePos>,
    /// Fast membership check for cluster tiles.
    tiles_set: HashSet<TilePos>,
    /// Axis-aligned bounds of the cluster.
    aabb_min: TilePos,
    /// Axis-aligned bounds of the cluster.
    aabb_max: TilePos,
}

/// Per-version cache for intersection connector data.
#[derive(Default)]
pub(crate) struct ConnectorCache {
    /// Graph version used to build the cache.
    version: u64,
    /// Cluster cache by intersection id.
    clusters: HashMap<IntersectionId, ClusterCache>,
}

/// Marker for vehicles scheduled for connector rewriting.
#[derive(Component, Debug, Copy, Clone)]
pub(crate) struct NeedsConnectorRewrite;

/// Guardrail: maximum number of connector rewrites per tick.
const MAX_CONNECTOR_REWRITES_PER_TICK: usize = 24;
/// Quick lookahead for marking vehicles close to intersection entry.
const CONNECTOR_REWRITE_LOOKAHEAD_TILES: usize = 3;

/// Mark vehicles that are close enough to an intersection to benefit from connector rewriting.
pub(crate) fn mark_vehicles_needing_connector_rewrite(
    grid: Res<MapGrid>,
    path_pool: Res<PathPool>,
    q_vehicles: Query<
        (
            Entity,
            &Vehicle,
            &VehicleTrafficState,
            Option<&NeedsConnectorRewrite>,
        ),
        Without<Parked>,
    >,
    mut commands: Commands,
) {
    for (e, v, traffic_state, marked) in q_vehicles.iter() {
        if marked.is_some() {
            continue;
        }
        if should_mark_for_connector_rewrite(v, *traffic_state, &path_pool, &grid) {
            commands.entity(e).insert(NeedsConnectorRewrite);
        }
    }
}

fn should_mark_for_connector_rewrite(
    v: &Vehicle,
    traffic_state: VehicleTrafficState,
    path_pool: &PathPool,
    grid: &MapGrid,
) -> bool {
    if matches!(
        traffic_state,
        VehicleTrafficState::Approaching { .. }
            | VehicleTrafficState::Stopped { .. }
            | VehicleTrafficState::WaitingForGreen { .. }
            | VehicleTrafficState::CrossingIntersection { .. }
    ) {
        return true;
    }

    let mut saw_intersection = false;
    for offset in 0..=CONNECTOR_REWRITE_LOOKAHEAD_TILES {
        let idx = v.path_cursor + offset;
        let Some(tile) = path_pool.get_tile(v.path_handle, idx) else {
            break;
        };
        if is_intersection_tile(grid, tile) {
            saw_intersection = true;
        } else if saw_intersection {
            // We are close to an intersection segment boundary.
            return true;
        }
    }
    false
}

/// Budgeted connector rewriting for vehicles previously marked by
/// `mark_vehicles_needing_connector_rewrite`.
#[allow(clippy::type_complexity)]
pub(crate) fn rewrite_marked_intersection_connectors(
    grid: Res<MapGrid>,
    traffic_cfg: Res<TrafficConfig>,
    intersections: Res<IntersectionIndex>,
    mut path_pool: ResMut<PathPool>,
    mut q_vehicles: Query<
        (
            Entity,
            &mut Vehicle,
            Option<&mut DebugIntersectionConnectorState>,
        ),
        (Without<Parked>, With<NeedsConnectorRewrite>),
    >,
    mut cache: Local<ConnectorCache>,
    mut commands: Commands,
) {
    if cache.version != intersections.version {
        rebuild_connector_cache(&intersections, &mut cache);
    }

    for (processed, (e, mut v, debug_opt)) in q_vehicles.iter_mut().enumerate() {
        if processed >= MAX_CONNECTOR_REWRITES_PER_TICK {
            break;
        }

        rewrite_connector_for_vehicle(
            e,
            &mut v,
            debug_opt,
            &grid,
            &traffic_cfg,
            &intersections,
            &mut path_pool,
            &cache,
            &mut commands,
        );
        commands.entity(e).remove::<NeedsConnectorRewrite>();
    }
}

/// Rewrite intersection segments into deterministic connector paths.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn rewrite_intersection_connectors(
    grid: Res<MapGrid>,
    traffic_cfg: Res<TrafficConfig>,
    intersections: Res<IntersectionIndex>,
    mut path_pool: ResMut<PathPool>,
    mut q_vehicles: Query<
        (
            Entity,
            &mut Vehicle,
            Option<&mut DebugIntersectionConnectorState>,
        ),
        Without<Parked>,
    >,
    mut cache: Local<ConnectorCache>,
    mut commands: Commands,
) {
    if cache.version != intersections.version {
        rebuild_connector_cache(&intersections, &mut cache);
    }

    for (e, mut v, debug_opt) in q_vehicles.iter_mut() {
        rewrite_connector_for_vehicle(
            e,
            &mut v,
            debug_opt,
            &grid,
            &traffic_cfg,
            &intersections,
            &mut path_pool,
            &cache,
            &mut commands,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn rewrite_connector_for_vehicle(
    e: Entity,
    v: &mut Vehicle,
    debug_opt: Option<Mut<DebugIntersectionConnectorState>>,
    grid: &MapGrid,
    traffic_cfg: &TrafficConfig,
    intersections: &IntersectionIndex,
    path_pool: &mut PathPool,
    cache: &ConnectorCache,
    commands: &mut Commands,
) {
    let mut debug_state = DebugIntersectionConnectorState::default();
    let mut rewritten_route: Option<Vec<TilePos>> = None;

    if let Some(route) = path_pool.remaining_from(v.path_handle, v.path_cursor) {
        debug_state.route_len = route.len() as u32;

        if let Some((i, j)) = first_intersection_segment(route, grid) {
            debug_state.active = true;
            debug_state.segment_start = i as u32;
            debug_state.segment_end = j as u32;
            debug_state.existing_len = (j - i) as u32;

            let approach_tile = route[i.saturating_sub(1)];
            let entry_tile = route[i];
            let exit_tile = route[j.saturating_sub(1)];
            let exit_lane_tile = route[j];

            debug_state.approach_x = approach_tile.x;
            debug_state.approach_y = approach_tile.y;
            debug_state.entry_x = entry_tile.x;
            debug_state.entry_y = entry_tile.y;
            debug_state.exit_x = exit_tile.x;
            debug_state.exit_y = exit_tile.y;
            debug_state.exit_lane_x = exit_lane_tile.x;
            debug_state.exit_lane_y = exit_lane_tile.y;

            let entry_dir = super::super::dir_between_adjacent(approach_tile, entry_tile);
            let exit_dir = super::super::dir_between_adjacent(exit_tile, exit_lane_tile);
            debug_state.entry_dir = DebugRoadDir::from(entry_dir);
            debug_state.exit_dir = DebugRoadDir::from(exit_dir);

            if entry_dir != RoadDir::None
                && exit_dir != RoadDir::None
                && let Some(id) = intersections.intersection_id_at(entry_tile)
            {
                debug_state.intersection_id = id.0;
                if intersections.intersection_id_at(exit_tile) == Some(id)
                    && let Some(cluster) = cache.clusters.get(&id)
                {
                    let maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);
                    debug_state.maneuver = debug_maneuver_kind(maneuver);

                    if let Some((connector, anchor)) = build_connector_path(
                        entry_tile,
                        exit_tile,
                        entry_dir,
                        exit_dir,
                        cluster,
                        traffic_cfg,
                    ) {
                        debug_state.has_connector = true;
                        debug_state.connector_len = connector.len() as u32;
                        debug_state.anchor_x = anchor.x;
                        debug_state.anchor_y = anchor.y;

                        let existing_segment = &route[i..j];
                        if existing_segment != connector.as_slice() {
                            debug_state.was_rewritten = true;
                        }
                    }
                }
            }
        }

        if let Some(new_route) =
            rewrite_intersection_segments(route, grid, intersections, traffic_cfg, cache)
        {
            if !debug_state.was_rewritten {
                debug_state.was_rewritten = true;
            }
            rewritten_route = Some(new_route);
        }
    }

    if let Some(new_route) = rewritten_route {
        let old_handle = v.path_handle;
        v.path_handle = path_pool.intern(new_route);
        v.path_cursor = 0;
        path_pool.release(old_handle);
    }

    if let Some(mut existing) = debug_opt {
        *existing = debug_state;
    } else {
        commands.entity(e).insert(debug_state);
    }
}

/// Rebuild connector cache from the current intersection index.
fn rebuild_connector_cache(index: &IntersectionIndex, cache: &mut ConnectorCache) {
    cache.clusters.clear();
    for cluster in index.clusters.iter() {
        cache
            .clusters
            .insert(cluster.id, build_cluster_cache(cluster));
    }
    cache.version = index.version;
}

/// Build a cached helper representation for a single cluster.
fn build_cluster_cache(cluster: &IntersectionCluster) -> ClusterCache {
    let aabb_min = cluster.aabb_min;
    let aabb_max = cluster.aabb_max;

    ClusterCache {
        tiles: cluster.tiles.clone(),
        tiles_set: cluster.tiles.iter().copied().collect(),
        aabb_min,
        aabb_max,
    }
}

/// Locate the first contiguous intersection segment in a route.
fn first_intersection_segment(route: &[TilePos], grid: &MapGrid) -> Option<(usize, usize)> {
    let mut i = None;
    for (idx, &t) in route.iter().enumerate().skip(1) {
        if is_intersection_tile(grid, t) && !is_intersection_tile(grid, route[idx - 1]) {
            i = Some(idx);
            break;
        }
    }
    let i = i?;
    let mut j = i;
    while j < route.len() && is_intersection_tile(grid, route[j]) {
        j += 1;
    }
    if j >= route.len() {
        return None;
    }
    Some((i, j))
}

/// Rewrite all intersection segments in the route using deterministic connectors.
fn rewrite_intersection_segments(
    route: &[TilePos],
    grid: &MapGrid,
    intersections: &IntersectionIndex,
    traffic_cfg: &TrafficConfig,
    cache: &ConnectorCache,
) -> Option<Vec<TilePos>> {
    if route.len() < 3 {
        return None;
    }

    let mut changed = false;
    let mut out = Vec::with_capacity(route.len());
    let mut idx = 0usize;
    while idx < route.len() {
        let is_segment_start = idx > 0
            && is_intersection_tile(grid, route[idx])
            && !is_intersection_tile(grid, route[idx - 1]);
        if !is_segment_start {
            out.push(route[idx]);
            idx += 1;
            continue;
        }

        let start = idx;
        let mut end = start;
        while end < route.len() && is_intersection_tile(grid, route[end]) {
            end += 1;
        }
        if end >= route.len() {
            out.extend_from_slice(&route[start..]);
            break;
        }

        let approach_tile = route[start - 1];
        let entry_tile = route[start];
        let exit_tile = route[end - 1];
        let exit_lane_tile = route[end];
        let existing_segment = &route[start..end];

        let entry_dir = super::super::dir_between_adjacent(approach_tile, entry_tile);
        let exit_dir = super::super::dir_between_adjacent(exit_tile, exit_lane_tile);

        let mut replaced = false;
        if entry_dir != RoadDir::None
            && exit_dir != RoadDir::None
            && let Some(id) = intersections.intersection_id_at(entry_tile)
            && intersections.intersection_id_at(exit_tile) == Some(id)
            && let Some(cluster) = cache.clusters.get(&id)
            && let Some((connector, _anchor)) = build_connector_path(
                entry_tile,
                exit_tile,
                entry_dir,
                exit_dir,
                cluster,
                traffic_cfg,
            )
        {
            replaced = true;
            if existing_segment != connector.as_slice() {
                changed = true;
                out.extend(connector);
            } else {
                out.extend_from_slice(existing_segment);
            }
        }

        if !replaced {
            out.extend_from_slice(existing_segment);
        }
        idx = end;
    }

    if changed { Some(out) } else { None }
}

/// Build a connector path through a cluster for a specific maneuver.
fn build_connector_path(
    entry_tile: TilePos,
    exit_tile: TilePos,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
    cluster: &ClusterCache,
    traffic_cfg: &TrafficConfig,
) -> Option<(Vec<TilePos>, TilePos)> {
    let anchor = choose_anchor(
        entry_tile,
        exit_tile,
        entry_dir,
        exit_dir,
        cluster,
        traffic_cfg,
    )?;
    let bounds = center_bounds(cluster.aabb_min, cluster.aabb_max);
    let entry_side = side_dir_for_travel(traffic_cfg, entry_dir);
    let exit_side = side_dir_for_travel(traffic_cfg, exit_dir);
    let allowed_entry = |pos: TilePos| {
        pos == entry_tile
            || pos == anchor
            || is_center_tile(pos, bounds)
            || is_on_side(pos, entry_side, bounds)
    };
    let allowed_exit = |pos: TilePos| {
        pos == exit_tile
            || pos == anchor
            || is_center_tile(pos, bounds)
            || is_on_side(pos, exit_side, bounds)
    };

    let mut path_a = axis_first_path(entry_tile, anchor, Some(entry_dir), cluster, &allowed_entry)
        .or_else(|| bfs_path(entry_tile, anchor, cluster, &allowed_entry))?;
    let path_b = axis_first_path(anchor, exit_tile, Some(exit_dir), cluster, &allowed_exit)
        .or_else(|| bfs_path(anchor, exit_tile, cluster, &allowed_exit))?;

    if path_b.len() > 1 {
        path_a.pop();
        path_a.extend(path_b);
    }

    Some((path_a, anchor))
}

/// Choose an anchor tile that defines the intended connector shape.
fn choose_anchor(
    entry_tile: TilePos,
    exit_tile: TilePos,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
    cluster: &ClusterCache,
    traffic_cfg: &TrafficConfig,
) -> Option<TilePos> {
    let maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);
    let raw = match maneuver {
        ManeuverKind::Straight => exit_tile,
        ManeuverKind::RightTurn => corner_anchor(entry_tile, exit_tile, entry_dir),
        ManeuverKind::LeftTurn | ManeuverKind::Other => {
            left_turn_anchor(entry_tile, entry_dir, cluster)?
        }
    };

    let clamped = TilePos {
        x: raw.x.clamp(cluster.aabb_min.x, cluster.aabb_max.x),
        y: raw.y.clamp(cluster.aabb_min.y, cluster.aabb_max.y),
    };
    nearest_tile_in_cluster(clamped, cluster)
}

fn debug_maneuver_kind(maneuver: ManeuverKind) -> DebugManeuverKind {
    match maneuver {
        ManeuverKind::Straight => DebugManeuverKind::Straight,
        ManeuverKind::RightTurn => DebugManeuverKind::RightTurn,
        ManeuverKind::LeftTurn => DebugManeuverKind::LeftTurn,
        ManeuverKind::Other => DebugManeuverKind::Other,
    }
}

/// Anchor for right turns: intersection of entry and exit lines.
fn corner_anchor(entry_tile: TilePos, exit_tile: TilePos, entry_dir: RoadDir) -> TilePos {
    let (ax, ay) = match entry_dir {
        RoadDir::North | RoadDir::South => (entry_tile.x, exit_tile.y),
        RoadDir::East | RoadDir::West => (exit_tile.x, entry_tile.y),
        RoadDir::None => (entry_tile.x, entry_tile.y),
    };
    TilePos { x: ax, y: ay }
}

/// Anchor for left turns / U-turns: closest center tile.
fn left_turn_anchor(
    entry_tile: TilePos,
    entry_dir: RoadDir,
    cluster: &ClusterCache,
) -> Option<TilePos> {
    let (center_x0, center_x1, center_y0, center_y1) =
        center_bounds(cluster.aabb_min, cluster.aabb_max);
    let mut best: Option<TilePos> = None;
    let mut best_proj = i32::MIN;
    let mut best_dist = i32::MAX;

    for t in cluster.tiles.iter().copied() {
        if t.x < center_x0 || t.x > center_x1 || t.y < center_y0 || t.y > center_y1 {
            continue;
        }
        let proj = dir_projection(t, entry_dir);
        let dist = (t.x - entry_tile.x).abs() + (t.y - entry_tile.y).abs();
        let better = if proj > best_proj {
            true
        } else if proj == best_proj {
            dist < best_dist
        } else {
            false
        };

        if better {
            best = Some(t);
            best_proj = proj;
            best_dist = dist;
        }
    }

    best.or_else(|| nearest_tile_in_cluster(entry_tile, cluster))
}

fn side_dir_for_travel(traffic_cfg: &TrafficConfig, travel_dir: RoadDir) -> RoadDir {
    if travel_dir == RoadDir::None {
        return RoadDir::None;
    }
    if traffic_cfg.drive_on_right {
        travel_dir.right()
    } else {
        travel_dir.left()
    }
}

fn is_center_tile(pos: TilePos, bounds: (i32, i32, i32, i32)) -> bool {
    let (center_x0, center_x1, center_y0, center_y1) = bounds;
    pos.x >= center_x0 && pos.x <= center_x1 && pos.y >= center_y0 && pos.y <= center_y1
}

fn is_on_side(pos: TilePos, side_dir: RoadDir, bounds: (i32, i32, i32, i32)) -> bool {
    let (center_x0, center_x1, center_y0, center_y1) = bounds;
    match side_dir {
        RoadDir::East => pos.x >= center_x1,
        RoadDir::West => pos.x <= center_x0,
        RoadDir::North => pos.y >= center_y1,
        RoadDir::South => pos.y <= center_y0,
        RoadDir::None => true,
    }
}

fn dir_projection(pos: TilePos, dir: RoadDir) -> i32 {
    match dir {
        RoadDir::North => pos.y,
        RoadDir::South => -pos.y,
        RoadDir::East => pos.x,
        RoadDir::West => -pos.x,
        RoadDir::None => 0,
    }
}

/// Nearest cluster tile to a target coordinate (Manhattan distance).
fn nearest_tile_in_cluster(target: TilePos, cluster: &ClusterCache) -> Option<TilePos> {
    let mut best = None;
    let mut best_d = i32::MAX;
    for t in cluster.tiles.iter().copied() {
        let d = (t.x - target.x).abs() + (t.y - target.y).abs();
        if d < best_d {
            best = Some(t);
            best_d = d;
        }
    }
    best
}

/// Build a deterministic axis-first Manhattan path inside a cluster with a tile filter.
fn axis_first_path(
    start: TilePos,
    end: TilePos,
    preferred_dir: Option<RoadDir>,
    cluster: &ClusterCache,
    allowed: &dyn Fn(TilePos) -> bool,
) -> Option<Vec<TilePos>> {
    if start == end {
        return allowed(start).then_some(vec![start]);
    }
    if !allowed(start) || !allowed(end) {
        return None;
    }

    let primary = preferred_dir
        .and_then(primary_axis_for_dir)
        .unwrap_or(PrimaryAxis::X);
    let secondary = primary.other();

    if let Some(path) = axis_path_with_order(start, end, primary, cluster, allowed) {
        return Some(path);
    }
    axis_path_with_order(start, end, secondary, cluster, allowed)
}

/// Build a Manhattan path by moving along the first axis, then the other.
fn axis_path_with_order(
    start: TilePos,
    end: TilePos,
    first_axis: PrimaryAxis,
    cluster: &ClusterCache,
    allowed: &dyn Fn(TilePos) -> bool,
) -> Option<Vec<TilePos>> {
    let mut path = Vec::new();
    let mut cur = start;
    if !cluster.tiles_set.contains(&cur) || !allowed(cur) {
        return None;
    }
    path.push(cur);

    walk_axis(&mut cur, end, first_axis, cluster, allowed, &mut path)?;
    walk_axis(
        &mut cur,
        end,
        first_axis.other(),
        cluster,
        allowed,
        &mut path,
    )?;

    Some(path)
}

/// Walk along a single axis, appending intermediate tiles to the path.
fn walk_axis(
    cur: &mut TilePos,
    end: TilePos,
    axis: PrimaryAxis,
    cluster: &ClusterCache,
    allowed: &dyn Fn(TilePos) -> bool,
    path: &mut Vec<TilePos>,
) -> Option<()> {
    match axis {
        PrimaryAxis::X => {
            let step = (end.x - cur.x).signum();
            for _ in 0..(end.x - cur.x).abs() {
                cur.x += step;
                if !cluster.tiles_set.contains(cur) || !allowed(*cur) {
                    return None;
                }
                path.push(*cur);
            }
        }
        PrimaryAxis::Y => {
            let step = (end.y - cur.y).signum();
            for _ in 0..(end.y - cur.y).abs() {
                cur.y += step;
                if !cluster.tiles_set.contains(cur) || !allowed(*cur) {
                    return None;
                }
                path.push(*cur);
            }
        }
    }
    Some(())
}

/// Fallback BFS inside a filtered cluster (guarantees a path if the region is connected).
fn bfs_path(
    start: TilePos,
    end: TilePos,
    cluster: &ClusterCache,
    allowed: &dyn Fn(TilePos) -> bool,
) -> Option<Vec<TilePos>> {
    if start == end {
        return allowed(start).then_some(vec![start]);
    }
    if !cluster.tiles_set.contains(&start) || !cluster.tiles_set.contains(&end) {
        return None;
    }
    if !allowed(start) || !allowed(end) {
        return None;
    }

    let mut queue = VecDeque::new();
    let mut visited = HashSet::new();
    let mut prev = HashMap::new();
    queue.push_back(start);
    visited.insert(start);

    while let Some(cur) = queue.pop_front() {
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            let next = TilePos {
                x: cur.x + dx,
                y: cur.y + dy,
            };
            if !cluster.tiles_set.contains(&next) {
                continue;
            }
            if !allowed(next) {
                continue;
            }
            if !visited.insert(next) {
                continue;
            }
            prev.insert(next, cur);
            if next == end {
                return Some(reconstruct_path(start, end, &prev));
            }
            queue.push_back(next);
        }
    }

    None
}

/// Reconstruct a path from BFS predecessor links.
fn reconstruct_path(
    start: TilePos,
    end: TilePos,
    prev: &HashMap<TilePos, TilePos>,
) -> Vec<TilePos> {
    let mut path = vec![end];
    let mut cur = end;
    while cur != start {
        if let Some(p) = prev.get(&cur).copied() {
            path.push(p);
            cur = p;
        } else {
            break;
        }
    }
    path.reverse();
    path
}

/// Determine primary axis preference from a travel direction.
fn primary_axis_for_dir(dir: RoadDir) -> Option<PrimaryAxis> {
    match dir {
        RoadDir::North | RoadDir::South => Some(PrimaryAxis::Y),
        RoadDir::East | RoadDir::West => Some(PrimaryAxis::X),
        RoadDir::None => None,
    }
}

/// Axis used for deterministic Manhattan path ordering.
#[derive(Debug, Copy, Clone)]
enum PrimaryAxis {
    /// Horizontal axis (x).
    X,
    /// Vertical axis (y).
    Y,
}

impl PrimaryAxis {
    /// Return the other axis.
    fn other(self) -> Self {
        match self {
            PrimaryAxis::X => PrimaryAxis::Y,
            PrimaryAxis::Y => PrimaryAxis::X,
        }
    }
}

/// Compute center bounds for a cluster AABB (supports even sizes).
fn center_bounds(min: TilePos, max: TilePos) -> (i32, i32, i32, i32) {
    let w = max.x - min.x + 1;
    let h = max.y - min.y + 1;
    let center_x0 = min.x + (w - 1) / 2;
    let center_x1 = min.x + w / 2;
    let center_y0 = min.y + (h - 1) / 2;
    let center_y1 = min.y + h / 2;
    (center_x0, center_x1, center_y0, center_y1)
}

/// Intersection tile predicate (dir == None).
fn is_intersection_tile(grid: &MapGrid, pos: TilePos) -> bool {
    super::super::is_intersection_tile(grid, pos)
}
