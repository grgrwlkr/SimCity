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
/// discipline: turn-only lanes feed only their turn; a Regular lane feeds Straight plus the
/// near-side turn (right for right-hand traffic, left for left-hand traffic).
/// `dir` is the approach travel direction (unused in Phase 1, reserved for future per-lane
/// positional refinement).
#[allow(dead_code)]
pub(crate) fn lane_allows_maneuver(
    lane_type: LaneType,
    maneuver: ManeuverKind,
    _dir: RoadDir,
    drive_on_right: bool,
) -> bool {
    match lane_type {
        LaneType::LeftTurnOnly => matches!(maneuver, ManeuverKind::LeftTurn),
        LaneType::RightTurnOnly => matches!(maneuver, ManeuverKind::RightTurn),
        LaneType::StraightOnly => matches!(maneuver, ManeuverKind::Straight),
        LaneType::Regular => match maneuver {
            ManeuverKind::Straight => true,
            ManeuverKind::RightTurn => drive_on_right,
            ManeuverKind::LeftTurn => !drive_on_right,
            ManeuverKind::Other => false,
        },
    }
}

/// Lane-faithful strictly-4-adjacent path through `cluster_tiles`.
///
/// Tries an L-path first: travel in `entry_dir` from `entry_tile`, bend once into `exit_dir`,
/// reach the goal tile (`exit_tile - exit_dir.delta()`). For a straight (entry_dir == exit_dir)
/// there is no bend. Falls back to BFS when the L-path is invalid (goal not in cluster, any
/// intermediate tile outside cluster, or direction inconsistency).
///
/// Returns tile sequence (entry_tile .. last-in-cluster), all inside the cluster, consecutive
/// pairs Manhattan-distance 1. None if no path exists.
#[allow(dead_code)]
pub(crate) fn build_internal_path(
    cluster_tiles: &HashSet<TilePos>,
    entry_tile: TilePos,
    entry_dir: RoadDir,
    exit_tile: TilePos,
    exit_dir: RoadDir,
) -> Option<Vec<TilePos>> {
    if !cluster_tiles.contains(&entry_tile) {
        return None;
    }

    let ed = entry_dir.delta();
    let xd = exit_dir.delta();
    let goal = TilePos {
        x: exit_tile.x - xd.x,
        y: exit_tile.y - xd.y,
    };

    if cluster_tiles.contains(&goal)
        && let Some(path) = build_l_path(cluster_tiles, entry_tile, ed, xd, goal)
    {
        return Some(path);
    }

    build_internal_path_bfs(cluster_tiles, entry_tile, exit_tile)
}

