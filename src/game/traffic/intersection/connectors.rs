use std::collections::{HashMap, HashSet};

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

/// For two-way two-lane roads, ensure the exit lane is on the correct side.
///
/// In right-hand traffic:
/// - When exiting North (dy=-1), we want the EAST lane (right side)
/// - When exiting South (dy=1), we want the WEST lane (right side)
/// - When exiting East (dx=1), we want the SOUTH lane (right side)
/// - When exiting West (dx=-1), we want the NORTH lane (right side)
fn ensure_correct_exit_lane(
    mut exit_lane_tile: TilePos,
    exit_dir: RoadDir,
    grid: &MapGrid,
    drive_on_right: bool,
) -> TilePos {
    if let Some(cell) = grid.get(exit_lane_tile) {
        if cell.road.is_some()
            && cell.road.flow == crate::game::roads::RoadFlow::TwoWay
            && cell.road.kind == crate::game::roads::RoadKind::TwoLane
        {
            // This is a two-way two-lane road - check if we're on correct side
            let travel_dir = exit_dir;
            let correct_side = if drive_on_right {
                travel_dir.right() // For right-hand traffic, correct lane is on the right
            } else {
                travel_dir.left() // For left-hand traffic, correct lane is on the left
            };

            // Check adjacent tile on the correct side
            let correct_side_tile = TilePos {
                x: exit_lane_tile.x + correct_side.delta().x,
                y: exit_lane_tile.y + correct_side.delta().y,
            };

            if let Some(correct_cell) = grid.get(correct_side_tile) {
                if correct_cell.road.is_some()
                    && correct_cell.road.dir == travel_dir
                    && correct_cell.road.flow == crate::game::roads::RoadFlow::TwoWay
                {
                    // Found correct lane - use it instead
                    exit_lane_tile = correct_side_tile;
                }
            }
        }
    }

    exit_lane_tile
}

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

        // CRITICAL: For two-way two-lane roads, ensure we exit on the correct lane
        // (right-hand traffic: exit lane should be on the right side of the road)
        let corrected_exit_lane_tile =
            ensure_correct_exit_lane(exit_lane_tile, exit_dir, grid, traffic_cfg.drive_on_right);

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

        let (next_idx, lane_changed) = append_corrected_exit_lane_suffix(
            &mut out,
            route,
            end,
            corrected_exit_lane_tile,
            exit_dir,
            grid,
        );
        if lane_changed {
            changed = true;
        }
        idx = next_idx;
    }

    if changed { Some(out) } else { None }
}

/// Replace a wrong post-intersection lane with corrected lane and, when possible,
/// keep the corrected offset for the immediate outgoing straight segment.
fn append_corrected_exit_lane_suffix(
    out: &mut Vec<TilePos>,
    route: &[TilePos],
    exit_lane_idx: usize,
    corrected_exit_lane: TilePos,
    exit_dir: RoadDir,
    grid: &MapGrid,
) -> (usize, bool) {
    let Some(&original_exit_lane) = route.get(exit_lane_idx) else {
        return (exit_lane_idx, false);
    };

    if corrected_exit_lane == original_exit_lane {
        out.push(original_exit_lane);
        return (exit_lane_idx + 1, false);
    }

    out.push(corrected_exit_lane);
    let mut changed = true;
    let offset_x = corrected_exit_lane.x - original_exit_lane.x;
    let offset_y = corrected_exit_lane.y - original_exit_lane.y;
    let mut prev = corrected_exit_lane;
    let mut idx = exit_lane_idx + 1;

    while idx < route.len() {
        let original = route[idx];
        if is_intersection_tile(grid, original) {
            break;
        }

        let Some(original_cell) = grid.get(original) else {
            break;
        };
        if !original_cell.road.is_some() {
            break;
        }

        let shifted = TilePos {
            x: original.x + offset_x,
            y: original.y + offset_y,
        };
        let Some(shifted_cell) = grid.get(shifted) else {
            break;
        };
        if !shifted_cell.road.is_some() || shifted_cell.road.dir != exit_dir {
            break;
        }
        if super::super::dir_between_adjacent(prev, shifted) == RoadDir::None {
            break;
        }

        out.push(shifted);
        prev = shifted;
        changed = true;
        idx += 1;
    }

    (idx, changed)
}

