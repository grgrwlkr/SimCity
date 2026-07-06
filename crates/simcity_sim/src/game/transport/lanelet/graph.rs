use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::intersections::IntersectionId;
use crate::game::map::TilePos;
use crate::game::traffic::ManeuverKind;
use crate::game::transport::LaneId;

/// Unique identifier for a lanelet (a directed path through an intersection cluster).
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct LaneletId(pub u32);

impl LaneletId {
    pub const INVALID: LaneletId = LaneletId(u32::MAX);
}

/// Per-cluster pedestrian crosswalk identity (local index within its intersection cluster, in the
/// order `crosswalk_cells` emits crosswalks). Distinct from `LaneletId` (a global lanelet index):
/// crosswalks are matrix rows appended after the vehicle lanelets of an intersection.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct CrosswalkId(pub u32);

/// A directed connector path from one approach lane through an intersection cluster to an exit lane.
#[derive(Debug, Clone)]
pub struct Lanelet {
    pub id: LaneletId,
    pub intersection: IntersectionId,
    pub entry_lane: LaneId,
    pub exit_lane: LaneId,
    pub maneuver: ManeuverKind,
    /// 4-adjacent cluster tiles from entry to exit (built in a later task).
    pub internal_path: Vec<TilePos>,
}

/// Graph of all lanelets indexed by intersection.
#[derive(Resource, Default)]
pub struct LaneletGraph {
    /// Index == LaneletId.0 as usize.
    pub lanelets: Vec<Lanelet>,
    pub by_intersection: HashMap<IntersectionId, Vec<LaneletId>>,
    pub by_entry_lane: HashMap<LaneId, Vec<LaneletId>>,
    pub version: u64,
    /// `GraphVersion` this graph was built for; `None` = never built.
    ///
    /// Tracked explicitly (not inferred from `lanelets.is_empty()`): an intersection-free map
    /// legitimately builds zero lanelets and must still count as built, otherwise the graph is
    /// rebuilt every tick.
    pub built_for: Option<u64>,
    /// Grid dimensions at build time (see `LaneGraph::built_dims`).
    pub built_dims: Option<(i32, i32)>,
}

impl LaneletGraph {
    /// Returns true if this graph was built for the given graph version.
    pub fn is_built_for(&self, version: u64, grid: &crate::game::map::MapGrid) -> bool {
        self.built_for == Some(version) && self.built_dims == Some((grid.width, grid.height))
    }

    pub fn get(&self, id: LaneletId) -> Option<&Lanelet> {
        self.lanelets.get(id.0 as usize)
    }

    /// Returns the lanelet ids for the given intersection, or an empty slice if absent.
    pub fn of_intersection(&self, id: IntersectionId) -> &[LaneletId] {
        self.by_intersection
            .get(&id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Returns the lanelet ids whose entry lane is `l`, or an empty slice if absent.
    pub fn lanelets_from(&self, l: LaneId) -> &[LaneletId] {
        self.by_entry_lane
            .get(&l)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_lanelet_graph_reports_unbuilt_and_no_lanelets() {
        let g = LaneletGraph::default();
        let grid = crate::game::map::MapGrid::new(4, 4);
        assert!(!g.is_built_for(1, &grid));
        assert!(g.get(LaneletId(0)).is_none());
        assert!(g.of_intersection(IntersectionId(0)).is_empty());
    }
}