fn build_l_path(
    cluster_tiles: &HashSet<TilePos>,
    entry_tile: TilePos,
    entry_delta: IVec2,
    exit_delta: IVec2,
    goal: TilePos,
) -> Option<Vec<TilePos>> {
    if entry_tile == goal {
        return Some(vec![entry_tile]);
    }

    let mut path: Vec<TilePos> = Vec::new();
    path.push(entry_tile);

    if entry_delta == exit_delta {
        // Straight: step in entry_delta from entry_tile until reaching goal.
        // Verify they are collinear and entry_delta points toward goal.
        let dx = goal.x - entry_tile.x;
        let dy = goal.y - entry_tile.y;
        // Collinear check: if entry_delta is horizontal, dy must be 0; if vertical, dx must be 0.
        if entry_delta.x != 0 && dy != 0 {
            return None;
        }
        if entry_delta.y != 0 && dx != 0 {
            return None;
        }
        // Direction must point from entry toward goal.
        if entry_delta.x != 0 && dx.signum() != entry_delta.x.signum() {
            return None;
        }
        if entry_delta.y != 0 && dy.signum() != entry_delta.y.signum() {
            return None;
        }
        let mut cur = entry_tile;
        loop {
            let next = TilePos {
                x: cur.x + entry_delta.x,
                y: cur.y + entry_delta.y,
            };
            if !cluster_tiles.contains(&next) {
                return None;
            }
            path.push(next);
            if next == goal {
                break;
            }
            cur = next;
        }
    } else {
        // Turn: entry_delta and exit_delta are perpendicular.
        // Verify they are actually perpendicular (dot product == 0).
        if entry_delta.x * exit_delta.x + entry_delta.y * exit_delta.y != 0 {
            return None;
        }
        // Bend point B: has the entry_delta axis coordinate of goal and
        // the exit_delta axis coordinate of entry_tile.
        //
        // entry_delta changes one axis (E). exit_delta changes the other (X).
        // B.E = goal.E, B.X = entry_tile.X.
        let bend = if entry_delta.x != 0 {
            // entry moves in x; exit moves in y
            TilePos {
                x: goal.x,
                y: entry_tile.y,
            }
        } else {
            // entry moves in y; exit moves in x
            TilePos {
                x: entry_tile.x,
                y: goal.y,
            }
        };

        // Segment 1: entry_tile → bend in entry_delta direction.
        if bend != entry_tile {
            let dx = bend.x - entry_tile.x;
            let dy = bend.y - entry_tile.y;
            // entry_delta must point toward bend.
            if entry_delta.x != 0 && dx.signum() != entry_delta.x.signum() {
                return None;
            }
            if entry_delta.y != 0 && dy.signum() != entry_delta.y.signum() {
                return None;
            }
            let mut cur = entry_tile;
            loop {
                let next = TilePos {
                    x: cur.x + entry_delta.x,
                    y: cur.y + entry_delta.y,
                };
                if !cluster_tiles.contains(&next) {
                    return None;
                }
                path.push(next);
                if next == bend {
                    break;
                }
                cur = next;
            }
        }

        // Segment 2: bend → goal in exit_delta direction.
        if bend != goal {
            let dx = goal.x - bend.x;
            let dy = goal.y - bend.y;
            if exit_delta.x != 0 && dx.signum() != exit_delta.x.signum() {
                return None;
            }
            if exit_delta.y != 0 && dy.signum() != exit_delta.y.signum() {
                return None;
            }
            let mut cur = bend;
            loop {
                let next = TilePos {
                    x: cur.x + exit_delta.x,
                    y: cur.y + exit_delta.y,
                };
                if !cluster_tiles.contains(&next) {
                    return None;
                }
                path.push(next);
                if next == goal {
                    break;
                }
                cur = next;
            }
        }
    }

    Some(path)
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
/// Early-returns if `!traffic_cfg.experimental_lanelet_intersections` or if the graph is already
/// built for the current `GraphVersion`.
pub fn build_lanelet_graph(
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    lanes: Res<LaneGraph>,
    gv: Res<GraphVersion>,
    traffic_cfg: Res<TrafficConfig>,
    mut graph: ResMut<LaneletGraph>,
    mut matrices: ResMut<LaneletConflictMatrices>,
) {
    if !traffic_cfg.experimental_lanelet_intersections || graph.is_built_for(gv.0) {
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
                    first_cluster_tile,
                    entry_dir,
                    exit_tile,
                    exit_dir,
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
    fn internal_path_is_strictly_4_adjacent_never_diagonal() {
        // Westbound straight: entry from east side, exit to west side on same row.
        // L-path stays on y=64 (no bend for straight).
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 30, y: 64 };
        let path = build_internal_path(&cluster, entry, RoadDir::West, exit, RoadDir::West)
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
    fn turn_shape_ends_adjacent_to_south_exit() {
        // Westbound entry, southbound exit: L-path bends from y=64 down to y=61.
        // exit_dir=South means delta=(0,-1); goal = {x:32, y:60} - (0,-1) = {x:32, y:61}.
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 32, y: 60 };
        let path = build_internal_path(&cluster, entry, RoadDir::West, exit, RoadDir::South)
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
        assert!(build_internal_path(&cluster, entry, RoadDir::West, exit, RoadDir::West).is_none());
    }

    #[test]
    fn entry_is_the_goal_returns_single_tile_path() {
        // Single-tile cluster; entry == goal (exit_tile - exit_dir.delta() = {31,61}).
        let cluster: HashSet<TilePos> = [(31, 61)].iter().map(|&(x, y)| TilePos { x, y }).collect();
        let entry = TilePos { x: 31, y: 61 };
        let exit = TilePos { x: 30, y: 61 };
        let path = build_internal_path(&cluster, entry, RoadDir::West, exit, RoadDir::West)
            .expect("path exists");
        assert_eq!(path.len(), 1);
        assert_eq!(path[0], entry);
    }

    #[test]
    fn equidistant_goals_xy_min_wins() {
        // cluster has two goals equidistant from entry; BFS fallback is exercised because the
        // L-path (entry_dir=East straight) fails: goal {4,5} has dy=1 from entry {3,4} but
        // entry_delta.y=0, so the straight check rejects it and we fall through to BFS.
        // BFS picks the (x,y)-min goal {4,5} over any other equidistant candidate.
        let cluster: HashSet<TilePos> = [(3, 4), (4, 4), (5, 4), (3, 5), (4, 5)]
            .iter()
            .map(|&(x, y)| TilePos { x, y })
            .collect();
        let entry = TilePos { x: 3, y: 4 };
        // exit_tile={5,5} outside cluster; exit_dir=East → goal={4,5} (in cluster).
        let exit = TilePos { x: 5, y: 5 };
        let path = build_internal_path(&cluster, entry, RoadDir::East, exit, RoadDir::East)
            .expect("path exists");
        let last = *path.last().unwrap();
        assert_eq!(
            last,
            TilePos { x: 4, y: 5 },
            "expected (x,y)-min goal (4,5) but got {:?}",
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
            .insert_resource(TrafficConfig {
                experimental_lanelet_intersections: true,
                ..Default::default()
            })
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
    fn build_lanelet_graph_flag_off_leaves_graph_empty() {
        let (grid, intersection_index) = build_cross_grid();
        let gv = GraphVersion(1);
        let lane_graph = build_lane_graph_inner(&grid, &gv);

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(intersection_index)
            .insert_resource(lane_graph)
            .insert_resource(gv)
            .insert_resource(TrafficConfig {
                experimental_lanelet_intersections: false,
                ..Default::default()
            })
            .insert_resource(LaneletGraph::default())
            .insert_resource(LaneletConflictMatrices::default());

        app.add_systems(Update, build_lanelet_graph);
        app.update();

        let graph = app.world().resource::<LaneletGraph>();
        assert!(
            graph.lanelets.is_empty(),
            "lanelets must stay empty when flag is off"
        );
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
            .insert_resource(TrafficConfig {
                experimental_lanelet_intersections: true,
                ..Default::default()
            })
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
            .insert_resource(TrafficConfig {
                experimental_lanelet_intersections: true,
                ..Default::default()
            })
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
            .insert_resource(TrafficConfig {
                experimental_lanelet_intersections: true,
                ..Default::default()
            })
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
            TilePos { x: 34, y: 63 },
            RoadDir::West,
            TilePos { x: 30, y: 63 },
            RoadDir::West,
        )
        .unwrap();
        let pb = build_internal_path(
            &cluster,
            TilePos { x: 34, y: 64 },
            RoadDir::West,
            TilePos { x: 30, y: 64 },
            RoadDir::West,
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
            .insert_resource(TrafficConfig {
                experimental_lanelet_intersections: true,
                ..Default::default()
            })
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
        assert!(!lane_allows_maneuver(
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
        assert!(!lane_allows_maneuver(
            LaneType::Regular,
            ManeuverKind::RightTurn,
            RoadDir::North,
            false
        ));
    }
}