/// Build connector path through a cluster for a specific maneuver.
///
/// CRITICAL: This must follow real-world traffic rules:
/// - Straight: stay on right side through intersection
/// - Left turn: enter from left, cross center, exit on RIGHT lane (not oncoming!)
/// - Right turn: tight turn around corner, exit on right lane
fn build_connector_path(
    entry_tile: TilePos,
    exit_tile: TilePos,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
    cluster: &ClusterCache,
    traffic_cfg: &TrafficConfig,
) -> Option<(Vec<TilePos>, TilePos)> {
    let maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);

    // Build path based on maneuver type using simple geometry
    let connector = match maneuver {
        ManeuverKind::Straight => {
            // Simple straight path: just go from entry to exit
            build_simple_path(entry_tile, exit_tile, cluster)?
        }
        ManeuverKind::RightTurn => {
            // Right turn: via corner
            let anchor = corner_anchor(entry_tile, exit_tile, entry_dir);
            build_simple_path_via(entry_tile, anchor, exit_tile, cluster)?
        }
        ManeuverKind::LeftTurn => {
            // Left turn: via center, MUST exit on correct (rightmost) lane
            // This is CRITICAL - don't exit on oncoming lane!
            build_left_turn_connector_correct(
                entry_tile,
                exit_tile,
                exit_dir,
                cluster,
                traffic_cfg,
            )?
        }
        ManeuverKind::Other => {
            // U-turn or unknown - use fallback
            build_simple_path(entry_tile, exit_tile, cluster)?
        }
    };

    // Use center of intersection as anchor for visualization
    let anchor = center_anchor(cluster)?;

    Some((connector, anchor))
}

/// Build left turn connector that EXPLICITLY exits on the correct (rightmost) lane.
///
/// For right-hand traffic:
/// - When exiting North: use lane 0 (rightmost for North)
/// - When exiting South: use lane 0 (rightmost for South, which is east side)
/// - When exiting East: use lane 0 (rightmost for East, which is south side)
/// - When exiting West: use lane 0 (rightmost for West, which is north side)
fn build_left_turn_connector_correct(
    entry_tile: TilePos,
    exit_tile: TilePos,
    exit_dir: RoadDir,
    cluster: &ClusterCache,
    traffic_cfg: &TrafficConfig,
) -> Option<Vec<TilePos>> {
    let mut path = Vec::new();
    path.push(entry_tile);

    // Move to center of intersection
    let center_tile = center_anchor(cluster)?;

    // Entry → Center
    let mut cx = entry_tile.x;
    let mut cy = entry_tile.y;

    while cx != center_tile.x {
        let step = if center_tile.x > cx { 1 } else { -1 };
        cx += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }
    while cy != center_tile.y {
        let step = if center_tile.y > cy { 1 } else { -1 };
        cy += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }

    // Center → Exit: CRITICAL - must exit on correct lane!
    // For right-hand traffic, we want the rightmost lane for the exit direction
    // Find the correct exit tile by checking adjacent tiles
    let correct_exit =
        find_correct_exit_lane(exit_tile, exit_dir, cluster, traffic_cfg.drive_on_right);

    // Move from center to correct exit
    cx = center_tile.x;
    cy = center_tile.y;
    let ex = correct_exit.x;
    let ey = correct_exit.y;

    while cx != ex {
        let step = if ex > cx { 1 } else { -1 };
        cx += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }
    while cy != ey {
        let step = if ey > cy { 1 } else { -1 };
        cy += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }

    if path.last() != Some(&correct_exit) {
        path.push(correct_exit);
    }

    if path.len() < 2 { None } else { Some(path) }
}

