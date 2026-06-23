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

use crate::game::map::TilePos;
use crate::game::roads::RoadDir;
use crate::game::transport::lane_graph::{LaneGraph, LaneId};
use crate::game::transport::lane_pathfinding::{
    LaneCostCtx, base_tile_cost, lane_edge_cost, lane_jitter,
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
}
