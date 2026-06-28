use std::collections::{HashMap, HashSet, VecDeque};

use bevy::prelude::*;

use crate::game::intersections::{IntersectionCluster, IntersectionId, IntersectionIndex};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadDir, RoadFlow};
use crate::game::traffic::{ManeuverKind, TrafficConfig, maneuver_kind};
use crate::game::transport::{GraphVersion, LaneGraph};

use super::conflict::ConflictMatrix;
use super::graph::{CrosswalkId, Lanelet, LaneletGraph, LaneletId};

/// Per-intersection conflict matrices built by `build_lanelet_graph`.
#[derive(Resource, Default)]
pub struct LaneletConflictMatrices {
    pub by_intersection: HashMap<IntersectionId, ConflictMatrix>,
    /// Per-intersection crosswalk sides, in emission order: index `i` here is matrix row
    /// `crosswalk_base() + i`. The arbiter maps a pedestrian crossing axis to crosswalk row bits.
    pub crosswalk_sides: HashMap<IntersectionId, Vec<RoadDir>>,
    pub version: u64,
}

/// Whether an approach lane of `lane_type` may feed a lanelet of `maneuver`. Encodes lane
/// discipline: turn-only lanes feed only their designated turn (LeftTurnOnly also permits U-turn
/// per ПДД 8.5 крайнее левое); a Regular lane feeds every legal maneuver because on a
/// single-lane-per-direction road it IS the крайнее левое and must permit left + U-turn.
/// `_dir` is the approach travel direction (reserved for future per-lane positional refinement).
/// `_drive_on_right` is kept in the signature for caller/future-arm use; symmetry is now encoded
/// in `maneuver_kind` which already swaps near/far by traffic handedness.
pub(crate) fn lane_allows_maneuver(
    lane_type: LaneType,
    maneuver: ManeuverKind,
    _dir: RoadDir,
    _drive_on_right: bool,
) -> bool {
    match lane_type {
        LaneType::LeftTurnOnly => {
            matches!(maneuver, ManeuverKind::LeftTurn | ManeuverKind::UTurn)
        }
        LaneType::RightTurnOnly => matches!(maneuver, ManeuverKind::RightTurn),
        LaneType::StraightOnly => matches!(maneuver, ManeuverKind::Straight),
        // A Regular lane serves every legal maneuver. On a single-lane-per-direction road this
        // lane IS the крайнее левое (ПДД 8.5), so it must permit left + U-turn; on a multi-lane
        // road autogen dedicates turn-only lanes and the leftover Regular lanes stay permissive.
        LaneType::Regular => match maneuver {
            ManeuverKind::Straight
            | ManeuverKind::RightTurn
            | ManeuverKind::LeftTurn
            | ManeuverKind::UTurn => true,
            ManeuverKind::Other => false,
        },
    }
}

/// Lane-faithful strictly-4-adjacent path through `cluster_tiles`, routed as an ARC around the
/// intersection's geometric **center point** `C` — the continuous-float center of the box's
/// tile-center cloud (the vertex where the box tiles meet, NOT a tile). Straights take the direct
/// in-box path. Turns walk the 4-adjacent box tiles from `entry_tile` to `goal` advancing
/// monotonically around `C`, picking the rotational sense by maneuver:
/// - **RightTurn**: the SHORT arc — hugs the near corner, `C` stays outside (ПДД 8.6 «ближе к правому краю»).
/// - **LeftTurn**: the LONG arc — swings past `C` so the center is enclosed (around, not corner-cut).
/// - **UTurn**: the long (~270°) arc around `C`.
///
/// Handedness: the maneuver classification already swaps near/far by `drive_on_right`
/// (`maneuver_kind`), so the arc sense follows the maneuver and stays correct under left-hand traffic.
/// Exit-lane correctness is guaranteed by the caller (it only offers away-pointing exit tiles), so
/// any returned path lands on a non-oncoming lane.
///
/// Returns tile sequence (entry_tile .. goal), all inside the cluster, consecutive pairs
/// Manhattan-distance 1, SIMPLE (no revisited tile). `None` if no path exists or `maneuver == Other`.
/// Degenerate geometry (goal not in the cluster, or the angular walk dead-ends) falls back to the
/// shortest BFS path to a tile adjacent to the exit.
///
/// `centroid` is retained in the signature for caller compatibility but unused: the pivot is now the
/// box's true float center, not the integer centroid tile.
pub(crate) fn build_internal_path(
    cluster_tiles: &HashSet<TilePos>,
    centroid: TilePos,
    entry_tile: TilePos,
    entry_dir: RoadDir,
    exit_tile: TilePos,
    exit_dir: RoadDir,
    maneuver: ManeuverKind,
) -> Option<Vec<TilePos>> {
    let _ = (centroid, entry_dir); // pivot is the float center; direction encoded in the maneuver.
    if !cluster_tiles.contains(&entry_tile) {
        return None;
    }
    let xd = exit_dir.delta();
    let goal = TilePos {
        x: exit_tile.x - xd.x,
        y: exit_tile.y - xd.y,
    };
    if !cluster_tiles.contains(&goal) {
        // Degenerate geometry: fall back to the shortest path to a tile adjacent to the exit.
        return build_internal_path_bfs(cluster_tiles, entry_tile, exit_tile);
    }
    match maneuver {
        ManeuverKind::Straight => bfs_within(cluster_tiles, entry_tile, goal),
        ManeuverKind::RightTurn | ManeuverKind::LeftTurn | ManeuverKind::UTurn => {
            let center = box_center_point(cluster_tiles);
            let want_long = matches!(maneuver, ManeuverKind::LeftTurn | ManeuverKind::UTurn);
            arc_around_center(cluster_tiles, center, entry_tile, goal, want_long)
                // Pathological geometry where the angular walk can't reach the goal: degrade to a
                // shortest in-box path rather than emit nothing (still collision-safe — any in-box
                // path is safe), so the lanelet still builds.
                .or_else(|| build_internal_path_bfs(cluster_tiles, entry_tile, exit_tile))
        }
        ManeuverKind::Other => None,
    }
}

/// Geometric center point of the box: the mean of the tile **centers** (`(x+0.5, y+0.5)`), a
/// continuous float. For an N×N box this lands on the vertex where the central tiles meet (e.g. the
/// 2×2 `{(4,4),(4,5),(5,4),(5,5)}` → `(5.0, 5.0)`), NOT a tile center.
fn box_center_point(cluster_tiles: &HashSet<TilePos>) -> (f64, f64) {
    let n = cluster_tiles.len().max(1) as f64;
    let (mut sx, mut sy) = (0.0f64, 0.0f64);
    for t in cluster_tiles {
        sx += t.x as f64 + 0.5;
        sy += t.y as f64 + 0.5;
    }
    (sx / n, sy / n)
}

/// Angle of a tile's center about the center point `c` (radians, `atan2`).
fn angle_about(t: TilePos, c: (f64, f64)) -> f64 {
    ((t.y as f64 + 0.5) - c.1).atan2((t.x as f64 + 0.5) - c.0)
}

/// CCW angular travel from `a` to `b`, normalized to `[0, 2π)`.
fn ccw_span(a: f64, b: f64) -> f64 {
    let two_pi = std::f64::consts::TAU;
    let mut d = b - a;
    while d < -1e-9 {
        d += two_pi;
    }
    while d >= two_pi - 1e-9 {
        d -= two_pi;
    }
    d
}

