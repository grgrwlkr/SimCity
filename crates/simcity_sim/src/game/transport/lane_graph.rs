//! Lane-based graph for pathfinding on lane-tiles.
//!
//! In this project a road "lane" is already represented as an individual map tile (`RoadCell`).
//! Therefore graph nodes must map 1:1 to lane-tiles (not to road-kind lane count).

use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{RoadDir, RoadKind};

use super::GraphVersion;

/// Unique identifier for a lane node.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub struct LaneId(pub u32);

impl LaneId {
    pub const INVALID: LaneId = LaneId(u32::MAX);

    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// A single lane node (1 lane-tile = 1 node).
#[derive(Debug, Clone)]
pub struct Lane {
    pub id: LaneId,
    /// Tile position this lane belongs to.
    pub pos: TilePos,
    /// Lane index within the carriageway cross-section.
    pub lane_idx: u8,
    /// Travel direction for this lane (`None` for intersection cluster tiles).
    pub dir: RoadDir,
    /// Road kind (affects speed limit/capacity heuristics).
    pub kind: RoadKind,
}

/// Lane-based graph for routing.
#[derive(Resource, Debug, Default)]
pub struct LaneGraph {
    pub version: u64,
    pub lanes: Vec<Lane>,
    /// Directed connections: lane_id -> next lane_ids.
    pub connections: HashMap<LaneId, Vec<LaneId>>,
    /// Lookup: (tile_pos, lane_idx) -> lane_id.
    pub tile_lane_to_id: HashMap<(TilePos, u8), LaneId>,
    /// Fast lookup: tile_pos -> lane_id (lane-tile model: one lane per tile).
    pub pos_to_id: HashMap<TilePos, LaneId>,
}

impl LaneGraph {
    pub fn is_built_for(&self, version: u64) -> bool {
        self.version == version && !self.lanes.is_empty()
    }

    pub fn get_lane(&self, id: LaneId) -> Option<&Lane> {
        self.lanes.get(id.as_usize())
    }

    pub fn get_connections(&self, id: LaneId) -> &[LaneId] {
        self.connections
            .get(&id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn get_lane_id(&self, pos: TilePos, lane_idx: u8) -> Option<LaneId> {
        self.tile_lane_to_id.get(&(pos, lane_idx)).copied()
    }

    fn lane_id_at_pos(&self, pos: TilePos) -> Option<LaneId> {
        self.pos_to_id.get(&pos).copied()
    }

    /// Returns the lane at `pos` only if it matches requested travel direction.
    ///
    /// In lane-tile mode this is effectively a direction validation guard.
    pub fn get_rightmost_lane(&self, pos: TilePos, dir: RoadDir) -> Option<LaneId> {
        let lane_id = self.lane_id_at_pos(pos)?;
        let lane = self.get_lane(lane_id)?;
        if dir == RoadDir::None || lane.dir == dir {
            Some(lane_id)
        } else {
            None
        }
    }

    /// Convert lane_id + s-coordinate to tile position.
    pub fn lane_s_to_tile_pos(&self, lane_id: LaneId, _lane_s: f32) -> Option<TilePos> {
        self.get_lane(lane_id).map(|l| l.pos)
    }
}

/// Build lane graph from map grid.
pub fn build_lane_graph_inner(grid: &MapGrid, version: &GraphVersion) -> LaneGraph {
    let mut graph = LaneGraph {
        version: version.0,
        ..Default::default()
    };

    // Phase 1: 1 node per lane-tile.
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if !cell.road.is_some() {
                continue;
            }

            let lane_id = LaneId(graph.lanes.len() as u32);
            let lane = Lane {
                id: lane_id,
                pos,
                lane_idx: cell.road.lane,
                dir: cell.road.dir,
                kind: cell.road.kind,
            };
            graph.lanes.push(lane);
            graph.tile_lane_to_id.insert((pos, cell.road.lane), lane_id);
            graph.pos_to_id.insert(pos, lane_id);
        }
    }

