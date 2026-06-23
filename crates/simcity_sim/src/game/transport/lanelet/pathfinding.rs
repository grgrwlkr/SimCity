//! Combined RoadLane + Lanelet graph view for correct-by-construction lane-level pathfinding.
//!
//! Nodes are either a road lane-tile (`Road`) or an intersection lanelet (`Lanelet`, one legal
//! entry-lane -> exit-lane maneuver). Intersection traversal happens ONLY via lanelet ENTER/EXIT
//! edges; the legacy turn-blind cluster-tile wiring (`lane_graph::intersection_connections`) is
//! bypassed on the flagged path, so the optimal route lands on the legal feeder lane upstream by
//! construction.
//!
// Scaffolding for the lanelet pathfinder: these items are wired into production at the spawn seam in
// the `find_route` task; until then they are exercised only by tests.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::game::intersections::IntersectionId;
use crate::game::map::TilePos;
use crate::game::roads::RoadDir;
use crate::game::transport::lane_graph::{LaneGraph, LaneId};
use crate::game::transport::lane_pathfinding::{
    LaneCostCtx, base_tile_cost, heuristic_tiles, lane_edge_cost, lane_jitter,
};
use crate::game::transport::lanelet::graph::{LaneletGraph, LaneletId};

/// A node in the combined pathfinding graph.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub(crate) enum CombinedNode {
    Road(LaneId),
    Lanelet(LaneletId),
}

/// Dense, total-order packing of `CombinedNode` into `usize` for A* index vectors: road lanes
/// occupy `[0, road_len)`, lanelets occupy `[road_len, road_len + lanelet_count)`.
#[derive(Copy, Clone)]
pub(crate) struct NodeSpace {
    pub road_len: usize,
}

impl NodeSpace {
    pub(crate) fn new(lg: &LaneGraph) -> Self {
        Self {
            road_len: lg.lanes.len(),
        }
    }

    pub(crate) fn len(&self, llg: &LaneletGraph) -> usize {
        self.road_len + llg.lanelets.len()
    }

    pub(crate) fn pack(&self, node: CombinedNode) -> usize {
        match node {
            CombinedNode::Road(l) => l.0 as usize,
            CombinedNode::Lanelet(ll) => self.road_len + ll.0 as usize,
        }
    }

    pub(crate) fn unpack(&self, idx: usize) -> CombinedNode {
        if idx < self.road_len {
            CombinedNode::Road(LaneId(idx as u32))
        } else {
            CombinedNode::Lanelet(LaneletId((idx - self.road_len) as u32))
        }
    }
}

/// Emit every successor of `node` with its integer edge cost, deterministically (no HashMap
/// iteration in the output). Road nodes: lane-follow forward into a real same-direction road lane
/// (the legacy `dir == None` cluster-entry edge is DROPPED — intersection entry is via ENTER only),
/// lateral lane-changes (`+lane_change_penalty`), and one ENTER edge per legal lanelet feeding this
/// lane (`+turn_penalty + internal-path cost`). Lanelet nodes: one EXIT edge to the exit lane.
pub(crate) fn for_each_succ(
    node: CombinedNode,
    lg: &LaneGraph,
    llg: &LaneletGraph,
    ctx: &LaneCostCtx<'_>,
    mut f: impl FnMut(CombinedNode, u32),
) {
    match node {
        CombinedNode::Road(lid) => {
            let Some(lane) = lg.get_lane(lid) else {
                return;
            };

            // Lane-follow forward: only into a real road lane travelling the same direction.
            let d = lane.dir.delta();
            let fwd = TilePos {
                x: lane.pos.x + d.x,
                y: lane.pos.y + d.y,
            };
            if let Some(&nid) = lg.pos_to_id.get(&fwd)
                && let Some(nl) = lg.get_lane(nid)
                && nl.dir == lane.dir
            {
                f(CombinedNode::Road(nid), lane_edge_cost(ctx, lg, nid));
            }

            // Lateral lane-changes into adjacent same-direction lanes (+lane_change_penalty).
            for side in [lane.dir.left(), lane.dir.right()] {
                if side == RoadDir::None {
                    continue;
                }
                let sd = side.delta();
                let sp = TilePos {
                    x: lane.pos.x + sd.x,
                    y: lane.pos.y + sd.y,
                };
                if let Some(&sid) = lg.pos_to_id.get(&sp)
                    && let Some(sl) = lg.get_lane(sid)
                    && sl.dir == lane.dir
                {
                    let cost = lane_edge_cost(ctx, lg, sid)
                        .saturating_add(ctx.cfg.lane_change_penalty as u32);
                    f(CombinedNode::Road(sid), cost);
                }
            }

            // ENTER edges: each legal lanelet whose entry_lane == this lane (already exit-ascending).
            for &llid in llg.lanelets_from(lid) {
                let Some(ll) = llg.get(llid) else {
                    continue;
                };
                let internal = (ll.internal_path.len() as u32)
                    .saturating_mul(base_tile_cost(lane.kind, ctx.cfg));
                let cost = (ctx.cfg.turn_penalty as u32)
                    .saturating_add(internal)
                    .saturating_add(lane_jitter(ctx.jitter_seed, llid.0));
                f(CombinedNode::Lanelet(llid), cost);
            }
        }
        CombinedNode::Lanelet(llid) => {
            if let Some(ll) = llg.get(llid) {
                f(CombinedNode::Road(ll.exit_lane), 1);
            }
        }
    }
}