/// Walk 4-adjacent in-box tiles from `entry` to `goal` as an arc around center point `c`.
///
/// Direction is chosen so the arc from `entry` to `goal` is the SHORT way (right turn) or the LONG
/// way (left / U-turn), selected by `want_long`. The walk is greedy-monotonic: at each tile it steps
/// to the unvisited in-box neighbor that advances the LEAST (but strictly positive) in the chosen
/// rotational direction — hugging the arc — with a deterministic `(x, y)` tiebreak. Produces a
/// SIMPLE path (visited set forbids revisits). `None` if it dead-ends before reaching `goal`.
fn arc_around_center(
    cluster_tiles: &HashSet<TilePos>,
    c: (f64, f64),
    entry: TilePos,
    goal: TilePos,
    want_long: bool,
) -> Option<Vec<TilePos>> {
    if entry == goal {
        return Some(vec![entry]);
    }
    let ea = angle_about(entry, c);
    let ga = angle_about(goal, c);
    let span_ccw = ccw_span(ea, ga);
    let span_cw = std::f64::consts::TAU - span_ccw;
    // want_long => take the longer arc; else the shorter. CCW iff its span matches the wanted length.
    let ccw = if want_long {
        span_ccw >= span_cw
    } else {
        span_ccw <= span_cw
    };

    let mut path = vec![entry];
    let mut visited: HashSet<TilePos> = HashSet::new();
    visited.insert(entry);
    let mut cur = entry;
    let mut cur_ang = ea;
    let cap = cluster_tiles.len() + 2;
    while cur != goal {
        if path.len() > cap {
            return None;
        }
        let mut best: Option<(f64, i32, i32, TilePos, f64)> = None;
        for d in [
            IVec2::new(-1, 0),
            IVec2::new(1, 0),
            IVec2::new(0, -1),
            IVec2::new(0, 1),
        ] {
            let n = TilePos {
                x: cur.x + d.x,
                y: cur.y + d.y,
            };
            if !cluster_tiles.contains(&n) || visited.contains(&n) {
                continue;
            }
            let na = angle_about(n, c);
            let mut adv = if ccw {
                ccw_span(cur_ang, na)
            } else {
                ccw_span(na, cur_ang)
            };
            // Forbid zero/backward advance: deprioritize by pushing past a full turn so a genuine
            // forward step (if any) always wins.
            if adv <= 1e-9 {
                adv += std::f64::consts::TAU;
            }
            let key = (adv, n.x, n.y, n, na);
            match &best {
                Some((ba, bx, by, _, _)) if (*ba, *bx, *by) <= (key.0, key.1, key.2) => {}
                _ => best = Some(key),
            }
        }
        let (_, _, _, next, na) = best?;
        cur = next;
        cur_ang = na;
        visited.insert(cur);
        path.push(cur);
    }
    Some(path)
}

/// Shortest strictly-4-adjacent path between two in-cluster tiles (inclusive of both endpoints).
/// Deterministic: neighbors visited W,E,S,N; equal-cost ties broken by insertion order.
fn bfs_within(
    cluster_tiles: &HashSet<TilePos>,
    from: TilePos,
    to: TilePos,
) -> Option<Vec<TilePos>> {
    if from == to {
        return Some(vec![from]);
    }
    let mut prev: HashMap<TilePos, TilePos> = HashMap::new();
    let mut q: VecDeque<TilePos> = VecDeque::new();
    let mut seen: HashSet<TilePos> = HashSet::new();
    q.push_back(from);
    seen.insert(from);
    while let Some(cur) = q.pop_front() {
        for d in [
            IVec2::new(-1, 0),
            IVec2::new(1, 0),
            IVec2::new(0, -1),
            IVec2::new(0, 1),
        ] {
            let n = TilePos {
                x: cur.x + d.x,
                y: cur.y + d.y,
            };
            if !cluster_tiles.contains(&n) || !seen.insert(n) {
                continue;
            }
            prev.insert(n, cur);
            if n == to {
                // Reconstruct.
                let mut path = vec![to];
                let mut step = to;
                while let Some(&p) = prev.get(&step) {
                    path.push(p);
                    step = p;
                    if p == from {
                        break;
                    }
                }
                path.reverse();
                return Some(path);
            }
            q.push_back(n);
        }
    }
    None
}

/// BFS fallback: shortest strictly-4-adjacent path inside `cluster_tiles` from `entry_tile`
/// to the cluster tile orthogonally adjacent to `exit_tile`. Among equidistant goals picks
/// `(x,y)`-minimum deterministically.
pub(crate) fn build_internal_path_bfs(
    cluster_tiles: &HashSet<TilePos>,
    entry_tile: TilePos,
    exit_tile: TilePos,
) -> Option<Vec<TilePos>> {
    if !cluster_tiles.contains(&entry_tile) {
        return None;
    }

    let neighbors_of_exit = orthogonal_neighbors(exit_tile);
    let goals: HashSet<TilePos> = neighbors_of_exit
        .into_iter()
        .filter(|t| cluster_tiles.contains(t))
        .collect();

    if goals.is_empty() {
        return None;
    }

    let mut came_from: HashMap<TilePos, Option<TilePos>> = HashMap::new();
    let mut dist: HashMap<TilePos, u32> = HashMap::new();
    let mut queue: VecDeque<TilePos> = VecDeque::new();

    came_from.insert(entry_tile, None);
    dist.insert(entry_tile, 0);
    queue.push_back(entry_tile);

    const DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

    while let Some(cur) = queue.pop_front() {
        for (dx, dy) in DIRS {
            let nb = TilePos {
                x: cur.x + dx,
                y: cur.y + dy,
            };
            if cluster_tiles.contains(&nb) && !came_from.contains_key(&nb) {
                came_from.insert(nb, Some(cur));
                dist.insert(nb, dist[&cur] + 1);
                queue.push_back(nb);
            }
        }
    }

    let best_goal = goals
        .iter()
        .filter(|g| dist.contains_key(g))
        .min_by_key(|g| (dist[g], g.x, g.y))?;

    Some(reconstruct(*best_goal, &came_from))
}

fn orthogonal_neighbors(t: TilePos) -> [TilePos; 4] {
    [
        TilePos { x: t.x + 1, y: t.y },
        TilePos { x: t.x - 1, y: t.y },
        TilePos { x: t.x, y: t.y + 1 },
        TilePos { x: t.x, y: t.y - 1 },
    ]
}

fn reconstruct(goal: TilePos, came_from: &HashMap<TilePos, Option<TilePos>>) -> Vec<TilePos> {
    let mut path = Vec::new();
    let mut cur = goal;
    loop {
        path.push(cur);
        match came_from[&cur] {
            None => break,
            Some(prev) => cur = prev,
        }
    }
    path.reverse();
    path
}

/// Derive the pedestrian crosswalk cells for a cluster: one crosswalk per cluster side that has an
/// adjacent road, each being the set of cluster-boundary cells facing that side (the cells a
/// pedestrian crossing that approach road occupies, and that an entering/exiting vehicle's internal
/// path passes through). Deterministic: sides scanned in `[West, East, South, North]` order, cells
/// sorted by `(x, y)`, `CrosswalkId` assigned by emission order. A side with no adjacent road is
/// skipped (no crosswalk emitted). Each entry carries the cluster side (`RoadDir`) it faces, so the
/// arbiter can map a pedestrian crossing axis to the crosswalks they occupy.
pub(crate) fn crosswalk_cells(
    cluster: &IntersectionCluster,
    grid: &MapGrid,
) -> Vec<(CrosswalkId, RoadDir, Vec<TilePos>)> {
    let cluster_tiles: HashSet<TilePos> = cluster.tiles.iter().copied().collect();
    let mut out: Vec<(CrosswalkId, RoadDir, Vec<TilePos>)> = Vec::new();

    for side in [RoadDir::West, RoadDir::East, RoadDir::South, RoadDir::North] {
        let d = side.delta();
        let mut cells: Vec<TilePos> = Vec::new();
        for &t in &cluster.tiles {
            let n = TilePos {
                x: t.x + d.x,
                y: t.y + d.y,
            };
            if cluster_tiles.contains(&n) {
                continue;
            }
            let Some(ncell) = grid.get(n) else {
                continue;
            };
            // Intentionally NOT the strict mirror of the lanelet entry/exit predicate: we omit the
            // one-way wrong-way skip. A pedestrian crosses the full physical roadway on this side
            // regardless of the road's flow direction, so any road-bearing tile counts.
            if ncell.water || !ncell.road.is_some() || ncell.road.dir == RoadDir::None {
                continue;
            }
            cells.push(t);
        }
        if cells.is_empty() {
            continue;
        }
        cells.sort_unstable_by_key(|p| (p.x, p.y));
        out.push((CrosswalkId(out.len() as u32), side, cells));
    }

    out
}