/// Find the correct exit lane tile for a given exit direction.
/// For right-hand traffic, returns the rightmost lane for that direction.
fn find_correct_exit_lane(
    exit_tile: TilePos,
    exit_dir: RoadDir,
    cluster: &ClusterCache,
    drive_on_right: bool,
) -> TilePos {
    // Check adjacent tiles to find the correct lane
    // For right-hand traffic: we want the rightmost lane for exit_dir
    let right_side = if drive_on_right {
        exit_dir.right()
    } else {
        exit_dir.left()
    };

    // Check tile on the right side
    let right_tile = TilePos {
        x: exit_tile.x + right_side.delta().x,
        y: exit_tile.y + right_side.delta().y,
    };

    // If right tile is in cluster and has correct direction, use it
    if cluster.tiles_set.contains(&right_tile) {
        return right_tile;
    }

    // Otherwise use the original exit tile
    exit_tile
}

/// Build simple straight path from entry to exit.
fn build_simple_path(
    entry_tile: TilePos,
    exit_tile: TilePos,
    cluster: &ClusterCache,
) -> Option<Vec<TilePos>> {
    let mut path = Vec::new();
    path.push(entry_tile);

    let mut cx = entry_tile.x;
    let mut cy = entry_tile.y;
    let ex = exit_tile.x;
    let ey = exit_tile.y;

    // Move horizontally first
    while cx != ex {
        let step = if ex > cx { 1 } else { -1 };
        cx += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }
    // Then vertically
    while cy != ey {
        let step = if ey > cy { 1 } else { -1 };
        cy += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }

    if path.last() != Some(&exit_tile) {
        path.push(exit_tile);
    }

    if path.len() < 2 { None } else { Some(path) }
}

/// Build simple path via an intermediate point.
fn build_simple_path_via(
    entry_tile: TilePos,
    via_tile: TilePos,
    exit_tile: TilePos,
    cluster: &ClusterCache,
) -> Option<Vec<TilePos>> {
    let mut path = Vec::new();
    path.push(entry_tile);

    // Entry → Via
    let mut cx = entry_tile.x;
    let mut cy = entry_tile.y;
    let vx = via_tile.x;
    let vy = via_tile.y;

    while cx != vx {
        let step = if vx > cx { 1 } else { -1 };
        cx += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }
    while cy != vy {
        let step = if vy > cy { 1 } else { -1 };
        cy += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }

    // Via → Exit
    cx = via_tile.x;
    cy = via_tile.y;
    let ex = exit_tile.x;
    let ey = exit_tile.y;

    while cx != ex {
        let step = if ex > cx { 1 } else { -1 };
        cx += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }
    while cy != ey {
        let step = if ey > cy { 1 } else { -1 };
        cy += step;
        let next = TilePos { x: cx, y: cy };
        if cluster.tiles_set.contains(&next) && path.last() != Some(&next) {
            path.push(next);
        }
    }

    if path.last() != Some(&exit_tile) {
        path.push(exit_tile);
    }

    if path.len() < 2 { None } else { Some(path) }
}

/// Get the center tile of an intersection cluster.
fn center_anchor(cluster: &ClusterCache) -> Option<TilePos> {
    if cluster.tiles.is_empty() {
        return None;
    }

    let center_x = (cluster.aabb_min.x + cluster.aabb_max.x) / 2;
    let center_y = (cluster.aabb_min.y + cluster.aabb_max.y) / 2;

    // Find tile closest to center
    let mut best = cluster.tiles[0];
    let mut best_dist = i32::MAX;

    for &tile in &cluster.tiles {
        let dist = (tile.x - center_x).abs() + (tile.y - center_y).abs();
        if dist < best_dist {
            best = tile;
            best_dist = dist;
        }
    }

    Some(best)
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

/// Intersection tile predicate (dir == None).
fn is_intersection_tile(grid: &MapGrid, pos: TilePos) -> bool {
    super::super::is_intersection_tile(grid, pos)
}
