//! Combined RoadLane + Lanelet graph view for correct-by-construction lane-level pathfinding.
//!
//! Nodes are either a road lane-tile (`Road`) or an intersection lanelet (`Lanelet`, one legal
//! entry-lane -> exit-lane maneuver). Intersection traversal happens ONLY via lanelet ENTER/EXIT
//! edges, so the optimal route lands on the legal feeder lane upstream by construction. This is
//! the sole lane-level router (the legacy standalone lane A* has been removed).

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::game::intersections::IntersectionId;
use crate::game::map::{MapGrid, TilePos};
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
            // HARD-SKIP any neighbor that would be entered against its own lane direction
            // (`nl.dir == lane.dir.opposite()`) — never a soft penalty, so an oncoming tile can
            // never enter the open set by construction.
            let d = lane.dir.delta();
            let fwd = TilePos {
                x: lane.pos.x + d.x,
                y: lane.pos.y + d.y,
            };
            if let Some(&nid) = lg.pos_to_id.get(&fwd)
                && let Some(nl) = lg.get_lane(nid)
                && nl.dir == lane.dir
                && nl.dir != lane.dir.opposite()
            {
                f(CombinedNode::Road(nid), lane_edge_cost(ctx, lg, nid));
            }

            // Lateral lane-changes into adjacent same-direction lanes (+lane_change_penalty).
            // Same hard-skip: a lateral neighbor is only legal if it carries the SAME direction
            // (a wrong-direction neighbor is the oncoming lane and is never expanded).
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
                    && sl.dir != lane.dir.opposite()
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

/// A* over the combined RoadLane+Lanelet graph: dense `best_g`/`came_from` indexed by packed node
/// id, lazy stale-pop, saturating cost. Road edges reuse `lane_edge_cost` verbatim (congestion +
/// per-trip jitter); lanelet ENTER/EXIT edges come from [`for_each_succ`]. Returns the node path
/// (start road .. goal road) or `None` if unreachable.
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

/// Cardinal step from `a` to its 4-adjacent neighbor `b`; `RoadDir::None` for non-adjacent.
pub(crate) fn dir_between_adjacent(a: TilePos, b: TilePos) -> RoadDir {
    match (b.x - a.x, b.y - a.y) {
        (1, 0) => RoadDir::East,
        (-1, 0) => RoadDir::West,
        (0, 1) => RoadDir::North,
        (0, -1) => RoadDir::South,
        _ => RoadDir::None,
    }
}

/// First consecutive route pair `(a, b)` that travels against a lane direction, if any.
///
/// Two checks per pair (both only against REAL road tiles; intersection-box tiles carry
/// `dir == None` and are exempt — their in-box path is collision-checked, not direction-checked):
/// - LEAVING `a` against `a`'s own lane direction (`step == a.dir.opposite()`), and
/// - ENTERING `b` against `b`'s lane direction (`step == b.dir.opposite()`). This closes the
///   box-exit blind spot: a route stepping from an exempt box tile onto the oncoming carriageway
///   was invisible to the `a`-side check alone (наблюдалось вживую как «выезд на встречку на
///   перекрёстке»). Perpendicular entries (lane changes, merges) are unaffected.
pub(crate) fn first_oncoming_pair(route: &[TilePos], grid: &MapGrid) -> Option<(TilePos, TilePos)> {
    for w in route.windows(2) {
        let (a, b) = (w[0], w[1]);
        let step = dir_between_adjacent(a, b);
        if step == RoadDir::None {
            continue; // non-adjacent pair (degenerate route): not direction-checkable.
        }
        if let Some(cell) = grid.get(a)
            && cell.road.dir != RoadDir::None
            && step == cell.road.dir.opposite()
        {
            return Some((a, b));
        }
        if let Some(cell) = grid.get(b)
            && cell.road.is_some()
            && cell.road.dir != RoadDir::None
            && step == cell.road.dir.opposite()
        {
            return Some((a, b));
        }
    }
    None
}

/// True iff no consecutive pair in `route` traverses a real road tile against its `road.dir`.
pub(crate) fn route_is_direction_correct(route: &[TilePos], grid: &MapGrid) -> bool {
    first_oncoming_pair(route, grid).is_none()
}