/// Build (or rebuild) the lanelet graph and per-intersection conflict matrices from the current
/// map state.
///
/// Early-returns if the graph is already built for the current `GraphVersion`.
pub fn build_lanelet_graph(
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    lanes: Res<LaneGraph>,
    gv: Res<GraphVersion>,
    traffic_cfg: Res<TrafficConfig>,
    mut graph: ResMut<LaneletGraph>,
    mut matrices: ResMut<LaneletConflictMatrices>,
) {
    if graph.is_built_for(gv.0) {
        return;
    }

    graph.lanelets.clear();
    graph.by_intersection.clear();
    graph.by_entry_lane.clear();
    matrices.by_intersection.clear();
    matrices.crosswalk_sides.clear();

    // Enumerate clusters in Vec order (== IntersectionId order per build_intersection_clusters).
    for cluster in &intersections.clusters {
        let cluster_tiles: HashSet<TilePos> = cluster.tiles.iter().copied().collect();

        // Collect approach (entry) and exit lane tiles adjacent to this cluster.
        //
        // entry_tiles: (approach_lane_pos, first_cluster_tile, entry_dir, lane_type)
        //   approach_lane_pos: the non-cluster tile with dir pointing into cluster
        //   first_cluster_tile: the cluster tile that approach_lane_pos points to (used as BFS start)
        //
        // exit_tiles: (exit_lane_pos, exit_dir)
        //   exit_lane_pos: the non-cluster tile pointing away from cluster (used as BFS goal target)
        let mut entry_tiles: Vec<(TilePos, TilePos, RoadDir, LaneType)> = Vec::new();
        let mut exit_tiles: Vec<(TilePos, RoadDir)> = Vec::new();

        for &t in &cluster.tiles {
            for neighbor_dir in [RoadDir::West, RoadDir::East, RoadDir::South, RoadDir::North] {
                let d = neighbor_dir.delta();
                let npos = TilePos {
                    x: t.x + d.x,
                    y: t.y + d.y,
                };
                let Some(ncell) = grid.get(npos) else {
                    continue;
                };
                if ncell.water || !ncell.road.is_some() || ncell.road.dir == RoadDir::None {
                    continue;
                }
                // Skip wrong-way tiles on one-way roads.
                if let RoadFlow::OneWay(one_way_dir) = ncell.road.flow
                    && ncell.road.dir != one_way_dir
                {
                    continue;
                }
                // Already in cluster? Skip (cluster tiles have dir==None).
                if cluster_tiles.contains(&npos) {
                    continue;
                }

                let lane_dir = ncell.road.dir;
                let lane_delta = lane_dir.delta();
                let fwd = TilePos {
                    x: npos.x + lane_delta.x,
                    y: npos.y + lane_delta.y,
                };
                let back = TilePos {
                    x: npos.x - lane_delta.x,
                    y: npos.y - lane_delta.y,
                };

                if cluster_tiles.contains(&fwd) {
                    // Lane points into the cluster: approach lane.
                    // `fwd` is the first cluster tile; BFS starts there.
                    entry_tiles.push((npos, fwd, lane_dir, ncell.road.lane_type));
                } else if cluster_tiles.contains(&back) {
                    // Cluster is behind this lane: exit lane.
                    exit_tiles.push((npos, lane_dir));
                }
            }
        }

        // Deduplicate (multiple cluster tiles may see the same neighbor).
        entry_tiles.sort_unstable_by_key(|e| (e.0.x, e.0.y));
        entry_tiles.dedup_by_key(|e| e.0);
        exit_tiles.sort_unstable_by_key(|e| (e.0.x, e.0.y));
        exit_tiles.dedup_by_key(|e| e.0);

        // Enumerate legal (entry, exit) pairs and build lanelets.
        let mut cluster_lanelets: Vec<Lanelet> = Vec::new();
        let mut cluster_paths: Vec<Vec<TilePos>> = Vec::new();

        for &(approach_tile, first_cluster_tile, entry_dir, lane_type) in &entry_tiles {
            let Some(entry_lane_id) = lanes.pos_to_id.get(&approach_tile).copied() else {
                continue;
            };
            for &(exit_tile, exit_dir) in &exit_tiles {
                let Some(exit_lane_id) = lanes.pos_to_id.get(&exit_tile).copied() else {
                    continue;
                };
                // Don't connect a lane to itself.
                if entry_lane_id == exit_lane_id {
                    continue;
                }

                let maneuver = maneuver_kind(&traffic_cfg, entry_dir, exit_dir);
                if !lane_allows_maneuver(lane_type, maneuver, entry_dir, traffic_cfg.drive_on_right)
                {
                    continue;
                }

                let Some(internal_path) = build_internal_path(
                    &cluster_tiles,
                    cluster.centroid_tile,
                    first_cluster_tile,
                    entry_dir,
                    exit_tile,
                    exit_dir,
                    maneuver,
                ) else {
                    continue;
                };

                cluster_lanelets.push(Lanelet {
                    id: LaneletId(0), // Will be set after sorting.
                    intersection: cluster.id,
                    entry_lane: entry_lane_id,
                    exit_lane: exit_lane_id,
                    maneuver,
                    internal_path: internal_path.clone(),
                });
                cluster_paths.push(internal_path);
            }
        }

        // Sort by (entry_lane.0, exit_lane.0) for determinism.
        // Zip with paths to keep them aligned.
        let mut indexed: Vec<(Lanelet, Vec<TilePos>)> =
            cluster_lanelets.into_iter().zip(cluster_paths).collect();
        indexed.sort_by_key(|(l, _)| (l.entry_lane.0, l.exit_lane.0));

        // Assign stable global ids and register.
        let mut intersection_ids: Vec<LaneletId> = Vec::new();
        let sorted_paths: Vec<Vec<TilePos>> = indexed.iter().map(|(_, p)| p.clone()).collect();

        for (mut lanelet, _) in indexed {
            lanelet.id = LaneletId(graph.lanelets.len() as u32);
            intersection_ids.push(lanelet.id);
            graph
                .by_entry_lane
                .entry(lanelet.entry_lane)
                .or_default()
                .push(lanelet.id);
            graph.lanelets.push(lanelet);
        }

        graph.by_intersection.insert(cluster.id, intersection_ids);

        // Pedestrian crosswalks become first-class conflict rows appended after the vehicle
        // lanelets, so a maneuver that crosses a crosswalk conflicts with it (row-activation in P3b).
        let crosswalks = crosswalk_cells(cluster, &grid);
        let crosswalk_sides: Vec<RoadDir> = crosswalks.iter().map(|(_, side, _)| *side).collect();
        let crosswalk_paths: Vec<Vec<TilePos>> =
            crosswalks.into_iter().map(|(_, _, cells)| cells).collect();
        let matrix = ConflictMatrix::from_paths_with_crosswalks(&sorted_paths, &crosswalk_paths);
        matrices.by_intersection.insert(cluster.id, matrix);
        matrices.crosswalk_sides.insert(cluster.id, crosswalk_sides);
    }

    graph.version = gv.0;
    matrices.version = gv.0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::intersections::{IntersectionCluster, IntersectionId, IntersectionKey};
    use crate::game::map::MapGrid;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::transport::lane_graph::build_lane_graph_inner;
    use bevy::app::App;

    /// Render a box + path as an ASCII grid (north up): path tiles show their step index, other box
    /// tiles `.`, non-box ` `. Used in the geometry tests so a human reading the test SEES the arc.
    fn ascii_path(cluster: &HashSet<TilePos>, path: &[TilePos]) -> String {
        use std::collections::HashMap;
        let idx: HashMap<TilePos, usize> = path.iter().enumerate().map(|(i, &t)| (t, i)).collect();
        let min_x = cluster.iter().map(|t| t.x).min().unwrap_or(0);
        let max_x = cluster.iter().map(|t| t.x).max().unwrap_or(0);
        let min_y = cluster.iter().map(|t| t.y).min().unwrap_or(0);
        let max_y = cluster.iter().map(|t| t.y).max().unwrap_or(0);
        let mut s = String::from("\n");
        for y in (min_y..=max_y).rev() {
            for x in min_x..=max_x {
                let t = TilePos { x, y };
                if let Some(i) = idx.get(&t) {
                    s.push_str(&format!("{i:>2} "));
                } else if cluster.contains(&t) {
                    s.push_str(" . ");
                } else {
                    s.push_str("   ");
                }
            }
            s.push('\n');
        }
        s
    }

    fn make_key(tiles: &[TilePos]) -> IntersectionKey {
        let min_x = tiles.iter().map(|t| t.x).min().unwrap_or(0);
        let min_y = tiles.iter().map(|t| t.y).min().unwrap_or(0);
        let max_x = tiles.iter().map(|t| t.x).max().unwrap_or(0);
        let max_y = tiles.iter().map(|t| t.y).max().unwrap_or(0);
        let mut hash = 0u64;
        for t in tiles {
            hash = hash.wrapping_mul(31).wrapping_add(t.x as u64);
            hash = hash.wrapping_mul(31).wrapping_add(t.y as u64);
        }
        IntersectionKey {
            aabb_min: TilePos { x: min_x, y: min_y },
            aabb_max: TilePos { x: max_x, y: max_y },
            tile_count: tiles.len() as u32,
            tiles_hash: hash,
        }
    }

    fn set_road_tile(grid: &mut MapGrid, pos: TilePos, dir: RoadDir) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
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

    fn set_intersection_tile(grid: &mut MapGrid, pos: TilePos) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::None,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    /// Build a 9x9 grid with a 2x2 cluster at (4,4),(4,5),(5,4),(5,5).
    ///
    /// Lanes (tile-per-direction model):
    ///   Eastbound  row y=4: (0..3,4) approach, (6..8,4) exit
    ///   Westbound  row y=5: (6..8,5) approach, (0..3,5) exit
    ///   Northbound col x=4: (4,0..3) approach, (4,6..8) exit
    ///   Southbound col x=5: (5,6..8) approach, (5,0..3) exit
    fn build_cross_grid() -> (MapGrid, IntersectionIndex) {
        let mut grid = MapGrid::new(9, 9);

        // 2x2 cluster tiles.
        for pos in [
            TilePos { x: 4, y: 4 },
            TilePos { x: 4, y: 5 },
            TilePos { x: 5, y: 4 },
            TilePos { x: 5, y: 5 },
        ] {
            set_intersection_tile(&mut grid, pos);
        }

        // Eastbound row y=4: approaches from left, exits to right.
        for x in 0..4 {
            set_road_tile(&mut grid, TilePos { x, y: 4 }, RoadDir::East);
        }
        for x in 6..9 {
            set_road_tile(&mut grid, TilePos { x, y: 4 }, RoadDir::East);
        }

        // Westbound row y=5: approaches from right, exits to left.
        for x in 6..9 {
            set_road_tile(&mut grid, TilePos { x, y: 5 }, RoadDir::West);
        }
        for x in 0..4 {
            set_road_tile(&mut grid, TilePos { x, y: 5 }, RoadDir::West);
        }

        // Northbound col x=4: approaches from bottom, exits to top.
        for y in 0..4 {
            set_road_tile(&mut grid, TilePos { x: 4, y }, RoadDir::North);
        }
        for y in 6..9 {
            set_road_tile(&mut grid, TilePos { x: 4, y }, RoadDir::North);
        }

        // Southbound col x=5: approaches from top, exits to bottom.
        for y in 6..9 {
            set_road_tile(&mut grid, TilePos { x: 5, y }, RoadDir::South);
        }
        for y in 0..4 {
            set_road_tile(&mut grid, TilePos { x: 5, y }, RoadDir::South);
        }

        // IntersectionIndex with one 2x2 cluster.
        let cluster_tiles: Vec<TilePos> = vec![
            TilePos { x: 4, y: 4 },
            TilePos { x: 4, y: 5 },
            TilePos { x: 5, y: 4 },
            TilePos { x: 5, y: 5 },
        ];
        let id = IntersectionId(0);
        let key = make_key(&cluster_tiles);
        let cluster = IntersectionCluster {
            id,
            key,
            tiles: cluster_tiles.clone(),
            aabb_min: TilePos { x: 4, y: 4 },
            aabb_max: TilePos { x: 5, y: 5 },
            centroid_tile: TilePos { x: 4, y: 4 },
        };

        let mut tile_to_intersection = HashMap::new();
        for &t in &cluster_tiles {
            tile_to_intersection.insert(t, id);
        }

        let index = IntersectionIndex {
            clusters: vec![cluster],
            tile_to_intersection,
            version: 1,
            ..Default::default()
        };

        (grid, index)
    }

    /// Build a 12x12 grid with a 4x4 cluster at x,y in 4..=7.
    ///
    /// Two lanes per direction (lane-tile model, one tile per lane):
    ///   Eastbound  rows y=4,y=5 : (0..3,y) approach, (8..11,y) exit
    ///   Westbound  rows y=6,y=7 : (8..11,y) approach, (0..3,y) exit
    ///   Northbound cols x=4,x=5 : (x,0..3) approach, (x,8..11) exit
    ///   Southbound cols x=6,x=7 : (x,8..11) approach, (x,0..3) exit
    fn build_two_lane_cross_grid() -> (MapGrid, IntersectionIndex) {
        let mut grid = MapGrid::new(12, 12);

        let cluster_tiles: Vec<TilePos> = (4..=7)
            .flat_map(|x| (4..=7).map(move |y| TilePos { x, y }))
            .collect();
        for &pos in &cluster_tiles {
            set_intersection_tile(&mut grid, pos);
        }

        for y in [4, 5] {
            for x in 0..4 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::East);
            }
            for x in 8..12 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::East);
            }
        }
        for y in [6, 7] {
            for x in 8..12 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::West);
            }
            for x in 0..4 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::West);
            }
        }
        for x in [4, 5] {
            for y in 0..4 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::North);
            }
            for y in 8..12 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::North);
            }
        }
        for x in [6, 7] {
            for y in 8..12 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::South);
            }
            for y in 0..4 {
                set_road_tile(&mut grid, TilePos { x, y }, RoadDir::South);
            }
        }

        let id = IntersectionId(0);
        let key = make_key(&cluster_tiles);
        let cluster = IntersectionCluster {
            id,
            key,
            tiles: cluster_tiles.clone(),
            aabb_min: TilePos { x: 4, y: 4 },
            aabb_max: TilePos { x: 7, y: 7 },
            centroid_tile: TilePos { x: 4, y: 4 },
        };

        let mut tile_to_intersection = HashMap::new();
        for &t in &cluster_tiles {
            tile_to_intersection.insert(t, id);
        }

        let index = IntersectionIndex {
            clusters: vec![cluster],
            tile_to_intersection,
            version: 1,
            ..Default::default()
        };

        (grid, index)
    }

    #[test]
    fn centroid_router_left_turn_arcs_around_center_not_through_it() {
        use crate::game::map::TilePos;
        use crate::game::roads::RoadDir;
        use crate::game::traffic::ManeuverKind;
        // 3x3 box x,y in 4..=6. Center POINT C = mean of tile centers = (5.5, 5.5) — the vertex
        // between the four upper-right tiles, NOT the center tile (5,5). A left turn now swings the
        // LONG way AROUND C, so it must NOT pass through the center tile (5,5) (that would be a
        // corner-cut through the middle); it encloses C by hugging the far perimeter.
        let cluster: HashSet<TilePos> = (4..=6)
            .flat_map(|x| (4..=6).map(move |y| TilePos { x, y }))
            .collect();
        let centroid = TilePos { x: 5, y: 5 };
        // Eastbound entering at (4,4), turning left (North = +y here) and exiting onto the west
        // column's north lane: exit_tile (4,7), exit_dir North -> goal (4,6). East->North is a
        // left turn under right-hand traffic (entry.left() == North).
        let path = build_internal_path(
            &cluster,
            centroid,
            TilePos { x: 4, y: 4 },
            RoadDir::East,
            TilePos { x: 4, y: 7 },
            RoadDir::North,
            ManeuverKind::LeftTurn,
        )
        .expect("left path exists");
        assert_eq!(
            path.first().copied(),
            Some(TilePos { x: 4, y: 4 }),
            "starts at entry tile"
        );
        for w in path.windows(2) {
            let d = (w[0].x - w[1].x).abs() + (w[0].y - w[1].y).abs();
            assert_eq!(d, 1, "consecutive tiles 4-adjacent: {:?}->{:?}", w[0], w[1]);
        }
        for t in &path {
            assert!(cluster.contains(t), "every tile inside cluster: {t:?}");
        }
        // SIMPLE: no revisited tile.
        let uniq: HashSet<TilePos> = path.iter().copied().collect();
        assert_eq!(uniq.len(), path.len(), "path must be simple: {path:?}");
        // The wide left arc goes AROUND C, not through the middle tile (5,5).
        assert!(
            !path.contains(&TilePos { x: 5, y: 5 }),
            "left arc must swing around C, not cut through the center tile: {path:?}"
        );
        // The exact wide arc (CCW long way around C): up the entry column, across the far edge.
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 5, y: 4 },
                TilePos { x: 6, y: 4 },
                TilePos { x: 6, y: 5 },
                TilePos { x: 6, y: 6 },
                TilePos { x: 5, y: 6 },
                TilePos { x: 4, y: 6 },
            ],
            "left arc tiles: {}",
            ascii_path(&cluster, &path)
        );
        // Ends on the tile adjacent to (and feeding) the exit lane.
        assert_eq!(
            *path.last().unwrap(),
            TilePos { x: 4, y: 6 },
            "ends at goal"
        );
    }

    #[test]
    fn centroid_router_straight_is_direct() {
        use crate::game::map::TilePos;
        use crate::game::roads::RoadDir;
        use crate::game::traffic::ManeuverKind;
        let cluster: HashSet<TilePos> = [
            TilePos { x: 4, y: 4 },
            TilePos { x: 5, y: 4 },
            TilePos { x: 4, y: 5 },
            TilePos { x: 5, y: 5 },
        ]
        .into_iter()
        .collect();
        // Eastbound straight through the 2x2 box: enter (4,4), exit_tile (6,4) East -> goal (5,4).
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            TilePos { x: 4, y: 4 },
            RoadDir::East,
            TilePos { x: 6, y: 4 },
            RoadDir::East,
            ManeuverKind::Straight,
        )
        .expect("straight path");
        assert_eq!(
            path,
            vec![TilePos { x: 4, y: 4 }, TilePos { x: 5, y: 4 }],
            "straight takes the direct 2-tile in-box path"
        );
    }

    #[test]
    fn internal_path_is_strictly_4_adjacent_never_diagonal() {
        // Westbound straight: entry from east side, exit to west side on same row.
        // L-path stays on y=64 (no bend for straight).
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 30, y: 64 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 31, y: 61 },
            entry,
            RoadDir::West,
            exit,
            RoadDir::West,
            ManeuverKind::Straight,
        )
        .expect("path exists");
        assert!(path.len() >= 2);
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1, "non-orthogonal step {:?}->{:?}", w[0], w[1]);
        }
        assert!(
            path.iter().all(|t| cluster.contains(t)),
            "path stays inside the cluster"
        );
        assert_eq!(path[0], entry);
        // Straight L-path stays on row 64.
        assert!(
            path.iter().all(|t| t.y == 64),
            "straight westbound path must stay on y=64"
        );
    }

    #[test]
    fn turn_shape_left_arcs_around_center_ends_adjacent_to_south_exit() {
        // Westbound entry, southbound exit is a LEFT turn (West->South == entry.left()), so the
        // path swings the LONG way AROUND the box center point, not through it.
        // exit_dir=South means delta=(0,-1); goal = {x:32, y:60} - (0,-1) = {x:32, y:61}.
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let centroid = TilePos { x: 32, y: 63 };
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 32, y: 60 };
        let path = build_internal_path(
            &cluster,
            centroid,
            entry,
            RoadDir::West,
            exit,
            RoadDir::South,
            ManeuverKind::LeftTurn,
        )
        .expect("path exists");
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1, "non-orthogonal step {:?}->{:?}", w[0], w[1]);
        }
        assert!(
            path.iter().all(|t| cluster.contains(t)),
            "path stays inside the cluster"
        );
        assert_eq!(path[0], entry);
        // SIMPLE: no revisited tile (the old centroid-pivot join could revisit).
        let uniq: HashSet<TilePos> = path.iter().copied().collect();
        assert_eq!(uniq.len(), path.len(), "path must be simple: {path:?}");
        // Center POINT C = mean of tile centers = (33.0, 64.0). The left arc must ENCLOSE C: tiles
        // on every side of C appear (left x<33, right x>33, above y>64, below y<64), so it wraps
        // around C rather than cutting one corner.
        let c = (33.0_f64, 64.0_f64);
        assert!(
            path.iter().any(|t| (t.x as f64) < c.0)
                && path.iter().any(|t| (t.x as f64 + 1.0) > c.0)
                && path.iter().any(|t| (t.y as f64 + 1.0) > c.1)
                && path.iter().any(|t| (t.y as f64) < c.1),
            "left arc must enclose the center point C={c:?}: {}",
            ascii_path(&cluster, &path)
        );
        let last = *path.last().unwrap();
        let dist = (last.x - exit.x).abs() + (last.y - exit.y).abs();
        assert_eq!(
            dist, 1,
            "path does not end adjacent to exit: last={:?}, exit={:?}",
            last, exit
        );
    }

    #[test]
    fn entry_not_in_cluster_returns_none() {
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 99, y: 99 };
        let exit = TilePos { x: 30, y: 64 };
        assert!(
            build_internal_path(
                &cluster,
                TilePos { x: 31, y: 61 },
                entry,
                RoadDir::West,
                exit,
                RoadDir::West,
                ManeuverKind::Straight,
            )
            .is_none()
        );
    }

    #[test]
    fn entry_is_the_goal_returns_single_tile_path() {
        // Single-tile cluster; entry == goal (exit_tile - exit_dir.delta() = {31,61}).
        let cluster: HashSet<TilePos> = [(31, 61)].iter().map(|&(x, y)| TilePos { x, y }).collect();
        let entry = TilePos { x: 31, y: 61 };
        let exit = TilePos { x: 30, y: 61 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 31, y: 61 },
            entry,
            RoadDir::West,
            exit,
            RoadDir::West,
            ManeuverKind::Straight,
        )
        .expect("path exists");
        assert_eq!(path.len(), 1);
        assert_eq!(path[0], entry);
    }

    #[test]
    fn straight_routes_shortest_path_to_in_box_goal() {
        // exit_tile {5,5} is outside the cluster but goal = {5,5} - East.delta = {4,5} is in it.
        // A straight (East->East) takes the shortest in-box path from entry {3,4} to goal {4,5}.
        let cluster: HashSet<TilePos> = [(3, 4), (4, 4), (5, 4), (3, 5), (4, 5)]
            .iter()
            .map(|&(x, y)| TilePos { x, y })
            .collect();
        let entry = TilePos { x: 3, y: 4 };
        let exit = TilePos { x: 5, y: 5 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 3, y: 4 },
            entry,
            RoadDir::East,
            exit,
            RoadDir::East,
            ManeuverKind::Straight,
        )
        .expect("path exists");
        let last = *path.last().unwrap();
        assert_eq!(
            last,
            TilePos { x: 4, y: 5 },
            "straight must terminate on the in-box goal (4,5) but got {:?}",
            last
        );
        assert_eq!(path[0], entry);
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1);
        }
        assert!(path.iter().all(|t| cluster.contains(t)));
    }

    #[test]
    fn build_lanelet_graph_flag_on_populates_graph() {
        let (grid, intersection_index) = build_cross_grid();
        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(intersection_index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());

        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        assert!(
            !graph.lanelets.is_empty(),
            "lanelets must be built when flag is on"
        );
        assert!(
            graph.by_intersection.contains_key(&IntersectionId(0)),
            "by_intersection must contain cluster 0"
        );
        assert_eq!(graph.version, 1);

        let matrices = app.world().resource::<LaneletConflictMatrices>();
        assert!(
            matrices.by_intersection.contains_key(&IntersectionId(0)),
            "conflict matrix must exist for cluster 0"
        );
        assert_eq!(matrices.version, 1);
    }

    #[test]
    fn lanelets_sorted_by_entry_exit_lane_id() {
        let (grid, intersection_index) = build_cross_grid();
        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(intersection_index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());

        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        let ids = graph.of_intersection(IntersectionId(0));
        let keys: Vec<(u32, u32)> = ids
            .iter()
            .map(|&lid| {
                let l = graph.get(lid).unwrap();
                (l.entry_lane.0, l.exit_lane.0)
            })
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(
            keys, sorted,
            "lanelets must be in (entry_lane, exit_lane) order"
        );
    }

    #[test]
    fn by_entry_lane_index_populated_and_ascending_by_exit() {
        let (grid, intersection_index) = build_cross_grid();
        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(intersection_index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());

        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        use crate::game::transport::LaneId;

        let e = graph.lanelets[0].entry_lane;
        let from = graph.lanelets_from(e);
        assert!(!from.is_empty(), "entry lane must be indexed");

        let expected: Vec<LaneletId> = graph
            .lanelets
            .iter()
            .filter(|l| l.entry_lane == e)
            .map(|l| l.id)
            .collect();
        assert_eq!(from, expected.as_slice());

        let exits: Vec<u32> = from
            .iter()
            .map(|id| graph.get(*id).unwrap().exit_lane.0)
            .collect();
        assert!(
            exits.windows(2).all(|w| w[0] <= w[1]),
            "exit lanes must be ascending: {:?}",
            exits
        );

        assert!(graph.lanelets_from(LaneId(u32::MAX)).is_empty());
    }

    #[test]
    fn matrix_does_not_over_report_parallel_or_opposite_straights() {
        let (grid, intersection_index) = build_two_lane_cross_grid();
        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(intersection_index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());

        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        let matrices = app.world().resource::<LaneletConflictMatrices>();
        let ids = graph.of_intersection(IntersectionId(0));
        let matrix = matrices
            .by_intersection
            .get(&IntersectionId(0))
            .expect("matrix for cluster 0");

        // Classify each lanelet's through-straight axis from its lane-faithful internal path.
        // A horizontal (eastbound/westbound) through stays on one row; a vertical
        // (north/south) through stays on one column. Local index == position in `ids`.
        let mut eastbound: Vec<usize> = Vec::new();
        let mut westbound: Vec<usize> = Vec::new();
        let mut northbound: Vec<usize> = Vec::new();
        for (local, &lid) in ids.iter().enumerate() {
            let l = graph.get(lid).unwrap();
            if l.maneuver != ManeuverKind::Straight || l.internal_path.len() < 2 {
                continue;
            }
            let first = l.internal_path[0];
            let last = *l.internal_path.last().unwrap();
            let dx = last.x - first.x;
            let dy = last.y - first.y;
            match (dx.signum(), dy.signum()) {
                (1, 0) => eastbound.push(local),
                (-1, 0) => westbound.push(local),
                (0, 1) => northbound.push(local),
                _ => {}
            }
        }

        let dump = |local: usize| {
            let lid = ids[local];
            graph.get(lid).unwrap().internal_path.clone()
        };

        assert!(
            eastbound.len() >= 2,
            "expected two parallel eastbound throughs, got {} ({:?})",
            eastbound.len(),
            eastbound.iter().map(|&i| dump(i)).collect::<Vec<_>>()
        );
        assert!(
            !westbound.is_empty(),
            "expected at least one westbound through"
        );
        assert!(
            !northbound.is_empty(),
            "expected at least one northbound through"
        );

        // PARALLEL same-direction straights: two eastbound throughs must not conflict.
        let (pa, pb) = (eastbound[0], eastbound[1]);
        assert!(
            !matrix.conflicts(pa, pb),
            "parallel eastbound straights over-report a conflict; paths {:?} vs {:?}",
            dump(pa),
            dump(pb)
        );

        // OPPOSITE straights: an eastbound and a westbound through must not conflict.
        let (oa, ob) = (eastbound[0], westbound[0]);
        assert!(
            !matrix.conflicts(oa, ob),
            "opposite eastbound/westbound straights over-report a conflict; paths {:?} vs {:?}",
            dump(oa),
            dump(ob)
        );

        // CROSSING pair: an eastbound and a northbound through physically cross the cluster.
        let (ew, ns) = (eastbound[0], northbound[0]);
        assert!(
            matrix.conflicts(ew, ns),
            "genuinely crossing eastbound/northbound straights must conflict; paths {:?} vs {:?}",
            dump(ew),
            dump(ns)
        );
    }

    #[test]
    fn parallel_through_lanes_take_disjoint_internal_paths() {
        use std::collections::HashSet;
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let pa = build_internal_path(
            &cluster,
            TilePos { x: 31, y: 61 },
            TilePos { x: 34, y: 63 },
            RoadDir::West,
            TilePos { x: 30, y: 63 },
            RoadDir::West,
            ManeuverKind::Straight,
        )
        .unwrap();
        let pb = build_internal_path(
            &cluster,
            TilePos { x: 31, y: 61 },
            TilePos { x: 34, y: 64 },
            RoadDir::West,
            TilePos { x: 30, y: 64 },
            RoadDir::West,
            ManeuverKind::Straight,
        )
        .unwrap();
        let sa: HashSet<&TilePos> = pa.iter().collect();
        assert!(
            pb.iter().all(|t| !sa.contains(t)),
            "parallel lanes must not share internal tiles: {pa:?} vs {pb:?}"
        );
        for w in pa.windows(2) {
            assert_eq!((w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs(), 1);
        }
        assert!(pa.iter().all(|t| cluster.contains(t)));
    }

    #[test]
    fn crosswalk_cells_one_per_approach_on_cluster_edge() {
        let (grid, index) = build_cross_grid();
        let cluster = &index.clusters[0];
        let cws = crosswalk_cells(cluster, &grid);
        assert_eq!(
            cws.len(),
            4,
            "4-way cross yields one crosswalk per approach side"
        );
        let cluster_set: HashSet<TilePos> = cluster.tiles.iter().copied().collect();
        for (_, _side, cells) in &cws {
            assert!(!cells.is_empty(), "each crosswalk has cells");
            assert!(
                cells.iter().all(|c| cluster_set.contains(c)),
                "crosswalk cells lie on the cluster boundary"
            );
        }
        // Ids assigned 0..n in emission order; sides in [W, E, S, N] scan order.
        let ids: Vec<u32> = cws.iter().map(|(id, _, _)| id.0).collect();
        assert_eq!(ids, vec![0, 1, 2, 3]);
        let sides: Vec<RoadDir> = cws.iter().map(|(_, s, _)| *s).collect();
        assert_eq!(
            sides,
            vec![RoadDir::West, RoadDir::East, RoadDir::South, RoadDir::North]
        );
        // Deterministic across calls.
        let pairs: Vec<(u32, RoadDir, Vec<TilePos>)> =
            cws.iter().map(|(i, s, c)| (i.0, *s, c.clone())).collect();
        let cws2 = crosswalk_cells(cluster, &grid);
        let pairs2: Vec<(u32, RoadDir, Vec<TilePos>)> =
            cws2.iter().map(|(i, s, c)| (i.0, *s, c.clone())).collect();
        assert_eq!(pairs, pairs2, "crosswalk derivation is deterministic");
    }

    #[test]
    fn build_stores_crosswalk_sides_per_intersection() {
        let (grid, intersection_index) = build_cross_grid();
        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(intersection_index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());
        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let matrices = app.world().resource::<LaneletConflictMatrices>();
        let sides = matrices
            .crosswalk_sides
            .get(&IntersectionId(0))
            .expect("crosswalk sides stored for cluster 0");
        assert_eq!(
            sides,
            &vec![RoadDir::West, RoadDir::East, RoadDir::South, RoadDir::North]
        );
        // The crosswalk rows are appended after the vehicle lanelets.
        let matrix = matrices.by_intersection.get(&IntersectionId(0)).unwrap();
        assert_eq!(
            matrix.len() - matrix.crosswalk_base(),
            sides.len(),
            "one matrix crosswalk row per stored side"
        );
    }

    #[test]
    fn lane_type_gates_maneuvers() {
        use crate::game::roads::{LaneType, RoadDir};
        use crate::game::traffic::ManeuverKind;

        assert!(lane_allows_maneuver(
            LaneType::LeftTurnOnly,
            ManeuverKind::LeftTurn,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::LeftTurnOnly,
            ManeuverKind::Straight,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::LeftTurnOnly,
            ManeuverKind::RightTurn,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::LeftTurnOnly,
            ManeuverKind::Other,
            RoadDir::North,
            true
        ));

        assert!(lane_allows_maneuver(
            LaneType::RightTurnOnly,
            ManeuverKind::RightTurn,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::RightTurnOnly,
            ManeuverKind::Straight,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::RightTurnOnly,
            ManeuverKind::LeftTurn,
            RoadDir::North,
            true
        ));

        assert!(lane_allows_maneuver(
            LaneType::StraightOnly,
            ManeuverKind::Straight,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::StraightOnly,
            ManeuverKind::RightTurn,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::StraightOnly,
            ManeuverKind::LeftTurn,
            RoadDir::North,
            true
        ));

        assert!(lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::Straight,
            RoadDir::North,
            true
        ));
        assert!(lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::RightTurn,
            RoadDir::North,
            true
        ));
        // Regular now serves the single-lane крайнее левое left turn (ПДД 8.5).
        assert!(lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::LeftTurn,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::Other,
            RoadDir::North,
            true
        ));

        assert!(lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::Straight,
            RoadDir::North,
            false
        ));
        assert!(lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::LeftTurn,
            RoadDir::North,
            false
        ));
        // Regular now serves all maneuvers regardless of traffic handedness.
        assert!(lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::RightTurn,
            RoadDir::North,
            false
        ));
    }

    #[test]
    fn regular_lane_allows_all_maneuvers_right_hand() {
        use crate::game::roads::{LaneType, RoadDir};
        use crate::game::traffic::ManeuverKind;
        for m in [
            ManeuverKind::Straight,
            ManeuverKind::RightTurn,
            ManeuverKind::LeftTurn,
            ManeuverKind::UTurn,
        ] {
            assert!(
                lane_allows_maneuver(LaneType::Regular, m, RoadDir::North, true),
                "Regular must allow {m:?}"
            );
        }
        // Turn-only lanes: left lane also serves the U-turn (ПДД 8.5 крайнее левое).
        assert!(lane_allows_maneuver(
            LaneType::LeftTurnOnly,
            ManeuverKind::UTurn,
            RoadDir::North,
            true
        ));
        assert!(!lane_allows_maneuver(
            LaneType::RightTurnOnly,
            ManeuverKind::LeftTurn,
            RoadDir::North,
            true
        ));
    }

    // ---- arc-around-center geometry (the user invariant: turns arc AROUND the center POINT) ----

    fn box_2x2() -> HashSet<TilePos> {
        [(4, 4), (4, 5), (5, 4), (5, 5)]
            .into_iter()
            .map(|(x, y)| TilePos { x, y })
            .collect()
    }

    fn box_3x3() -> HashSet<TilePos> {
        (4..=6)
            .flat_map(|x| (4..=6).map(move |y| TilePos { x, y }))
            .collect()
    }

    /// True iff `path` is simple (no revisited tile).
    fn is_simple(path: &[TilePos]) -> bool {
        let s: HashSet<TilePos> = path.iter().copied().collect();
        s.len() == path.len()
    }

    /// True iff `path` encloses the center POINT `c`: it has a tile on every side of `c`
    /// (left/right/above/below), so it wraps around `c` rather than cutting one corner.
    fn encloses_center(path: &[TilePos], c: (f64, f64)) -> bool {
        path.iter().any(|t| (t.x as f64) < c.0)
            && path.iter().any(|t| (t.x as f64 + 1.0) > c.0)
            && path.iter().any(|t| (t.y as f64) < c.1)
            && path.iter().any(|t| (t.y as f64 + 1.0) > c.1)
    }

    fn assert_path_invariants(
        cluster: &HashSet<TilePos>,
        path: &[TilePos],
        entry: TilePos,
        goal: TilePos,
    ) {
        assert_eq!(path.first().copied(), Some(entry), "starts at entry");
        assert_eq!(path.last().copied(), Some(goal), "ends at goal");
        for w in path.windows(2) {
            let d = (w[0].x - w[1].x).abs() + (w[0].y - w[1].y).abs();
            assert_eq!(d, 1, "4-adjacent {:?}->{:?}", w[0], w[1]);
        }
        assert!(
            path.iter().all(|t| cluster.contains(t)),
            "every tile in box"
        );
        assert!(is_simple(path), "path is simple: {path:?}");
    }

    #[test]
    fn arc_2x2_straight_is_a_direct_line() {
        // 2x2 box, center POINT C=(5.0,5.0). Eastbound straight: entry (4,4), exit_tile (6,4) East
        // -> goal (5,4). Direct 2-tile line, unchanged from the legacy router.
        let cluster = box_2x2();
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            TilePos { x: 4, y: 4 },
            RoadDir::East,
            TilePos { x: 6, y: 4 },
            RoadDir::East,
            ManeuverKind::Straight,
        )
        .expect("straight");
        eprintln!("2x2 STRAIGHT (E):{}", ascii_path(&cluster, &path));
        assert_eq!(
            path,
            vec![TilePos { x: 4, y: 4 }, TilePos { x: 5, y: 4 }],
            "straight is the direct line"
        );
    }

    #[test]
    fn arc_2x2_right_turn_is_tight_near_corner() {
        // 2x2 box, C=(5.0,5.0). Northbound right turn: entry (4,4), exit East exit_tile (6,4) ->
        // goal (5,4). North->East under right-hand traffic is a RIGHT turn; the TIGHT arc hugs the
        // near corner — fewest tiles (2), C stays outside.
        let cluster = box_2x2();
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 5, y: 4 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::North,
            TilePos { x: 6, y: 4 },
            RoadDir::East,
            ManeuverKind::RightTurn,
        )
        .expect("right");
        eprintln!("2x2 RIGHT (N->E):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        assert_eq!(
            path,
            vec![entry, goal],
            "tight right turn = the 2-tile near-corner hug"
        );
        // Tightest: nothing shorter than 2 tiles for non-adjacent entry/goal; C NOT enclosed.
        assert!(
            !encloses_center(&path, (5.0, 5.0)),
            "tight right turn must NOT enclose C: {path:?}"
        );
    }

    #[test]
    fn arc_2x2_left_turn_swings_around_center() {
        // 2x2 box, C=(5.0,5.0). Northbound left turn: entry (4,4), exit West exit_tile (3,5) ->
        // goal (4,5). North->West under right-hand traffic is a LEFT turn; the WIDE arc swings the
        // long way AROUND C — all 4 box tiles, C enclosed. NOT a 2-tile corner snap.
        let cluster = box_2x2();
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 4, y: 5 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::North,
            TilePos { x: 3, y: 5 },
            RoadDir::West,
            ManeuverKind::LeftTurn,
        )
        .expect("left");
        eprintln!("2x2 LEFT (N->W):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        assert!(
            path.len() >= 3,
            "left arc is wide (>=3 tiles in a 2x2), not a 2-tile snap: {path:?}"
        );
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 5, y: 4 },
                TilePos { x: 5, y: 5 },
                TilePos { x: 4, y: 5 },
            ],
            "left arc walks the full CCW loop around C"
        );
        assert!(
            encloses_center(&path, (5.0, 5.0)),
            "left arc must enclose C (go around it): {path:?}"
        );
    }

    #[test]
    fn arc_2x2_uturn_loops_around_center() {
        // 2x2 box, C=(5.0,5.0). Northbound U-turn: entry (4,4) heading North, exit South exit_tile
        // (5,3) -> goal (5,4). North->South is a U-turn; the ~270 arc loops AROUND C — all 4 tiles.
        let cluster = box_2x2();
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 5, y: 4 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::North,
            TilePos { x: 5, y: 3 },
            RoadDir::South,
            ManeuverKind::UTurn,
        )
        .expect("uturn");
        eprintln!("2x2 UTURN (N->S):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        assert_eq!(path.len(), 4, "U-turn loops all 4 box tiles around C");
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 4, y: 5 },
                TilePos { x: 5, y: 5 },
                TilePos { x: 5, y: 4 },
            ],
            "U-turn walks the full loop around C"
        );
        assert!(
            encloses_center(&path, (5.0, 5.0)),
            "U-turn must enclose C: {path:?}"
        );
    }

    #[test]
    fn arc_3x3_all_maneuvers() {
        // 3x3 box x,y in 4..=6, center POINT C=(5.5,5.5) — the vertex between the four upper-right
        // tiles, NOT the center tile (5,5).
        let cluster = box_3x3();
        let c = (5.5_f64, 5.5_f64);

        // STRAIGHT eastbound on the middle row: entry (4,5), exit_tile (7,5) -> goal (6,5).
        let s_entry = TilePos { x: 4, y: 5 };
        let s_goal = TilePos { x: 6, y: 5 };
        let straight = build_internal_path(
            &cluster,
            TilePos { x: 5, y: 5 },
            s_entry,
            RoadDir::East,
            TilePos { x: 7, y: 5 },
            RoadDir::East,
            ManeuverKind::Straight,
        )
        .expect("straight");
        eprintln!("3x3 STRAIGHT (E):{}", ascii_path(&cluster, &straight));
        assert_path_invariants(&cluster, &straight, s_entry, s_goal);
        assert_eq!(
            straight,
            vec![s_entry, TilePos { x: 5, y: 5 }, s_goal],
            "straight is the direct middle-row line"
        );

        // RIGHT turn: entry (4,4) heading North, exit East exit_tile (7,4) -> goal (6,4).
        // North->East is a right turn; TIGHT arc along the bottom edge (fewest tiles).
        let r_entry = TilePos { x: 4, y: 4 };
        let r_goal = TilePos { x: 6, y: 4 };
        let right = build_internal_path(
            &cluster,
            TilePos { x: 5, y: 5 },
            r_entry,
            RoadDir::North,
            TilePos { x: 7, y: 4 },
            RoadDir::East,
            ManeuverKind::RightTurn,
        )
        .expect("right");
        eprintln!("3x3 RIGHT (N->E):{}", ascii_path(&cluster, &right));
        assert_path_invariants(&cluster, &right, r_entry, r_goal);
        assert_eq!(
            right,
            vec![r_entry, TilePos { x: 5, y: 4 }, r_goal],
            "tight right turn hugs the bottom edge"
        );
        assert!(
            !encloses_center(&right, c),
            "tight right turn must NOT enclose C: {right:?}"
        );

        // LEFT turn: entry (4,4) heading East, exit North exit_tile (4,7) -> goal (4,6).
        // East->North is a left turn; WIDE arc the long way around C.
        let l_entry = TilePos { x: 4, y: 4 };
        let l_goal = TilePos { x: 4, y: 6 };
        let left = build_internal_path(
            &cluster,
            TilePos { x: 5, y: 5 },
            l_entry,
            RoadDir::East,
            TilePos { x: 4, y: 7 },
            RoadDir::North,
            ManeuverKind::LeftTurn,
        )
        .expect("left");
        eprintln!("3x3 LEFT (E->N):{}", ascii_path(&cluster, &left));
        assert_path_invariants(&cluster, &left, l_entry, l_goal);
        assert!(left.len() >= 4, "wide left arc: {left:?}");
        assert!(
            !left.contains(&TilePos { x: 5, y: 5 }),
            "left arc swings around C, not through the center tile: {left:?}"
        );
        assert!(
            encloses_center(&left, c),
            "left arc must enclose C: {left:?}"
        );

        // U-TURN: entry (4,4) heading East, exit West exit_tile (3,5) -> goal (4,5).
        // East->West is a U-turn; ~270 arc around C.
        let u_entry = TilePos { x: 4, y: 4 };
        let u_goal = TilePos { x: 4, y: 5 };
        let uturn = build_internal_path(
            &cluster,
            TilePos { x: 5, y: 5 },
            u_entry,
            RoadDir::East,
            TilePos { x: 3, y: 5 },
            RoadDir::West,
            ManeuverKind::UTurn,
        )
        .expect("uturn");
        eprintln!("3x3 UTURN (E->W):{}", ascii_path(&cluster, &uturn));
        assert_path_invariants(&cluster, &uturn, u_entry, u_goal);
        assert!(uturn.len() >= 4, "wide U-turn arc: {uturn:?}");
        assert!(
            encloses_center(&uturn, c),
            "U-turn must enclose C: {uturn:?}"
        );
    }
}
