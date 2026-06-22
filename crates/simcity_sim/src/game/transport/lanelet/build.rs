use std::collections::{HashMap, HashSet, VecDeque};

use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, IntersectionIndex};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadDir, RoadFlow};
use crate::game::traffic::{ManeuverKind, TrafficConfig, maneuver_kind};
use crate::game::transport::{GraphVersion, LaneGraph};

use super::conflict::ConflictMatrix;
use super::graph::{Lanelet, LaneletGraph, LaneletId};

/// Per-intersection conflict matrices built by `build_lanelet_graph`.
#[derive(Resource, Default)]
pub struct LaneletConflictMatrices {
    pub by_intersection: HashMap<IntersectionId, ConflictMatrix>,
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

/// Shortest strictly-4-adjacent path through `cluster_tiles` from `entry_tile` to the cluster tile
/// orthogonally adjacent to `exit_tile`. Returns the tile sequence (entry .. last-in-cluster), all
/// inside the cluster, every consecutive pair Manhattan-distance 1. None if no in-cluster path exists.
///
/// Among goals equidistant from `entry_tile`, picks the `(x,y)`-minimum deterministically.
#[allow(dead_code)]
pub(crate) fn build_internal_path(
    cluster_tiles: &HashSet<TilePos>,
    entry_tile: TilePos,
    exit_tile: TilePos,
) -> Option<Vec<TilePos>> {
    if !cluster_tiles.contains(&entry_tile) {
        return None;
    }

    // Find goal candidates: cluster tiles orthogonally adjacent to exit_tile.
    let neighbors_of_exit = orthogonal_neighbors(exit_tile);
    let goals: HashSet<TilePos> = neighbors_of_exit
        .into_iter()
        .filter(|t| cluster_tiles.contains(t))
        .collect();

    if goals.is_empty() {
        return None;
    }

    // BFS to completion: record came_from for all reachable cluster tiles.
    // For each goal reached, record the BFS distance (depth).
    // After BFS, pick the goal with minimum distance; break ties by (x, y).
    let mut came_from: HashMap<TilePos, Option<TilePos>> = HashMap::new();
    let mut dist: HashMap<TilePos, u32> = HashMap::new();
    let mut queue: VecDeque<TilePos> = VecDeque::new();

    came_from.insert(entry_tile, None);
    dist.insert(entry_tile, 0);
    queue.push_back(entry_tile);

    // Deterministic neighbor order: E, W, N, S.
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

    // Among reached goals, pick minimum distance then (x, y)-minimum tiebreak.
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
    matrices.by_intersection.clear();

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

                // BFS from the first cluster tile (which the approach lane feeds into)
                // towards the exit lane tile (which is outside the cluster).
                let Some(internal_path) =
                    build_internal_path(&cluster_tiles, first_cluster_tile, exit_tile)
                else {
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
            graph.lanelets.push(lanelet);
        }

        graph.by_intersection.insert(cluster.id, intersection_ids);

        let matrix = ConflictMatrix::from_paths(&sorted_paths);
        matrices.by_intersection.insert(cluster.id, matrix);
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

        let mut index = IntersectionIndex::default();
        index.clusters = vec![cluster];
        index.tile_to_intersection = tile_to_intersection;
        index.version = 1;

        (grid, index)
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
