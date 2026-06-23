use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::intersections::IntersectionId;
use crate::game::map::MapGrid;
use crate::game::transport::lanelet::{LaneletGraph, LaneletId};

/// Intersections swept in strict ascending `IntersectionId.0` order — the global ORD for the P3c
/// progress-DAG (NOT width, which has ties; NOT HashMap iteration order). Deterministic.
#[allow(dead_code)]
pub(crate) fn ordered_intersection_ids(llg: &LaneletGraph) -> Vec<IntersectionId> {
    let mut ids: Vec<IntersectionId> = llg.by_intersection.keys().copied().collect();
    ids.sort_unstable_by_key(|id| id.0);
    ids
}

/// Per-version cache the arbiter rebuilds only when the lanelet matrices change. For each
/// intersection it stores `LaneletId -> local matrix-row index` (the position in `by_intersection`,
/// which is exactly the `ConflictMatrix` row order) and a coarse per-intersection main-road class
/// (max `RoadKind::lanes()` over the intersection's lanelet entry cluster tiles; refined to a true
/// per-approach width priority in P3b).
#[derive(Resource, Default)]
#[allow(dead_code)]
pub(crate) struct ArbiterIndexCache {
    pub version: u64,
    pub local_idx: HashMap<IntersectionId, HashMap<LaneletId, usize>>,
    pub priority_road_class: HashMap<IntersectionId, u8>,
}

#[allow(dead_code)]
impl ArbiterIndexCache {
    /// Rebuild iff `version` differs from the last build (or the cache is empty). `local_idx`
    /// mirrors `by_intersection` ordering == matrix row order, so the arbiter can map a vehicle's
    /// resolved `LaneletId` to its `ConflictMatrix::row` index.
    pub(crate) fn ensure_built_for(&mut self, version: u64, llg: &LaneletGraph, grid: &MapGrid) {
        if self.version == version && !self.local_idx.is_empty() {
            return;
        }
        self.local_idx.clear();
        self.priority_road_class.clear();
        for (&id, lanelet_ids) in &llg.by_intersection {
            let mut idx_map: HashMap<LaneletId, usize> = HashMap::new();
            let mut max_lanes: u8 = 0;
            for (local, &lid) in lanelet_ids.iter().enumerate() {
                idx_map.insert(lid, local);
                if let Some(l) = llg.get(lid)
                    && let Some(first) = l.internal_path.first()
                    && let Some(cell) = grid.get(*first)
                {
                    max_lanes = max_lanes.max(cell.road.kind.lanes());
                }
            }
            self.local_idx.insert(id, idx_map);
            self.priority_road_class.insert(id, max_lanes);
        }
        self.version = version;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::TilePos;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::traffic::ManeuverKind;
    use crate::game::transport::LaneId;
    use crate::game::transport::Lanelet;

    fn lanelet(id: u32, isect: u32, path: Vec<TilePos>) -> Lanelet {
        Lanelet {
            id: LaneletId(id),
            intersection: IntersectionId(isect),
            entry_lane: LaneId(id),
            exit_lane: LaneId(id + 100),
            maneuver: ManeuverKind::Straight,
            internal_path: path,
        }
    }

    fn set_road(grid: &mut MapGrid, pos: TilePos, kind: RoadKind) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
        cell.water = false;
        cell.road = RoadCell {
            kind,
            dir: RoadDir::East,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    #[test]
    fn ordered_ids_strictly_ascending_by_id() {
        let mut llg = LaneletGraph::default();
        llg.by_intersection.insert(IntersectionId(2), vec![]);
        llg.by_intersection.insert(IntersectionId(0), vec![]);
        llg.by_intersection.insert(IntersectionId(1), vec![]);
        assert_eq!(
            ordered_intersection_ids(&llg),
            vec![IntersectionId(0), IntersectionId(1), IntersectionId(2)]
        );
    }

    #[test]
    fn cache_local_idx_matches_row_order_and_rebuilds_on_version() {
        let mut grid = MapGrid::new(4, 4);
        set_road(&mut grid, TilePos { x: 1, y: 1 }, RoadKind::SixLane);
        set_road(&mut grid, TilePos { x: 2, y: 2 }, RoadKind::TwoLane);

        let mut llg = LaneletGraph::default();
        llg.lanelets
            .push(lanelet(0, 0, vec![TilePos { x: 1, y: 1 }]));
        llg.lanelets
            .push(lanelet(1, 0, vec![TilePos { x: 2, y: 2 }]));
        llg.by_intersection
            .insert(IntersectionId(0), vec![LaneletId(0), LaneletId(1)]);
        llg.version = 1;

        let mut cache = ArbiterIndexCache::default();
        cache.ensure_built_for(1, &llg, &grid);
        assert_eq!(cache.version, 1);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(0)], 0);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(1)], 1);
        // Coarse main-road class = max approach width (SixLane=6 wins over TwoLane=2).
        assert_eq!(cache.priority_road_class[&IntersectionId(0)], 6);

        // Same version + non-empty -> no rebuild even if the graph changed underneath.
        llg.by_intersection
            .insert(IntersectionId(0), vec![LaneletId(1), LaneletId(0)]);
        cache.ensure_built_for(1, &llg, &grid);
        assert_eq!(
            cache.local_idx[&IntersectionId(0)][&LaneletId(0)],
            0,
            "stale v1 cache must not be rebuilt at the same version"
        );

        // Bump version -> rebuild with the new ordering.
        llg.version = 2;
        cache.ensure_built_for(2, &llg, &grid);
        assert_eq!(cache.version, 2);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(1)], 0);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(0)], 1);
    }
}