/// A* open-set entry over packed combined-node ids. Min-heap on `f`, mirroring the lane A*
/// tie-break (`f` then `g` then node id) so pops are a total order and fully deterministic.
#[derive(PartialEq, Eq)]
struct CombinedHeapState {
    f: u32,
    g: u32,
    idx: usize,
}

impl Ord for CombinedHeapState {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .f
            .cmp(&self.f)
            .then_with(|| other.g.cmp(&self.g))
            .then_with(|| other.idx.cmp(&self.idx))
    }
}

impl PartialOrd for CombinedHeapState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Admissible heuristic from a combined node to the goal tile. A lanelet is represented by the last
/// tile of its internal path (just before its exit); under-counting the EXIT step keeps it a lower
/// bound. Reuses the scaled-Manhattan [`heuristic_tiles`].
fn combined_heuristic(
    node: CombinedNode,
    lg: &LaneGraph,
    llg: &LaneletGraph,
    goal: TilePos,
) -> u32 {
    let pos = match node {
        CombinedNode::Road(l) => lg.get_lane(l).map(|lane| lane.pos),
        CombinedNode::Lanelet(ll) => llg.get(ll).and_then(|l| l.internal_path.last().copied()),
    };
    pos.map(|p| heuristic_tiles(p, goal)).unwrap_or(u32::MAX)
}

fn reconstruct(
    came_from: &[Option<usize>],
    space: &NodeSpace,
    start_idx: usize,
    goal_idx: usize,
) -> Vec<CombinedNode> {
    let mut path = vec![space.unpack(goal_idx)];
    let mut cur = goal_idx;
    while cur != start_idx {
        let Some(prev) = came_from[cur] else {
            break;
        };
        path.push(space.unpack(prev));
        cur = prev;
    }
    path.reverse();
    path
}

/// A* over the combined RoadLane+Lanelet graph. Structural clone of [`find_lane_path`]: dense
/// `best_g`/`came_from` indexed by packed node id, lazy stale-pop, saturating cost. Road edges reuse
/// `lane_edge_cost` verbatim (congestion + per-trip jitter); lanelet ENTER/EXIT edges come from
/// [`for_each_succ`]. Returns the node path (start road .. goal road) or `None` if unreachable.
pub(crate) fn find_combined_path(
    lg: &LaneGraph,
    llg: &LaneletGraph,
    ctx: &LaneCostCtx<'_>,
    start: LaneId,
    goal: LaneId,
) -> Option<Vec<CombinedNode>> {
    if start == goal {
        return Some(vec![CombinedNode::Road(start)]);
    }

    let goal_pos = lg.get_lane(goal)?.pos;
    let space = NodeSpace::new(lg);
    let n = space.len(llg);
    let start_idx = space.pack(CombinedNode::Road(start));
    let goal_idx = space.pack(CombinedNode::Road(goal));

    let mut came_from: Vec<Option<usize>> = vec![None; n];
    let mut best_g: Vec<u32> = vec![u32::MAX; n];
    let mut heap = BinaryHeap::<CombinedHeapState>::new();

    best_g[start_idx] = 0;
    heap.push(CombinedHeapState {
        f: combined_heuristic(CombinedNode::Road(start), lg, llg, goal_pos),
        g: 0,
        idx: start_idx,
    });

    while let Some(CombinedHeapState { g, idx, .. }) = heap.pop() {
        if g != best_g[idx] {
            continue; // Stale entry.
        }
        if idx == goal_idx {
            return Some(reconstruct(&came_from, &space, start_idx, goal_idx));
        }

        let node = space.unpack(idx);
        for_each_succ(node, lg, llg, ctx, |succ, step| {
            let sidx = space.pack(succ);
            let ng = g.saturating_add(step);
            if ng < best_g[sidx] {
                best_g[sidx] = ng;
                came_from[sidx] = Some(idx);
                let f = ng.saturating_add(combined_heuristic(succ, lg, llg, goal_pos));
                heap.push(CombinedHeapState {
                    f,
                    g: ng,
                    idx: sidx,
                });
            }
        });
    }

    None
}