/// Routing seam at vehicle spawn. Runs the combined lane+lanelet A* and flattens it. Returns the
/// `Vec<TilePos>` route plus the lanelet sidecar; an EMPTY route signals the caller to fall back to
/// road-level pathfinding.
///
/// Post-route direction guard (the net): the assembled route is rejected if any real road tile is
/// traversed against its lane direction (oncoming). In debug this is a `debug_assert!` so a producer
/// regression fails tests loudly; in release the route is dropped (returned EMPTY) so the caller
/// falls back to the dir-strict road-A* path or holds the vehicle, rather than driving it onto the
/// oncoming lane.
pub(crate) fn find_route(
    lg: &LaneGraph,
    llg: &LaneletGraph,
    ctx: &LaneCostCtx<'_>,
    start: LaneId,
    goal: LaneId,
) -> (Vec<TilePos>, Vec<(usize, IntersectionId, LaneletId)>) {
    let (tiles, sidecar) = match find_combined_path(lg, llg, ctx, start, goal) {
        Some(nodes) => flatten(&nodes, lg, llg),
        None => return (Vec::new(), Vec::new()),
    };

    if !route_is_direction_correct(&tiles, ctx.grid) {
        let pair = first_oncoming_pair(&tiles, ctx.grid);
        debug_assert!(
            false,
            "lanelet route produced an oncoming step {:?} (against road.dir {:?}); \
             a producer is emitting wrong-direction tiles",
            pair,
            pair.and_then(|(a, _)| ctx.grid.get(a)).map(|c| c.road.dir),
        );
        return (Vec::new(), Vec::new());
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
    fn combined_path_deterministic_takes_straight_corridor_and_spreads() {
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

        // (b) Straight-corridor oracle: with no lanelets, no congestion and jitter disabled, the
        // optimal route is the straight y=0 corridor (any lane change costs +lane_change_penalty).
        let combined = find_combined_path(&lg, &llg, &ctx(0), start, goal).expect("combined path");
        let combined_tiles: Vec<TilePos> = combined
            .iter()
            .map(|n| match n {
                CombinedNode::Road(l) => lg.get_lane(*l).unwrap().pos,
                CombinedNode::Lanelet(_) => unreachable!("no lanelets in this grid"),
            })
            .collect();
        let expected: Vec<TilePos> = (0..4).map(|x| TilePos { x, y: 0 }).collect();
        assert_eq!(combined_tiles, expected);

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
    fn congestion_pushes_combined_path_onto_parallel_corridor() {
        // Ported from the removed legacy lane-A* suite: lane_edge_cost's live-congestion
        // factor must push the route onto the free parallel corridor.
        let grid = parallel_corridors();
        let lg = build_lane_graph_inner(&grid, &GraphVersion(1));
        let llg = LaneletGraph::default(); // intersection-free: no lanelets

        // Congest the lower corridor (y=0) at x=1 and x=2.
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let i10 = grid.idx(TilePos { x: 1, y: 0 }).unwrap();
        let i20 = grid.idx(TilePos { x: 2, y: 0 }).unwrap();
        traffic.per_tick_vehicles[i10] = 8;
        traffic.per_tick_vehicles[i20] = 8;

        let cfg = PathfindingConfig::default();
        let ctx = LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: 0, // tie-break disabled: isolate congestion behavior
        };

        let start = lg.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let goal = lg.get_lane_id(TilePos { x: 3, y: 0 }, 0).unwrap();
        let path = find_combined_path(&lg, &llg, &ctx, start, goal).expect("path");
        let tiles: Vec<TilePos> = path
            .iter()
            .map(|n| match n {
                CombinedNode::Road(l) => lg.get_lane(*l).unwrap().pos,
                CombinedNode::Lanelet(_) => unreachable!("no lanelets in this grid"),
            })
            .collect();

        assert_eq!(tiles.first(), Some(&TilePos { x: 0, y: 0 }));
        assert_eq!(tiles.last(), Some(&TilePos { x: 3, y: 0 }));

        // Route must detour onto the y=1 corridor and avoid the congested y=0 tiles.
        assert!(
            tiles.iter().any(|t| t.y == 1),
            "expected detour onto parallel corridor y=1"
        );
        assert!(
            !tiles
                .iter()
                .any(|t| *t == TilePos { x: 1, y: 0 } || *t == TilePos { x: 2, y: 0 }),
            "expected to avoid congested y=0 tiles"
        );
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

    #[test]
    fn route_direction_guard_accepts_forward_rejects_oncoming() {
        // A 3-tile eastbound road x=0..2. A correct route steps E,E (with the lane direction).
        let mut grid = MapGrid::new(3, 1);
        for x in 0..3 {
            set_lane(&mut grid, TilePos { x, y: 0 }, 0, RoadDir::East);
        }
        let forward = vec![
            TilePos { x: 0, y: 0 },
            TilePos { x: 1, y: 0 },
            TilePos { x: 2, y: 0 },
        ];
        assert!(
            route_is_direction_correct(&forward, &grid),
            "forward route on eastbound lanes must be direction-correct"
        );
        assert_eq!(first_oncoming_pair(&forward, &grid), None);

        // Hand-built oncoming route: stepping WEST across eastbound tiles. (2,0) is a real road tile
        // with dir East; stepping to (1,0) is East.opposite() == West => oncoming.
        let oncoming = vec![
            TilePos { x: 2, y: 0 },
            TilePos { x: 1, y: 0 },
            TilePos { x: 0, y: 0 },
        ];
        assert!(
            !route_is_direction_correct(&oncoming, &grid),
            "westbound traversal of eastbound lanes must be flagged oncoming"
        );
        assert_eq!(
            first_oncoming_pair(&oncoming, &grid),
            Some((TilePos { x: 2, y: 0 }, TilePos { x: 1, y: 0 })),
            "first oncoming pair is the first wrong-direction step"
        );
    }

    #[test]
    fn route_direction_guard_exempts_intersection_box_tiles() {
        // A box tile (dir == None) is exempt as the leading tile of a pair even if the geometric
        // step looks reversed; only REAL road tiles are direction-checked.
        let mut grid = MapGrid::new(3, 1);
        set_lane(&mut grid, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 2, y: 0 }, 0, RoadDir::East);
        // (1,0) is a cluster/box tile: dir None.
        if let Some(mut cell) = grid.get(TilePos { x: 1, y: 0 }) {
            cell.water = false;
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::None,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(TilePos { x: 1, y: 0 }, cell);
        }
        // Route passes through the box tile; the box tile -> exit step is fine, exit steps in-dir.
        let route = vec![
            TilePos { x: 0, y: 0 },
            TilePos { x: 1, y: 0 },
            TilePos { x: 2, y: 0 },
        ];
        assert!(route_is_direction_correct(&route, &grid));
    }

    #[test]
    fn find_route_rejects_lanelet_route_that_traverses_oncoming_lane() {
        // RED-before-fix scenario, asserted GREEN. A hand-built lanelet feeds the route onto a
        // WESTBOUND lane, and the route then continues westward over two more westbound tiles. The
        // flattened route therefore traverses the eastbound approach correctly but then drives the
        // wrong way down the westbound corridor — a real-road oncoming step. The post-route guard in
        // `find_route` must reject it (debug_assert in test builds; EMPTY route in release) rather
        // than hand the caller a route that runs against `road.dir`.
        let cfg = PathfindingConfig::default();
        // Eastbound approach (0,0)E,(1,0)E; box tile (2,0); westbound corridor (3,0)W,(4,0)W,(5,0)W.
        let mut grid = MapGrid::new(6, 1);
        set_lane(&mut grid, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 1, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 3, y: 0 }, 0, RoadDir::West);
        set_lane(&mut grid, TilePos { x: 4, y: 0 }, 0, RoadDir::West);
        set_lane(&mut grid, TilePos { x: 5, y: 0 }, 0, RoadDir::West);
        let lg = build_lane_graph_inner(&grid, &GraphVersion(1));
        let entry = lg.get_lane_id(TilePos { x: 1, y: 0 }, 0).unwrap();
        let bad_exit = lg.get_lane_id(TilePos { x: 3, y: 0 }, 0).unwrap();
        let ll = Lanelet {
            id: LaneletId(0),
            intersection: IntersectionId(7),
            entry_lane: entry,
            exit_lane: bad_exit,
            maneuver: ManeuverKind::Straight,
            internal_path: vec![TilePos { x: 2, y: 0 }],
        };
        let llg = LaneletGraph {
            lanelets: vec![ll],
            version: 1,
            ..Default::default()
        };
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let ctx = LaneCostCtx {
            grid: &grid,
            traffic: &traffic,
            cfg: &cfg,
            jitter_seed: 0,
        };

        // The raw flatten of an end-to-end node path traverses (3,0)->(4,0) which is EAST against
        // the West lane dir of (3,0): oncoming. (This is the bug the guard nets.)
        let west4 = lg.get_lane_id(TilePos { x: 4, y: 0 }, 0).unwrap();
        let west5 = lg.get_lane_id(TilePos { x: 5, y: 0 }, 0).unwrap();
        let nodes = vec![
            CombinedNode::Road(entry),
            CombinedNode::Lanelet(LaneletId(0)),
            CombinedNode::Road(bad_exit),
            CombinedNode::Road(west4),
            CombinedNode::Road(west5),
        ];
        let (raw_tiles, _) = flatten(&nodes, &lg, &llg);
        assert_eq!(
            first_oncoming_pair(&raw_tiles, &grid),
            // The b-side check flags the violation at the EARLIEST offending step — the box-exit
            // ONTO the westbound tile (2,0)->(3,0) — one pair before the old a-side-only detection.
            Some((TilePos { x: 2, y: 0 }, TilePos { x: 3, y: 0 })),
            "precondition: the unguarded flattened route drives oncoming down the westbound corridor: {raw_tiles:?}"
        );

        // The guard rejects it: debug builds trip the debug_assert (tests run in debug, proving the
        // net is armed and loud); a release build would drop the route to EMPTY. We accept either,
        // but NEVER a non-empty oncoming route.
        let start = lg.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let prev_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // silence the expected debug_assert backtrace
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            find_route(&lg, &llg, &ctx, start, west5)
        }));
        std::panic::set_hook(prev_hook);
        match result {
            Err(_) => { /* debug_assert tripped: producer regression caught loudly. */ }
            Ok((tiles, _)) => assert!(
                first_oncoming_pair(&tiles, &grid).is_none(),
                "guard must never return an oncoming route, got {tiles:?}"
            ),
        }
    }

    #[test]
    fn find_route_emits_sidecar_through_lanelet() {
        let cfg = PathfindingConfig::default();
        // The only route from (1,0) to (3,0) bridges the (2,0) gap via a lanelet, so the
        // sidecar is non-empty and the route steps through the lanelet's internal tile.
        let mut g2 = MapGrid::new(4, 1);
        set_lane(&mut g2, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut g2, TilePos { x: 1, y: 0 }, 0, RoadDir::East);
        set_lane(&mut g2, TilePos { x: 3, y: 0 }, 0, RoadDir::East);
        let lg2 = build_lane_graph_inner(&g2, &GraphVersion(1));
        let s2 = lg2.get_lane_id(TilePos { x: 0, y: 0 }, 0).unwrap();
        let entry = lg2.get_lane_id(TilePos { x: 1, y: 0 }, 0).unwrap();
        let exit = lg2.get_lane_id(TilePos { x: 3, y: 0 }, 0).unwrap();
        let ll = Lanelet {
            id: LaneletId(0),
            intersection: IntersectionId(2),
            entry_lane: entry,
            exit_lane: exit,
            maneuver: ManeuverKind::Straight,
            internal_path: vec![TilePos { x: 2, y: 0 }],
        };
        let llg2 = LaneletGraph {
            lanelets: vec![ll],
            by_entry_lane: std::collections::HashMap::from([(entry, vec![LaneletId(0)])]),
            version: 1,
            ..Default::default()
        };
        let mut traffic2 = TrafficOccupancy::default();
        traffic2.ensure_len(g2.len());
        let ctx2 = LaneCostCtx {
            grid: &g2,
            traffic: &traffic2,
            cfg: &cfg,
            jitter_seed: 0,
        };
        let (tiles_on, side_on) = find_route(&lg2, &llg2, &ctx2, s2, exit);
        assert_eq!(
            tiles_on,
            vec![
                TilePos { x: 0, y: 0 },
                TilePos { x: 1, y: 0 },
                TilePos { x: 2, y: 0 },
                TilePos { x: 3, y: 0 },
            ]
        );
        assert_eq!(side_on.len(), 1);
        assert_eq!(side_on[0].1, IntersectionId(2));
        assert_eq!(side_on[0].2, LaneletId(0));
    }
}