    // Phase 2: directed adjacency.
    build_lane_connections(&mut graph);
    graph
}

/// Bevy system wrapper.
pub fn build_lane_graph(
    grid: Res<MapGrid>,
    version: Res<GraphVersion>,
    mut lane_graph: ResMut<LaneGraph>,
) {
    *lane_graph = build_lane_graph_inner(&grid, &version);
}

fn build_lane_connections(graph: &mut LaneGraph) {
    graph.connections.clear();
    let ids: Vec<LaneId> = graph.lanes.iter().map(|l| l.id).collect();

    for lane_id in ids {
        let Some(lane) = graph.get_lane(lane_id).cloned() else {
            continue;
        };
        let mut out = if lane.dir == RoadDir::None {
            intersection_connections(graph, &lane)
        } else {
            road_lane_connections(graph, &lane)
        };
        out.sort_unstable_by_key(|id| id.0);
        out.dedup();
        graph.connections.insert(lane_id, out);
    }
}

fn road_lane_connections(graph: &LaneGraph, lane: &Lane) -> Vec<LaneId> {
    let mut out = Vec::new();

    // Forward along lane direction. Entering intersection is allowed.
    let forward = tile_in_dir(lane.pos, lane.dir);
    if let Some(next_id) = graph.lane_id_at_pos(forward)
        && let Some(next_lane) = graph.get_lane(next_id)
        && (next_lane.dir == lane.dir || next_lane.dir == RoadDir::None)
    {
        push_unique(&mut out, next_id);
    }

    // Lateral lane changes to adjacent same-direction lanes.
    for side in [lane.dir.left(), lane.dir.right()] {
        if side == RoadDir::None {
            continue;
        }
        let side_pos = tile_in_dir(lane.pos, side);
        if let Some(side_id) = graph.lane_id_at_pos(side_pos)
            && let Some(side_lane) = graph.get_lane(side_id)
            && side_lane.dir == lane.dir
            && side_lane.dir != RoadDir::None
        {
            push_unique(&mut out, side_id);
        }
    }

    out
}

fn intersection_connections(graph: &LaneGraph, lane: &Lane) -> Vec<LaneId> {
    let mut out = Vec::new();

    // Inside intersection: move between intersection tiles freely.
    // Exit from intersection: only into lanes whose travel dir matches movement dir.
    for dir in [RoadDir::North, RoadDir::South, RoadDir::East, RoadDir::West] {
        let next_pos = tile_in_dir(lane.pos, dir);
        let Some(next_id) = graph.lane_id_at_pos(next_pos) else {
            continue;
        };
        let Some(next_lane) = graph.get_lane(next_id) else {
            continue;
        };

        if next_lane.dir == RoadDir::None || next_lane.dir == dir {
            push_unique(&mut out, next_id);
        }
    }

    out
}

fn tile_in_dir(pos: TilePos, dir: RoadDir) -> TilePos {
    let d = dir.delta();
    TilePos {
        x: pos.x + d.x,
        y: pos.y + d.y,
    }
}

fn push_unique(out: &mut Vec<LaneId>, lane_id: LaneId) {
    if !out.contains(&lane_id) {
        out.push(lane_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow};

    fn set_lane(grid: &mut MapGrid, pos: TilePos, lane: u8, dir: RoadDir) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
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

    #[test]
    fn lane_graph_uses_one_node_per_lane_tile() {
        let mut grid = MapGrid::new(2, 2);
        set_lane(&mut grid, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 1, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 0, y: 1 }, 1, RoadDir::West);
        set_lane(&mut grid, TilePos { x: 1, y: 1 }, 1, RoadDir::West);

        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));

        // Regression guard: must be 1:1 with lane tiles, not multiplied by RoadKind::lanes().
        assert_eq!(graph.lanes.len(), 4);
        assert!(graph.get_lane_id(TilePos { x: 0, y: 0 }, 0).is_some());
        assert!(graph.get_lane_id(TilePos { x: 0, y: 1 }, 1).is_some());
    }

    #[test]
    fn get_rightmost_lane_validates_direction() {
        let mut grid = MapGrid::new(1, 2);
        set_lane(&mut grid, TilePos { x: 0, y: 0 }, 0, RoadDir::East);
        set_lane(&mut grid, TilePos { x: 0, y: 1 }, 1, RoadDir::West);

        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));
        let west_pos = TilePos { x: 0, y: 1 };

        assert!(graph.get_rightmost_lane(west_pos, RoadDir::West).is_some());
        assert!(graph.get_rightmost_lane(west_pos, RoadDir::East).is_none());
    }

    #[test]
    fn intersection_exit_blocks_wrong_way_neighbor() {
        let mut grid = MapGrid::new(3, 3);
        // Approach lane into intersection.
        set_lane(&mut grid, TilePos { x: 1, y: 0 }, 0, RoadDir::North);
        // Intersection tile.
        set_lane(&mut grid, TilePos { x: 1, y: 1 }, 0, RoadDir::None);
        // Wrong-way lane north of intersection (points back into cluster).
        set_lane(&mut grid, TilePos { x: 1, y: 2 }, 1, RoadDir::South);
        // Valid eastbound exit.
        set_lane(&mut grid, TilePos { x: 2, y: 1 }, 0, RoadDir::East);

        let graph = build_lane_graph_inner(&grid, &GraphVersion(1));
        let approach = graph.get_lane_id(TilePos { x: 1, y: 0 }, 0).unwrap();
        let intersection = graph.get_lane_id(TilePos { x: 1, y: 1 }, 0).unwrap();
        let wrong_way = graph.get_lane_id(TilePos { x: 1, y: 2 }, 1).unwrap();
        let east_exit = graph.get_lane_id(TilePos { x: 2, y: 1 }, 0).unwrap();

        assert!(graph.get_connections(approach).contains(&intersection));
        assert!(!graph.get_connections(intersection).contains(&wrong_way));
        assert!(graph.get_connections(intersection).contains(&east_exit));
    }
}