/// Flatten a combined node path into a tile route (the unchanged `Vec<TilePos>` format consumed by
/// `PathPool`/`drive.rs`) plus a cursor-indexed sidecar: each `(offset, intersection, lanelet)`
/// records the route-tile index where that lanelet's internal path begins. The route is strictly
/// 4-adjacent end-to-end (approach -> internal_path[0] -> .. -> internal_path.last() -> exit are all
/// adjacent by the Phase-1 lanelet build geometry); a defensive guard drops any duplicate seam tile.
pub(crate) fn flatten(
    nodes: &[CombinedNode],
    lg: &LaneGraph,
    llg: &LaneletGraph,
) -> (Vec<TilePos>, Vec<(usize, IntersectionId, LaneletId)>) {
    let mut tiles: Vec<TilePos> = Vec::new();
    let mut sidecar: Vec<(usize, IntersectionId, LaneletId)> = Vec::new();

    for node in nodes {
        match node {
            CombinedNode::Road(l) => {
                if let Some(lane) = lg.get_lane(*l)
                    && tiles.last() != Some(&lane.pos)
                {
                    tiles.push(lane.pos);
                }
            }
            CombinedNode::Lanelet(ll) => {
                if let Some(lanelet) = llg.get(*ll) {
                    sidecar.push((tiles.len(), lanelet.intersection, lanelet.id));
                    for &t in &lanelet.internal_path {
                        if tiles.last() != Some(&t) {
                            tiles.push(t);
                        }
                    }
                }
            }
        }
    }

    (tiles, sidecar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::intersections::IntersectionId;
    use crate::game::map::MapGrid;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow, RoadKind};
    use crate::game::traffic::{ManeuverKind, TrafficOccupancy};
    use crate::game::transport::GraphVersion;
    use crate::game::transport::lane_graph::build_lane_graph_inner;
    use crate::game::transport::lanelet::graph::Lanelet;
    use crate::game::transport::pathfinding::PathfindingConfig;

    fn set_lane(grid: &mut MapGrid, pos: TilePos, lane: u8, dir: RoadDir) {
        if let Some(mut cell) = grid.get(pos) {
            cell.water = false;
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir,
                lane,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, cell);
        }
    }

    #[test]
    fn node_space_pack_unpack_roundtrips() {
        let mut grid = MapGrid::new(2, 1);
        set_lane(&mut grid, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 1, y: 0 }, 0, RoadDir::East);
        let lg = build_lane_graph_inner(&grid, &GraphVersion(1));
        let space = NodeSpace::new(&lg);
        let road = CombinedNode::Road(LaneId(1));
        let lanelet = CombinedNode::Lanelet(LaneletId(3));
        assert_eq!(space.unpack(space.pack(road)), road);
        assert_eq!(space.unpack(space.pack(lanelet)), lanelet);
        assert_eq!(
            space.pack(CombinedNode::Lanelet(LaneletId(0))),
            space.road_len
        );
    }

    #[test]
    fn successors_enter_only_legal_lanes_and_are_deterministic() {
        // Two eastbound lanes (y=0, y=1) over x=0..3: an approach lane + a lateral neighbor + forward.
        let mut grid = MapGrid::new(3, 2);
        for x in 0..3 {
            set_lane(&mut grid, TilePos { x, y: 0 }, 0, RoadDir::East);
            set_lane(&mut grid, TilePos { x, y: 1 }, 1, RoadDir::East);
        }
        let lg = build_lane_graph_inner(&grid, &GraphVersion(1));
        let e = lg.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let lateral = lg.get_lane_id(TilePos { x: 0, y: 1 }, 1).unwrap();
        let exit = lg.get_lane_id(TilePos { x: 1, y: 0 }, 0).unwrap();

        // Two lanelets feed `e` (a multi-approach entry); ids ascend by exit_lane.
        let ll0 = Lanelet {
            id: LaneletId(0),
            intersection: IntersectionId(0),
            entry_lane: e,
            exit_lane: exit,
            maneuver: ManeuverKind::Straight,
            internal_path: vec![TilePos { x: 9, y: 9 }, TilePos { x: 9, y: 10 }],
        };
        let ll1 = Lanelet {
            id: LaneletId(1),
            intersection: IntersectionId(0),
            entry_lane: e,
            exit_lane: lateral,
            maneuver: ManeuverKind::LeftTurn,
            internal_path: vec![TilePos { x: 8, y: 8 }],
        };
        let llg = LaneletGraph {
            lanelets: vec![ll0, ll1],
            by_entry_lane: std::collections::HashMap::from([(e, vec![LaneletId(0), LaneletId(1)])]),
            version: 1,
            ..Default::default()
        };

        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let cfg = PathfindingConfig::default();
        let ctx = LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: 0,
        };

        let mut succ = Vec::new();
        for_each_succ(CombinedNode::Road(e), &lg, &llg, &ctx, |n, c| {
            succ.push((n, c))
        });

        // ENTER edges go ONLY to the two lanelets from `e`, in lanelets_from order.
        let enters: Vec<(LaneletId, u32)> = succ
            .iter()
            .filter_map(|(n, c)| match n {
                CombinedNode::Lanelet(id) => Some((*id, *c)),
                _ => None,
            })
            .collect();
        assert_eq!(
            enters.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![LaneletId(0), LaneletId(1)]
        );

        // ENTER cost == turn_penalty + internal_path.len() * base_tile_cost (jitter disabled, seed 0).
        let base = base_tile_cost(RoadKind::TwoLane, &cfg);
        assert_eq!(enters[0].1, cfg.turn_penalty as u32 + 2 * base);
        assert_eq!(enters[1].1, cfg.turn_penalty as u32 + base);

        // Lateral lane-change edge carries +lane_change_penalty.
        let lateral_cost = succ
            .iter()
            .find(|(n, _)| *n == CombinedNode::Road(lateral))
            .map(|(_, c)| *c);
        assert_eq!(
            lateral_cost,
            Some(lane_edge_cost(&ctx, &lg, lateral) + cfg.lane_change_penalty as u32)
        );

        // Determinism: a second call yields a byte-identical sequence.
        let mut succ2 = Vec::new();
        for_each_succ(CombinedNode::Road(e), &lg, &llg, &ctx, |n, c| {
            succ2.push((n, c))
        });
        assert_eq!(succ, succ2);

        // Lanelet EXIT: exactly one edge to Road(exit_lane), cost 1.
        let mut lex = Vec::new();
        for_each_succ(
            CombinedNode::Lanelet(LaneletId(0)),
            &lg,
            &llg,
            &ctx,
            |n, c| lex.push((n, c)),
        );
        assert_eq!(lex, vec![(CombinedNode::Road(exit), 1)]);
    }

    /// Two parallel eastbound corridors over x=0..4 (y=0 lane0, y=1 lane1).
    fn parallel_corridors() -> MapGrid {
        let mut grid = MapGrid::new(4, 2);
        for x in 0..4 {
            set_lane(&mut grid, TilePos { x, y: 0 }, 0, RoadDir::East);
            set_lane(&mut grid, TilePos { x, y: 1 }, 1, RoadDir::East);
        }
        grid
    }

    #[test]
    fn combined_path_deterministic_reduces_to_lane_path_and_spreads() {
        use crate::game::transport::lane_pathfinding::{find_lane_path, lane_path_to_tiles};
        use std::collections::HashSet;

        let grid = parallel_corridors();
        let lg = build_lane_graph_inner(&grid, &GraphVersion(1));
        let llg = LaneletGraph::default(); // intersection-free: no lanelets
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let cfg = PathfindingConfig::default();
        let start = lg.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let goal = lg.get_lane_id(TilePos { x: 3, y: 0 }, 0).unwrap();
        let ctx = |seed: u64| LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: seed,
        };

        // (a) Determinism: same seed -> identical node path.
        let p1 = find_combined_path(&lg, &llg, &ctx(7), start, goal);
        let p2 = find_combined_path(&lg, &llg, &ctx(7), start, goal);
        assert_eq!(p1, p2);

        // (b) Reduction: with no lanelets the combined graph is the road graph, so the flattened
        // tiles equal find_lane_path's tiles (same edges, same costs, same tie-break).
        let combined = find_combined_path(&lg, &llg, &ctx(0), start, goal).expect("combined path");
        let combined_tiles: Vec<TilePos> = combined
            .iter()
            .map(|n| match n {
                CombinedNode::Road(l) => lg.get_lane(*l).unwrap().pos,
                CombinedNode::Lanelet(_) => unreachable!("no lanelets in this grid"),
            })
            .collect();
        let lane_tiles = lane_path_to_tiles(&find_lane_path(&lg, &ctx(0), start, goal), &lg);
        assert_eq!(combined_tiles, lane_tiles);

        // (c) Spread: opposite-corridor endpoints make the y=0-first and y=1-first routes equal cost,
        // so the per-trip jitter (preserved through the combined search) spreads the switch point.
        let goal2 = lg.get_lane_id(TilePos { x: 3, y: 1 }, 1).unwrap();
        let routes: Vec<Vec<CombinedNode>> = (1u64..=64)
            .map(|s| find_combined_path(&lg, &llg, &ctx(s), start, goal2).unwrap())
            .collect();
        let distinct: HashSet<&Vec<CombinedNode>> = routes.iter().collect();
        let max_freq = distinct
            .iter()
            .map(|r| routes.iter().filter(|x| x == r).count())
            .max()
            .unwrap();
        assert!(
            distinct.len() >= 2,
            "expected >=2 route classes, got {}",
            distinct.len()
        );
        assert!(max_freq < 64, "one route monopolized all 64 seeds");
    }

    #[test]
    fn flatten_is_4_adjacent_and_sidecar_offsets_match() {
        // Approach lanes (0,0)E,(1,0)E + exit lane (3,0)E; cluster tile (2,0) is bridged by the
        // lanelet internal_path (it is not a road lane in the grid).
        let mut grid = MapGrid::new(4, 1);
        set_lane(&mut grid, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 1, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 3, y: 0 }, 0, RoadDir::East);
        let lg = build_lane_graph_inner(&grid, &GraphVersion(1));
        let a = lg.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let entry = lg.get_lane_id(TilePos { x: 1, y: 0 }, 0).unwrap();
        let exit = lg.get_lane_id(TilePos { x: 3, y: 0 }, 0).unwrap();

        let ll = Lanelet {
            id: LaneletId(0),
            intersection: IntersectionId(5),
            entry_lane: entry,
            exit_lane: exit,
            maneuver: ManeuverKind::Straight,
            internal_path: vec![TilePos { x: 2, y: 0 }],
        };
        let llg = LaneletGraph {
            lanelets: vec![ll],
            version: 1,
            ..Default::default()
        };

        let nodes = vec![
            CombinedNode::Road(a),
            CombinedNode::Road(entry),
            CombinedNode::Lanelet(LaneletId(0)),
            CombinedNode::Road(exit),
        ];
        let (tiles, sidecar) = flatten(&nodes, &lg, &llg);

        // Strictly 4-adjacent end-to-end, no duplicate consecutive tile.
        for w in tiles.windows(2) {
            assert_eq!((w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs(), 1);
            assert_ne!(w[0], w[1]);
        }
        assert_eq!(
            tiles,
            vec![
                TilePos { x: 0, y: 0 },
                TilePos { x: 1, y: 0 },
                TilePos { x: 2, y: 0 },
                TilePos { x: 3, y: 0 },
            ]
        );

        // Sidecar: one entry whose offset indexes internal_path[0] with matching ids.
        assert_eq!(sidecar.len(), 1);
        let (off, isx, llid) = sidecar[0];
        assert_eq!(tiles[off], llg.get(llid).unwrap().internal_path[0]);
        assert_eq!(isx, IntersectionId(5));
        assert_eq!(llid, LaneletId(0));
    }
}
