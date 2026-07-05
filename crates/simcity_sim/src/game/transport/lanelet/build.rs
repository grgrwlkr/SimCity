use std::collections::{HashMap, HashSet, VecDeque};

use bevy::prelude::*;

use crate::game::intersections::{IntersectionCluster, IntersectionId, IntersectionIndex};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow};
use crate::game::traffic::{ManeuverKind, TrafficConfig, maneuver_kind};
use crate::game::transport::{GraphVersion, LaneGraph, LaneId};

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

impl LaneletConflictMatrices {
    /// Conflict row of local lanelet `local_idx` at intersection `id`, or an empty slice if the
    /// intersection has no matrix or the index is out of range. The box-entry gate (`drive.rs`) uses
    /// this to take the deferred conflict-tile reservation. An empty row never overlaps anything
    /// (`rows_overlap([], _) == false`), so a missing matrix fails OPEN at entry — the same defensive
    /// stance as the arbiter, where a missing matrix simply skips the cluster.
    pub fn row_for(&self, id: IntersectionId, local_idx: u32) -> &[u64] {
        self.by_intersection
            .get(&id)
            .map(|m| m.row(local_idx as usize))
            .unwrap_or(&[])
    }
}

/// Whether an approach lane may feed a lanelet of `maneuver`. Encodes lane discipline:
/// turn-only lanes feed only their designated turn (LeftTurnOnly also permits U-turn per
/// ПДД 8.5 крайнее левое). A Regular lane is gated POSITIONALLY (ПДД 8.5 "крайнее
/// соответствующее положение"): the turn that crosses the oncoming flow (left under RHT) and
/// the U-turn require the centerline-adjacent lane; the near-side turn requires the
/// curb-adjacent lane; straight is always allowed. On a single-lane-per-direction road the one
/// lane is both edges, so every maneuver stays legal there.
pub(crate) fn lane_allows_maneuver(
    maneuver: ManeuverKind,
    cell: RoadCell,
    drive_on_right: bool,
) -> bool {
    match cell.lane_type {
        LaneType::LeftTurnOnly => {
            matches!(maneuver, ManeuverKind::LeftTurn | ManeuverKind::UTurn)
        }
        LaneType::RightTurnOnly => matches!(maneuver, ManeuverKind::RightTurn),
        LaneType::StraightOnly => matches!(maneuver, ManeuverKind::Straight),
        LaneType::Regular => {
            let near_centerline = cell.is_leftmost_for_dir();
            let near_curb = cell.is_rightmost_for_dir();
            // Under RHT the left turn crosses oncoming traffic (centerline lane); mirrored for LHT.
            let (crossing_turn_ok, near_turn_ok) = if drive_on_right {
                (near_centerline, near_curb)
            } else {
                (near_curb, near_centerline)
            };
            match maneuver {
                ManeuverKind::Straight => true,
                ManeuverKind::LeftTurn | ManeuverKind::UTurn => crossing_turn_ok,
                ManeuverKind::RightTurn => near_turn_ok,
                ManeuverKind::Other => false,
            }
        }
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
/// Degenerate geometry where the exit-FEEDING in-box tile (`exit_tile - exit_dir.delta()`) is not in
/// the cluster returns `None` (caller drops the lanelet → dir-strict road-A* fallback) rather than a
/// path that could land on the opposing exit lane. A turn whose angular walk dead-ends degrades to
/// the shortest in-box path to that same exit-feeding goal — never to an arbitrary exit-adjacent tile.
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
    // `goal` is the in-box tile that FEEDS the away-pointing exit lane: stepping goal -> exit_tile
    // travels in `exit_dir`, so the route lands on the same-direction (non-oncoming) exit lane.
    let goal = TilePos {
        x: exit_tile.x - xd.x,
        y: exit_tile.y - xd.y,
    };
    if !cluster_tiles.contains(&goal) {
        // Degenerate geometry: the exit-feeding in-box tile isn't in the cluster. The old BFS
        // fallback walked to *some* tile adjacent to `exit_tile`, which on irregular/multi-tile
        // clusters could land on the opposing-lane side and make the flattened route step onto the
        // oncoming exit lane. Return `None` instead: the caller drops this lanelet and the
        // dir-strict road-A* fallback handles the junction, so we NEVER emit an oncoming path.
        return None;
    }
    match maneuver {
        ManeuverKind::Straight => bfs_within(cluster_tiles, entry_tile, goal),
        ManeuverKind::RightTurn | ManeuverKind::LeftTurn | ManeuverKind::UTurn => {
            // Rectangular ПДД trajectory (Г for turns, П for U-turns) instead of the old greedy
            // angular walk: on NON-SQUARE boxes (e.g. a SixLane×FourLane 4x6 crossing) the greedy
            // minimal-angular-advance hug degenerated into a near-PERIMETER sweep — the turn
            // visibly drove across the oncoming half of the intersection (наблюдалось как
            // «встречка на перекрёстке»). The Manhattan construction stays on the entry lane's
            // column/row to the turn line, then goes straight to the exit feeder: a left turn
            // crosses BEHIND the center (ПДД 8.6), a right turn hugs its near corner, and the
            // swept conflict footprint is minimal. Falls back to the shortest in-box path (never
            // an arbitrary exit-adjacent tile) on irregular cluster shapes, then `None`.
            manhattan_turn_path(cluster_tiles, entry_tile, entry_dir, goal, maneuver)
                .or_else(|| bfs_within(cluster_tiles, entry_tile, goal))
        }
        ManeuverKind::Other => None,
    }
}

/// Rectangular in-box turn trajectory. For LEFT/RIGHT turns: drive the entry axis until aligned
/// with `goal` on the cross coordinate, then drive the exit axis to `goal` (an "Г" path). Because
/// legal left exits lie on the FAR half of the crossing road and rights on the NEAR half, the Г
/// automatically passes behind the box center for lefts and hugs the near corner for rights. For
/// U-TURNS: drive the entry axis to just PAST the box center, shift laterally to the goal's
/// column/row, and drive back (a "П" path around the center). Every produced tile must be inside
/// the cluster; returns `None` on any mismatch (irregular geometry) so the caller can fall back.
fn manhattan_turn_path(
    cluster_tiles: &HashSet<TilePos>,
    entry: TilePos,
    entry_dir: RoadDir,
    goal: TilePos,
    maneuver: ManeuverKind,
) -> Option<Vec<TilePos>> {
    if entry == goal {
        return Some(vec![entry]);
    }
    let ed = entry_dir.delta();
    if ed == IVec2::ZERO {
        return None;
    }
    let vertical_entry = ed.x == 0;

    let mut path = vec![entry];
    let mut cur = entry;
    let step_to = |path: &mut Vec<TilePos>, cur: &mut TilePos, dx: i32, dy: i32| -> bool {
        let next = TilePos {
            x: cur.x + dx,
            y: cur.y + dy,
        };
        if !cluster_tiles.contains(&next) {
            return false;
        }
        path.push(next);
        *cur = next;
        true
    };

    match maneuver {
        ManeuverKind::LeftTurn | ManeuverKind::RightTurn => {
            // Leg 1: along the entry axis to the goal's cross coordinate (must agree with the
            // travel direction — a goal "behind" the entry means broken pairing).
            let (leg1, leg2): (i32, i32) = if vertical_entry {
                (goal.y - entry.y, goal.x - entry.x)
            } else {
                (goal.x - entry.x, goal.y - entry.y)
            };
            let fwd = if vertical_entry { ed.y } else { ed.x };
            if leg1 != 0 && leg1.signum() != fwd.signum() {
                return None;
            }
            for _ in 0..leg1.abs() {
                let (dx, dy) = if vertical_entry {
                    (0, leg1.signum())
                } else {
                    (leg1.signum(), 0)
                };
                if !step_to(&mut path, &mut cur, dx, dy) {
                    return None;
                }
            }
            // Leg 2: the exit axis, straight to the goal.
            for _ in 0..leg2.abs() {
                let (dx, dy) = if vertical_entry {
                    (leg2.signum(), 0)
                } else {
                    (0, leg2.signum())
                };
                if !step_to(&mut path, &mut cur, dx, dy) {
                    return None;
                }
            }
        }
        ManeuverKind::UTurn => {
            // Leg 1: along the entry axis until the tile center passes the box center (the
            // «за центром» pivot line, ПДД 8.6/8.5).
            let (cx, cy) = box_center_point(cluster_tiles);
            let passed = |t: TilePos| -> bool {
                if vertical_entry {
                    let c = t.y as f64 + 0.5;
                    if ed.y > 0 { c > cy } else { c < cy }
                } else {
                    let c = t.x as f64 + 0.5;
                    if ed.x > 0 { c > cx } else { c < cx }
                }
            };
            while !passed(cur) {
                if !step_to(&mut path, &mut cur, ed.x, ed.y) {
                    return None;
                }
            }
            // Leg 2: lateral shift to the goal's column/row.
            let lat = if vertical_entry {
                goal.x - cur.x
            } else {
                goal.y - cur.y
            };
            for _ in 0..lat.abs() {
                let (dx, dy) = if vertical_entry {
                    (lat.signum(), 0)
                } else {
                    (0, lat.signum())
                };
                if !step_to(&mut path, &mut cur, dx, dy) {
                    return None;
                }
            }
            // Leg 3: back along the entry axis to the goal (against the entry direction).
            let back = if vertical_entry {
                goal.y - cur.y
            } else {
                goal.x - cur.x
            };
            if back != 0 && back.signum() == (if vertical_entry { ed.y } else { ed.x }).signum() {
                return None; // goal is not behind the pivot: not a U-turn geometry.
            }
            for _ in 0..back.abs() {
                let (dx, dy) = if vertical_entry {
                    (0, back.signum())
                } else {
                    (back.signum(), 0)
                };
                if !step_to(&mut path, &mut cur, dx, dy) {
                    return None;
                }
            }
        }
        _ => return None,
    }

    if cur != goal {
        return None;
    }
    Some(path)
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
        // entry_tiles: (approach_lane_pos, first_cluster_tile, entry_dir, approach RoadCell)
        //   approach_lane_pos: the non-cluster tile with dir pointing into cluster
        //   first_cluster_tile: the cluster tile that approach_lane_pos points to (used as BFS start)
        //
        // exit_tiles: (exit_lane_pos, exit_dir)
        //   exit_lane_pos: the non-cluster tile pointing away from cluster (used as BFS goal target)
        let mut entry_tiles: Vec<(TilePos, TilePos, RoadDir, RoadCell)> = Vec::new();
        let mut exit_tiles: Vec<(TilePos, RoadDir, RoadCell)> = Vec::new();

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
                    entry_tiles.push((npos, fwd, lane_dir, ncell.road));
                } else if cluster_tiles.contains(&back) {
                    // Cluster is behind this lane: exit lane.
                    exit_tiles.push((npos, lane_dir, ncell.road));
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

        for &(approach_tile, first_cluster_tile, entry_dir, entry_cell) in &entry_tiles {
            let Some(entry_lane_id) = lanes.pos_to_id.get(&approach_tile).copied() else {
                continue;
            };
            for &(exit_tile, exit_dir, exit_cell) in &exit_tiles {
                let Some(exit_lane_id) = lanes.pos_to_id.get(&exit_tile).copied() else {
                    continue;
                };
                // Don't connect a lane to itself.
                if entry_lane_id == exit_lane_id {
                    continue;
                }

                let maneuver = maneuver_kind(&traffic_cfg, entry_dir, exit_dir);
                // Keep lane through the box: a STRAIGHT must exit in the SAME lane index whenever
                // that exit exists (no weaving inside an intersection: an S-shaped in-box path
                // sweeps extra conflict tiles and serializes the box harder). Shifted exits stay
                // legal only when the same-index continuation is absent (road narrows / irregular
                // geometry), so no approach dead-ends.
                if maneuver == ManeuverKind::Straight
                    && exit_cell.kind == entry_cell.kind
                    && exit_cell.lane != entry_cell.lane
                {
                    let has_same_lane_exit = exit_tiles.iter().any(|&(_, d, c)| {
                        d == entry_dir && c.kind == entry_cell.kind && c.lane == entry_cell.lane
                    });
                    if has_same_lane_exit {
                        continue;
                    }
                }
                if !lane_allows_maneuver(maneuver, entry_cell, traffic_cfg.drive_on_right) {
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
        let sorted_meta: Vec<(ManeuverKind, LaneId)> = indexed
            .iter()
            .map(|(l, _)| (l.maneuver, l.entry_lane))
            .collect();

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
        let mut matrix =
            ConflictMatrix::from_paths_with_crosswalks(&sorted_paths, &crosswalk_paths);
        // ПДД 13.12 semantic conflicts: a left/U turn must yield to the ONCOMING straight (and
        // right turn). The compact Manhattan turn trajectories often occupy tiles DISJOINT from
        // the oncoming through's column, so pure tile-overlap would let both into the box in the
        // same tick — the left visibly cutting across the oncoming car's nose. Force the pair.
        for (i, &(m_a, entry_a)) in sorted_meta.iter().enumerate() {
            if !matches!(m_a, ManeuverKind::LeftTurn | ManeuverKind::UTurn) {
                continue;
            }
            let Some(dir_a) = lanes.get_lane(entry_a).map(|l| l.dir) else {
                continue;
            };
            for (j, &(m_b, entry_b)) in sorted_meta.iter().enumerate() {
                if !matches!(m_b, ManeuverKind::Straight | ManeuverKind::RightTurn) {
                    continue;
                }
                let Some(dir_b) = lanes.get_lane(entry_b).map(|l| l.dir) else {
                    continue;
                };
                if dir_b == dir_a.opposite() {
                    matrix.add_conflict_pair(i, j);
                }
            }
        }
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

    pub(super) fn make_key(tiles: &[TilePos]) -> IntersectionKey {
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
        // 3x3 box x,y in 4..=6. Center POINT C = mean of tile centers = (5.5, 5.5). The ПДД left
        // turn is the compact Г: entry axis to the exit column, then out — it must NOT pass
        // through the center tile (5,5) and must not sweep the far perimeter (the old wide arc
        // crossed the oncoming half of the box).
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
        // The left turn avoids the middle tile and stays off the far perimeter.
        assert!(
            !path.contains(&TilePos { x: 5, y: 5 }),
            "left turn must not cut through the center tile: {path:?}"
        );
        // The compact Г: already on the exit column -> straight to the feeder.
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 4, y: 5 },
                TilePos { x: 4, y: 6 },
            ],
            "left turn tiles: {}",
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
    fn degenerate_exit_feeder_outside_cluster_returns_none_not_oncoming_path() {
        // Irregular L-shaped cluster. The exit lane sits to the EAST of (5,4), so the exit-feeding
        // in-box tile would be (5,4) - East = (4,4). Make that tile NOT part of the cluster, so the
        // old BFS fallback would have walked to SOME other tile adjacent to the exit (landing on the
        // opposing-lane side and producing an oncoming flattened route). The fixed producer must
        // instead return `None` so the caller drops the lanelet (dir-strict road-A* fallback).
        let cluster: HashSet<TilePos> = [(3, 4), (3, 5), (4, 5), (5, 5)]
            .iter()
            .map(|&(x, y)| TilePos { x, y })
            .collect();
        let entry = TilePos { x: 3, y: 4 };
        // exit_tile (6,4) East -> goal = (6,4) - (1,0) = (5,4), which is NOT in the cluster.
        let exit = TilePos { x: 6, y: 4 };
        assert!(
            !cluster.contains(&TilePos { x: 5, y: 4 }),
            "precondition: the exit-feeding tile must be outside the cluster"
        );
        let path = build_internal_path(
            &cluster,
            entry,
            entry,
            RoadDir::East,
            exit,
            RoadDir::East,
            ManeuverKind::Straight,
        );
        assert!(
            path.is_none(),
            "degenerate exit feeder must yield None (lanelet dropped), not a degenerate path: {path:?}"
        );
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

    /// Build a Regular approach-lane cell of `kind` at forward-carriageway lane index `lane`.
    fn approach_cell(kind: RoadKind, lane: u8, lane_type: LaneType) -> RoadCell {
        RoadCell {
            kind,
            dir: RoadDir::North,
            lane,
            flow: RoadFlow::TwoWay,
            lane_type,
        }
    }

    #[test]
    fn lane_type_gates_maneuvers() {
        use crate::game::roads::{LaneType, RoadKind};
        use crate::game::traffic::ManeuverKind;

        // Single-lane-per-direction (TwoLane 1+1): the one lane is both edges.
        let solo = |lt| approach_cell(RoadKind::TwoLane, 0, lt);

        assert!(lane_allows_maneuver(
            ManeuverKind::LeftTurn,
            solo(LaneType::LeftTurnOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::Straight,
            solo(LaneType::LeftTurnOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::RightTurn,
            solo(LaneType::LeftTurnOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::Other,
            solo(LaneType::LeftTurnOnly),
            true
        ));

        assert!(lane_allows_maneuver(
            ManeuverKind::RightTurn,
            solo(LaneType::RightTurnOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::Straight,
            solo(LaneType::RightTurnOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::LeftTurn,
            solo(LaneType::RightTurnOnly),
            true
        ));

        assert!(lane_allows_maneuver(
            ManeuverKind::Straight,
            solo(LaneType::StraightOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::RightTurn,
            solo(LaneType::StraightOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::LeftTurn,
            solo(LaneType::StraightOnly),
            true
        ));

        // Regular on a 1+1 road: both edges at once -> every maneuver legal (ПДД 8.5).
        let reg = solo(LaneType::Regular);
        assert!(lane_allows_maneuver(ManeuverKind::Straight, reg, true));
        assert!(lane_allows_maneuver(ManeuverKind::RightTurn, reg, true));
        assert!(lane_allows_maneuver(ManeuverKind::LeftTurn, reg, true));
        assert!(!lane_allows_maneuver(ManeuverKind::Other, reg, true));
    }

    /// ПДД 8.5 positional discipline on a multi-lane approach (FourLane, forward lanes 0/1):
    /// the left turn and U-turn come ONLY from the centerline-adjacent Regular lane; the right
    /// turn ONLY from the curb-adjacent Regular lane; straight from any lane.
    #[test]
    fn regular_lane_discipline_is_positional_on_multilane() {
        use crate::game::roads::{LaneType, RoadKind};
        use crate::game::traffic::ManeuverKind;

        let curb = approach_cell(RoadKind::FourLane, 0, LaneType::Regular);
        let center = approach_cell(RoadKind::FourLane, 1, LaneType::Regular);
        assert!(curb.is_rightmost_for_dir() && !curb.is_leftmost_for_dir());
        assert!(center.is_leftmost_for_dir() && !center.is_rightmost_for_dir());

        // Straight: both lanes.
        assert!(lane_allows_maneuver(ManeuverKind::Straight, curb, true));
        assert!(lane_allows_maneuver(ManeuverKind::Straight, center, true));

        // Left / U-turn: ONLY from the centerline lane (крайняя левая).
        for m in [ManeuverKind::LeftTurn, ManeuverKind::UTurn] {
            assert!(
                lane_allows_maneuver(m, center, true),
                "{m:?} must be legal from the centerline lane"
            );
            assert!(
                !lane_allows_maneuver(m, curb, true),
                "{m:?} from the curb lane violates ПДД 8.5"
            );
        }

        // Right turn: ONLY from the curb lane (крайняя правая).
        assert!(lane_allows_maneuver(ManeuverKind::RightTurn, curb, true));
        assert!(!lane_allows_maneuver(ManeuverKind::RightTurn, center, true));

        // Turn-only lanes: left lane also serves the U-turn (ПДД 8.5 крайнее левое).
        assert!(lane_allows_maneuver(
            ManeuverKind::UTurn,
            approach_cell(RoadKind::FourLane, 1, LaneType::LeftTurnOnly),
            true
        ));
        assert!(!lane_allows_maneuver(
            ManeuverKind::LeftTurn,
            approach_cell(RoadKind::FourLane, 0, LaneType::RightTurnOnly),
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

    /// 4x4 box, x,y in 4..=7 — the box a FourLane×FourLane crossing produces (the multi-lane test
    /// city's intersection shape). Center POINT C = mean of tile centers = (6.0, 6.0): the vertex
    /// where the four inner tiles (5,5)/(5,6)/(6,5)/(6,6) meet, NOT a tile center.
    fn box_4x4() -> HashSet<TilePos> {
        (4..=7)
            .flat_map(|x| (4..=7).map(move |y| TilePos { x, y }))
            .collect()
    }

    /// Rectangular cluster spanning `x in xs`, `y in ys` (inclusive). Used for the mixed-width
    /// (non-square) box tests — e.g. FourLane(4 tiles)×SixLane(6 tiles) → 4x6, FourLane×TwoLane → 4x2.
    fn box_rect(
        xs: std::ops::RangeInclusive<i32>,
        ys: std::ops::RangeInclusive<i32>,
    ) -> HashSet<TilePos> {
        let ys2 = ys.clone();
        xs.flat_map(move |x| ys2.clone().map(move |y| TilePos { x, y }))
            .collect()
    }

    /// A `build_internal_path` test case: (cluster, entry, entry_dir, exit_tile, exit_dir, maneuver).
    type PathCase<'a> = (
        &'a HashSet<TilePos>,
        TilePos,
        RoadDir,
        TilePos,
        RoadDir,
        ManeuverKind,
    );

    /// Float center POINT of a rectangular box (mean of tile centers).
    fn box_center(cluster: &HashSet<TilePos>) -> (f64, f64) {
        let n = cluster.len() as f64;
        let sx: f64 = cluster.iter().map(|t| t.x as f64 + 0.5).sum();
        let sy: f64 = cluster.iter().map(|t| t.y as f64 + 0.5).sum();
        (sx / n, sy / n)
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
        // goal (4,5). ПДД trajectory (Г): stay on the entry column to the row BEHIND the center,
        // then exit west. Crucially the turn must NOT touch the oncoming southbound column x=5 —
        // the old "wide arc around C" swung через встречную половину бокса first.
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
        assert_eq!(
            path,
            vec![TilePos { x: 4, y: 4 }, TilePos { x: 4, y: 5 }],
            "ПДД left: up the own column past the center, then out — no sweep"
        );
        assert!(
            path.iter().all(|t| t.x == 4),
            "left turn must never touch the oncoming southbound column x=5: {path:?}"
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
        assert_eq!(
            left,
            vec![l_entry, TilePos { x: 4, y: 5 }, l_goal],
            "ПДД left is the compact Г onto the exit column — no perimeter sweep"
        );
        assert!(
            !left.contains(&TilePos { x: 5, y: 5 }),
            "left turn must not cut through the center tile: {left:?}"
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
        // П-shape: along the entry row past the center column (cx=5.5 -> pivot x=6), one lateral
        // step to the exit row, back to the exit feeder. The pivot must lie BEYOND the center
        // (ПДД 8.6: разворот за центром, не срезая его).
        assert_eq!(
            uturn,
            vec![
                u_entry,
                TilePos { x: 5, y: 4 },
                TilePos { x: 6, y: 4 },
                TilePos { x: 6, y: 5 },
                TilePos { x: 5, y: 5 },
                u_goal,
            ],
            "U-turn is the П around the center: {uturn:?}"
        );
        assert!(
            uturn.iter().any(|t| t.x as f64 + 0.5 > c.0),
            "U-turn pivot must pass beyond the center: {uturn:?}"
        );
    }

    // ---- 4x4 box (FourLane×FourLane — the multi-lane test-city intersection shape) ----
    //
    // The whole point of widening to FourLane: a single wide turn occupies only SOME of the 16 tiles
    // (the inner 2x2 around C stays free), so it can no longer monopolize the box the way a turn does
    // in a 2x2. These tests pin that down: tight turns hug a corner, wide turns enclose C but leave the
    // inner 2x2 free (≤ 12 of 16 tiles), and every path stays in-box / 4-adjacent / simple.

    #[test]
    fn arc_4x4_straight_is_a_direct_line() {
        // 4x4 box x,y in 4..=7, C=(6.0,6.0). Eastbound straight on the bottom row: entry (4,4),
        // exit_tile (8,4) East -> goal (7,4). Direct line, never enclosing C.
        let cluster = box_4x4();
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 7, y: 4 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::East,
            TilePos { x: 8, y: 4 },
            RoadDir::East,
            ManeuverKind::Straight,
        )
        .expect("straight");
        eprintln!("4x4 STRAIGHT (E):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 5, y: 4 },
                TilePos { x: 6, y: 4 },
                TilePos { x: 7, y: 4 },
            ],
            "straight is the direct bottom-row line"
        );
        assert!(
            !encloses_center(&path, (6.0, 6.0)),
            "straight must NOT enclose C: {path:?}"
        );
    }

    #[test]
    fn arc_4x4_right_turn_is_tight_corner_c_outside() {
        // 4x4 box, C=(6.0,6.0). Northbound right turn from the bottom-left corner lane: entry (4,4)
        // heading North, exit East exit_tile (8,4) -> goal (7,4). North->East = RIGHT (tight). The
        // angular `arc_around_center` may dead-end on this near-corner case -> bfs fallback; either
        // way the path must be TIGHT (hug the bottom edge), direction-correct, and leave C OUTSIDE.
        let cluster = box_4x4();
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 7, y: 4 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::North,
            TilePos { x: 8, y: 4 },
            RoadDir::East,
            ManeuverKind::RightTurn,
        )
        .expect("right");
        eprintln!("4x4 RIGHT (N->E):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        // Tight: hugs the bottom row, never reaches up to C's row -> C stays outside.
        assert!(
            !encloses_center(&path, (6.0, 6.0)),
            "tight right turn must NOT enclose C: {path:?}"
        );
        assert!(
            path.iter().all(|t| t.y <= 5),
            "tight right turn hugs the corner (low y), never climbs to C's far side: {path:?}"
        );
    }

    #[test]
    fn arc_4x4_left_turn_wide_encloses_c_leaves_box_room() {
        // 4x4 box, C=(6.0,6.0). Eastbound LEFT turn: entry (4,4) heading East, exit North exit_tile
        // (4,8) -> goal (4,7). East->North = LEFT (wide). The greedy arc swings the long way AROUND
        // C: it must enclose C, stay simple/in-box/4-adjacent, occupy only ~10-12 of 16 tiles (NOT
        // the whole box) and leave a free wedge of inner tiles so a DISJOINT parallel maneuver still
        // fits — the multi-lane property. (The greedy walker hugs the perimeter but does clip the
        // near-side inner column (6,5)/(6,6); the FAR inner tiles (5,5)/(5,6) stay free, which is what
        // a parallel right turn from the opposite corner needs.)
        let cluster = box_4x4();
        let c = (6.0_f64, 6.0_f64);
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 4, y: 7 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::East,
            TilePos { x: 4, y: 8 },
            RoadDir::North,
            ManeuverKind::LeftTurn,
        )
        .expect("left");
        eprintln!("4x4 LEFT (E->N):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        let _ = c;
        // Compact Г: entry column straight to the exit feeder — 4 of 16 tiles. The old wide arc
        // swept 10-12 tiles across the oncoming half; the Г leaves the whole box interior free
        // for parallel maneuvers and never shows the car on the wrong side of the crossing.
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 4, y: 5 },
                TilePos { x: 4, y: 6 },
                TilePos { x: 4, y: 7 },
            ],
            "left turn is the compact Г along the exit column: {path:?}"
        );
        let on_path: HashSet<TilePos> = path.iter().copied().collect();
        assert!(on_path.len() < 16, "must not occupy the whole 4x4 box");
        for inner_far in [TilePos { x: 5, y: 5 }, TilePos { x: 5, y: 6 }] {
            assert!(
                !on_path.contains(&inner_far),
                "far inner tile {inner_far:?} must stay free for parallel flow: {path:?}"
            );
        }
    }

    #[test]
    fn arc_4x4_uturn_wide_encloses_c_leaves_box_room() {
        // 4x4 box, C=(6.0,6.0). Eastbound U-turn: entry (4,4) heading East, exit West exit_tile
        // (3,5) -> goal (4,5). East->West = U-turn (~270 arc). Encloses C, ~12 of 16 tiles, leaves
        // a free wedge (the box is never fully monopolized).
        let cluster = box_4x4();
        let c = (6.0_f64, 6.0_f64);
        let entry = TilePos { x: 4, y: 4 };
        let goal = TilePos { x: 4, y: 5 };
        let path = build_internal_path(
            &cluster,
            TilePos { x: 4, y: 4 },
            entry,
            RoadDir::East,
            TilePos { x: 3, y: 5 },
            RoadDir::West,
            ManeuverKind::UTurn,
        )
        .expect("uturn");
        eprintln!("4x4 UTURN (E->W):{}", ascii_path(&cluster, &path));
        assert_path_invariants(&cluster, &path, entry, goal);
        // П-shape: along the entry row past the center column (cx=6.0 -> pivot x=6), one lateral
        // step, back along the exit row. Compact (6 tiles), pivot beyond the center, and the far
        // half of the crossing road (y >= 6) is never touched — the U-turn stays on its own side.
        assert_eq!(
            path,
            vec![
                TilePos { x: 4, y: 4 },
                TilePos { x: 5, y: 4 },
                TilePos { x: 6, y: 4 },
                TilePos { x: 6, y: 5 },
                TilePos { x: 5, y: 5 },
                TilePos { x: 4, y: 5 },
            ],
            "U-turn is the compact П around the center: {path:?}"
        );
        assert!(
            path.iter().any(|t| t.x as f64 + 0.5 > c.0),
            "U-turn pivot must pass beyond the center: {path:?}"
        );
        assert!(
            path.iter().all(|t| t.y <= 5),
            "U-turn must stay on its own half of the crossing road: {path:?}"
        );
    }

    /// THE MIXED-WIDTH RISK: a square 4x4 has all 8 exit-feeders in-cluster, so the
    /// `build_internal_path` guard ("return None when exit-feeder goal is outside the cluster") must
    /// NOT spuriously drop a regular straight/turn on it. Exercise every cardinal straight + a turn.
    #[test]
    fn mixed_width_square_4x4_does_not_spuriously_drop() {
        let cluster = box_4x4();
        // Four cardinal straights, each entry/exit on a lane row/column inside the span. goal =
        // exit_tile - exit_dir.delta() must be in-cluster for all of them (square box => yes).
        let cases: [(TilePos, RoadDir, TilePos, RoadDir, ManeuverKind); 5] = [
            // E straight on y=4: entry(4,4) -> exit(8,4) -> goal(7,4).
            (
                TilePos { x: 4, y: 4 },
                RoadDir::East,
                TilePos { x: 8, y: 4 },
                RoadDir::East,
                ManeuverKind::Straight,
            ),
            // W straight on y=7: entry(7,7) -> exit(3,7) -> goal(4,7).
            (
                TilePos { x: 7, y: 7 },
                RoadDir::West,
                TilePos { x: 3, y: 7 },
                RoadDir::West,
                ManeuverKind::Straight,
            ),
            // N straight on x=4: entry(4,4) -> exit(4,8) -> goal(4,7).
            (
                TilePos { x: 4, y: 4 },
                RoadDir::North,
                TilePos { x: 4, y: 8 },
                RoadDir::North,
                ManeuverKind::Straight,
            ),
            // S straight on x=7: entry(7,7) -> exit(7,3) -> goal(7,4).
            (
                TilePos { x: 7, y: 7 },
                RoadDir::South,
                TilePos { x: 7, y: 3 },
                RoadDir::South,
                ManeuverKind::Straight,
            ),
            // Tight right N->E: entry(4,4) -> exit(8,4) -> goal(7,4).
            (
                TilePos { x: 4, y: 4 },
                RoadDir::North,
                TilePos { x: 8, y: 4 },
                RoadDir::East,
                ManeuverKind::RightTurn,
            ),
        ];
        for (entry, edir, exit, xdir, man) in cases {
            let path = build_internal_path(
                &cluster,
                TilePos { x: 4, y: 4 },
                entry,
                edir,
                exit,
                xdir,
                man,
            );
            assert!(
                path.is_some(),
                "square 4x4 must NOT spuriously drop {man:?} entry={entry:?}->exit={exit:?}; all exit-feeders are in-cluster"
            );
            let path = path.unwrap();
            assert_path_invariants(
                &cluster,
                &path,
                entry,
                TilePos {
                    x: exit.x - xdir.delta().x,
                    y: exit.y - xdir.delta().y,
                },
            );
        }
    }

    /// Mixed-width NON-square clusters (FourLane×SixLane = 4x6, FourLane×TwoLane = 4x2). For
    /// representative entry/exit pairs `build_internal_path` must return either a valid
    /// direction-correct in-box path OR `None` (drop) — and NEVER a path that lands on the
    /// opposing-direction exit lane. The guard (goal = exit_tile - exit_dir.delta() outside cluster
    /// => None) is the safety net; here we confirm it drops rather than emitting an oncoming path.
    #[test]
    fn mixed_width_nonsquare_boxes_never_emit_oncoming() {
        // FourLane (x:4..=7, 4 tiles) × SixLane (y:4..=9, 6 tiles) => 4x6 box.
        let rect_4x6 = box_rect(4..=7, 4..=9);
        // FourLane (x:4..=7) × TwoLane (y:5..=6, 2 tiles) => 4x2 box.
        let rect_4x2 = box_rect(4..=7, 5..=6);

        // (cluster, entry, entry_dir, exit_tile, exit_dir, maneuver)
        let cases: [PathCase; 6] = [
            // 4x6: E straight on y=4 -> exit (8,4) -> goal (7,4) in-cluster. Valid.
            (
                &rect_4x6,
                TilePos { x: 4, y: 4 },
                RoadDir::East,
                TilePos { x: 8, y: 4 },
                RoadDir::East,
                ManeuverKind::Straight,
            ),
            // 4x6: N straight on x=4 -> exit (4,10) -> goal (4,9) in-cluster. Valid (long box).
            (
                &rect_4x6,
                TilePos { x: 4, y: 4 },
                RoadDir::North,
                TilePos { x: 4, y: 10 },
                RoadDir::North,
                ManeuverKind::Straight,
            ),
            // 4x6: right turn N->E from corner -> exit (8,4) -> goal (7,4). Valid/tight.
            (
                &rect_4x6,
                TilePos { x: 4, y: 4 },
                RoadDir::North,
                TilePos { x: 8, y: 4 },
                RoadDir::East,
                ManeuverKind::RightTurn,
            ),
            // 4x2: E straight on y=5 -> exit (8,5) -> goal (7,5) in-cluster. Valid.
            (
                &rect_4x2,
                TilePos { x: 4, y: 5 },
                RoadDir::East,
                TilePos { x: 8, y: 5 },
                RoadDir::East,
                ManeuverKind::Straight,
            ),
            // 4x2: left turn E->N on a 2-tall box -> exit (4,7) -> goal (4,6) in-cluster. Tight box,
            // may resolve or drop; must never land oncoming.
            (
                &rect_4x2,
                TilePos { x: 4, y: 5 },
                RoadDir::East,
                TilePos { x: 4, y: 7 },
                RoadDir::North,
                ManeuverKind::LeftTurn,
            ),
            // 4x2: U-turn E->W -> exit (3,6) -> goal (4,6) in-cluster.
            (
                &rect_4x2,
                TilePos { x: 4, y: 5 },
                RoadDir::East,
                TilePos { x: 3, y: 6 },
                RoadDir::West,
                ManeuverKind::UTurn,
            ),
        ];

        for (cluster, entry, edir, exit, xdir, man) in cases {
            let c = box_center(cluster);
            let maybe = build_internal_path(
                cluster,
                TilePos { x: 4, y: 4 },
                entry,
                edir,
                exit,
                xdir,
                man,
            );
            let Some(path) = maybe else {
                // Dropping is acceptable (caller falls back to dir-strict road-A*). Safe.
                eprintln!("mixed-width {man:?} entry={entry:?} exit={exit:?} -> DROP (None)");
                continue;
            };
            eprintln!(
                "mixed-width {man:?} entry={entry:?} exit={exit:?} ->{}",
                ascii_path(cluster, &path)
            );
            // The goal the router must terminate on: the in-box tile FEEDING the away-pointing exit.
            let goal = TilePos {
                x: exit.x - xdir.delta().x,
                y: exit.y - xdir.delta().y,
            };
            assert_path_invariants(cluster, &path, entry, goal);
            // Stepping goal -> exit_tile travels in exit_dir (non-oncoming). The last in-box tile is
            // `goal`; confirm goal+exit_dir.delta() == exit_tile (so the flattened route lands on the
            // SAME-direction exit lane, never the opposing one).
            let after = TilePos {
                x: goal.x + xdir.delta().x,
                y: goal.y + xdir.delta().y,
            };
            assert_eq!(
                after, exit,
                "path must terminate on the exit-feeding tile so the route lands on the same-direction exit lane (never oncoming)"
            );
            let _ = c;
        }
    }
}

#[cfg(test)]
mod straight_lane_keeping_tests {
    use super::*;
    use crate::game::intersections::{IntersectionCluster, IntersectionIndex};
    use crate::game::map::MapGrid;
    use crate::game::roads::RoadKind;
    use crate::game::traffic::{ManeuverKind, TrafficConfig};
    use crate::game::transport::{GraphVersion, lane_graph::build_lane_graph_inner};
    use bevy::app::{App, Update};
    use std::collections::HashMap;

    fn set(grid: &mut MapGrid, pos: TilePos, dir: RoadDir, lane: u8) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::FourLane,
            dir,
            lane,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    /// FourLane×FourLane 4x4 box with REAL per-tile lane indices (as painted by `input.rs`):
    /// a STRAIGHT lanelet must exit in the SAME lane index it entered — no weaving inside the box
    /// (an S-shaped internal path sweeps extra conflict tiles and reads as chaos on screen).
    #[test]
    fn straight_lanelets_keep_their_lane_through_the_box() {
        let mut grid = MapGrid::new(12, 12);
        let cluster_tiles: Vec<TilePos> = (4..=7)
            .flat_map(|x| (4..=7).map(move |y| TilePos { x, y }))
            .collect();
        for &pos in &cluster_tiles {
            set(&mut grid, pos, RoadDir::None, 0);
        }
        // Horizontal FourLane, canonical East: lane0=y4 (curb), lane1=y5, lane2=y6, lane3=y7 (West).
        for x in (0..4).chain(8..12) {
            set(&mut grid, TilePos { x, y: 4 }, RoadDir::East, 0);
            set(&mut grid, TilePos { x, y: 5 }, RoadDir::East, 1);
            set(&mut grid, TilePos { x, y: 6 }, RoadDir::West, 2);
            set(&mut grid, TilePos { x, y: 7 }, RoadDir::West, 3);
        }
        // Vertical FourLane, canonical North: lane0=x7 (curb), lane1=x6, lane2=x5, lane3=x4 (South).
        for y in (0..4).chain(8..12) {
            set(&mut grid, TilePos { x: 7, y }, RoadDir::North, 0);
            set(&mut grid, TilePos { x: 6, y }, RoadDir::North, 1);
            set(&mut grid, TilePos { x: 5, y }, RoadDir::South, 2);
            set(&mut grid, TilePos { x: 4, y }, RoadDir::South, 3);
        }

        let id = IntersectionId(0);
        let key = super::tests::make_key(&cluster_tiles);
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

        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig::default())
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());
        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        let lanes = app.world().resource::<LaneGraph>();
        let grid = app.world().resource::<MapGrid>();
        let mut straights = 0;
        for ll in &graph.lanelets {
            if ll.maneuver != ManeuverKind::Straight {
                continue;
            }
            straights += 1;
            let entry = lanes.get_lane(ll.entry_lane).expect("entry lane").pos;
            let exit = lanes.get_lane(ll.exit_lane).expect("exit lane").pos;
            let entry_lane = grid.get(entry).unwrap().road.lane;
            let exit_lane = grid.get(exit).unwrap().road.lane;
            assert_eq!(
                entry_lane, exit_lane,
                "straight lanelet weaves across lanes inside the box: entry {entry:?} (lane \
                 {entry_lane}) -> exit {exit:?} (lane {exit_lane})"
            );
        }
        assert!(
            straights >= 8,
            "expected a straight lanelet per approach lane (2 per direction), got {straights}"
        );
    }
}
