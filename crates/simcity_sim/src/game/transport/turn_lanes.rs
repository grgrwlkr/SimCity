use std::collections::{HashMap, HashSet};

use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, build_intersection_clusters};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadDir, RoadFlow};

use super::GraphVersion;

/// Tracks whether derived turn-lane markings were computed for a given `GraphVersion`.
#[derive(Resource, Default)]
pub struct TurnLaneAutogenState {
    pub(super) version: u64,
}

fn offset(pos: TilePos, d: IVec2) -> TilePos {
    TilePos {
        x: pos.x + d.x,
        y: pos.y + d.y,
    }
}

pub fn autogen_turn_lanes(
    gv: Res<GraphVersion>,
    mut grid: ResMut<MapGrid>,
    mut state: ResMut<TurnLaneAutogenState>,
) {
    if state.version == gv.0 {
        return;
    }
    state.version = gv.0;

    autogen_turn_lanes_inner(&mut grid);
}

pub(super) fn autogen_turn_lanes_inner(grid: &mut MapGrid) {
    // Reset any old markings (roads may have changed).
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(mut cell) = grid.get(pos) else {
                continue;
            };
            if cell.water || !cell.road.is_some() || cell.road.dir == RoadDir::None {
                continue;
            }
            if cell.road.lane_type != LaneType::Regular {
                cell.road.lane_type = LaneType::Regular;
                grid.set(pos, cell);
            }
        }
    }

    // Derive intersection clusters from the grid (same logic as `IntersectionIndex`).
    let (clusters, tile_to_intersection) = build_intersection_clusters(grid);

    // For each cluster: which travel directions exist for exit lanes?
    let mut exit_dirs_by_id = HashMap::<IntersectionId, HashSet<RoadDir>>::new();
    // For each (cluster, entry_dir): set of approach lane tiles (deduped).
    let mut approaches = HashMap::<(IntersectionId, RoadDir), HashSet<TilePos>>::new();

    for c in &clusters {
        for &t in &c.tiles {
            for neigh in [RoadDir::West, RoadDir::East, RoadDir::South, RoadDir::North] {
                let npos = offset(t, neigh.delta());
                let Some(ncell) = grid.get(npos) else {
                    continue;
                };
                if ncell.water || !ncell.road.is_some() || ncell.road.dir == RoadDir::None {
                    continue;
                }
                // Ignore "wrong-way" lane tiles on one-way roads (they're not usable by routing).
                if let RoadFlow::OneWay(one_way_dir) = ncell.road.flow
                    && ncell.road.dir != one_way_dir
                {
                    continue;
                }

                let dir = ncell.road.dir;
                let fwd = offset(npos, dir.delta());
                let back = offset(npos, dir.opposite().delta());

                if tile_to_intersection.get(&fwd) == Some(&c.id) {
                    // Approaching the cluster (lane points into it).
                    approaches.entry((c.id, dir)).or_default().insert(npos);
                } else if tile_to_intersection.get(&back) == Some(&c.id) {
                    // Exiting the cluster (lane points away from it).
                    exit_dirs_by_id.entry(c.id).or_default().insert(dir);
                }
            }
        }
    }

    // Apply conservative heuristics:
    // - Only mark turn lanes when there are at least 2 approach lanes for the direction.
    // - Turn-ONLY dedication is reserved for MUST-TURN approaches (no straight exit). Wherever a
    //   straight exit exists, every approach lane stays Regular: through traffic may use ALL
    //   lanes (two-row flow through the box), and turns remain legal POSITIONALLY from the edge
    //   lanes (ПДД 8.5 positional rules in `lane_allows_maneuver`: left/UTurn from the
    //   centerline-adjacent lane, right from the curb-adjacent). Dedicating a turn lane whenever
    //   the intersection merely HAS that exit funneled all through traffic into the single
    //   remaining lane — single-file queues beside an empty turn lane.
    // - Left-turn demand still gets its priority via the arbiter's `LeftTurnDemand` actuating the
    //   protected-left phase; demand must not re-mark lanes (transient per-tick state vs
    //   graph-change-driven markings would flap and storm reroutes).
    for ((id, entry_dir), lane_tiles) in approaches {
        let Some(exit_dirs) = exit_dirs_by_id.get(&id) else {
            continue;
        };

        let has_straight = exit_dirs.contains(&entry_dir);
        let has_left = exit_dirs.contains(&entry_dir.left());
        let has_right = exit_dirs.contains(&entry_dir.right());

        let lanes_in_dir = lane_tiles.len();
        if lanes_in_dir <= 1 {
            continue;
        }

        for pos in lane_tiles {
            let Some(mut cell) = grid.get(pos) else {
                continue;
            };
            if cell.water || !cell.road.is_some() || cell.road.dir != entry_dir {
                continue;
            }

            let is_leftmost = cell.road.is_leftmost_for_dir();
            let is_rightmost = cell.road.is_rightmost_for_dir();

            let next_type = if has_straight {
                // Straight exit exists: keep every approach lane general (see doc above).
                LaneType::Regular
            } else if is_leftmost && has_left {
                LaneType::LeftTurnOnly
            } else if is_rightmost && has_right {
                LaneType::RightTurnOnly
            } else {
                LaneType::Regular
            };

            if cell.road.lane_type != next_type {
                cell.road.lane_type = next_type;
                grid.set(pos, cell);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::MapCell;
    use crate::game::roads::{RoadCell, RoadFlow, RoadKind};

    /// Helper: place a road cell at `pos`.
    fn set_road(grid: &mut MapGrid, pos: TilePos, kind: RoadKind, dir: RoadDir, lane: u8) {
        let cell = MapCell {
            road: RoadCell {
                kind,
                dir,
                lane,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            },
            ..Default::default()
        };
        grid.set(pos, cell);
    }

    /// Two-lane northbound approach: tiles at (4,3) and (5,3) both pointing North into a 2-tile
    /// cluster at (4,4)+(5,4).  Exit North (straight) at (4,5)/(5,5), exit West (left) at (3,4).
    ///
    /// Both approach tiles use `FourLane` (4 physical lanes total, half=2):
    ///   - lane=0  → rightmost for the northbound carriageway (`is_rightmost_for_dir()` = true)
    ///   - lane=1  → leftmost  for the northbound carriageway (`is_leftmost_for_dir()`  = true)
    ///
    /// With a straight exit present, NO lane may be dedicated: both stay `Regular` so through
    /// traffic can use both lanes (two-row flow); the left turn remains legal positionally from
    /// the centerline-adjacent (leftmost) lane per ПДД 8.5.
    #[test]
    fn autogen_keeps_lanes_regular_when_straight_exit_exists() {
        let mut grid = MapGrid::new(10, 10);

        // Cluster: two None-dir tiles
        set_road(
            &mut grid,
            TilePos { x: 4, y: 4 },
            RoadKind::FourLane,
            RoadDir::None,
            0,
        );
        set_road(
            &mut grid,
            TilePos { x: 5, y: 4 },
            RoadKind::FourLane,
            RoadDir::None,
            0,
        );

        // Two northbound approach tiles. North.delta() = (0,1), so fwd = (x, y+1).
        // (4,3) → fwd=(4,4) in cluster ✓; (5,3) → fwd=(5,4) in cluster ✓.
        // lane=1 is leftmost (closest to centreline) for FourLane northbound carriageway.
        let leftmost = TilePos { x: 4, y: 3 };
        let rightmost = TilePos { x: 5, y: 3 };
        set_road(&mut grid, leftmost, RoadKind::FourLane, RoadDir::North, 1);
        set_road(&mut grid, rightmost, RoadKind::FourLane, RoadDir::North, 0);

        // Exit North (straight): back=(x,4) in cluster for tiles at y=5.
        set_road(
            &mut grid,
            TilePos { x: 4, y: 5 },
            RoadKind::FourLane,
            RoadDir::North,
            1,
        );
        set_road(
            &mut grid,
            TilePos { x: 5, y: 5 },
            RoadKind::FourLane,
            RoadDir::North,
            0,
        );

        // Exit West (left turn for northbound): dir=West, opposite=East, delta=(1,0).
        // back = (3,4)+(1,0) = (4,4) in cluster ✓.
        set_road(
            &mut grid,
            TilePos { x: 3, y: 4 },
            RoadKind::FourLane,
            RoadDir::West,
            0,
        );

        autogen_turn_lanes_inner(&mut grid);

        let leftmost_cell = grid.get(leftmost).unwrap();
        assert_eq!(
            leftmost_cell.road.lane_type,
            LaneType::Regular,
            "leftmost approach lane must stay Regular when a straight exit exists (turn dedication \
             is reserved for must-turn approaches); through traffic needs both lanes"
        );

        let rightmost_cell = grid.get(rightmost).unwrap();
        assert_eq!(
            rightmost_cell.road.lane_type,
            LaneType::Regular,
            "rightmost approach lane must stay Regular (no StraightOnly dedication when a straight \
             exit exists)"
        );
    }

    /// MUST-TURN approach (T without a straight exit): dedication still applies — leftmost
    /// becomes `LeftTurnOnly` so left-turning traffic keeps a dedicated lane.
    #[test]
    fn autogen_marks_left_lane_on_must_turn_approach() {
        let mut grid = MapGrid::new(10, 10);

        // Cluster: two None-dir tiles
        set_road(
            &mut grid,
            TilePos { x: 4, y: 4 },
            RoadKind::FourLane,
            RoadDir::None,
            0,
        );
        set_road(
            &mut grid,
            TilePos { x: 5, y: 4 },
            RoadKind::FourLane,
            RoadDir::None,
            0,
        );

        // Two northbound approach tiles (no NORTH exit this time — the T forces a turn).
        let leftmost = TilePos { x: 4, y: 3 };
        let rightmost = TilePos { x: 5, y: 3 };
        set_road(&mut grid, leftmost, RoadKind::FourLane, RoadDir::North, 1);
        set_road(&mut grid, rightmost, RoadKind::FourLane, RoadDir::North, 0);

        // Exit West (left turn for northbound) only.
        set_road(
            &mut grid,
            TilePos { x: 3, y: 4 },
            RoadKind::FourLane,
            RoadDir::West,
            0,
        );

        autogen_turn_lanes_inner(&mut grid);

        let leftmost_cell = grid.get(leftmost).unwrap();
        assert_eq!(
            leftmost_cell.road.lane_type,
            LaneType::LeftTurnOnly,
            "on a must-turn approach the leftmost lane must become LeftTurnOnly"
        );
        let rightmost_cell = grid.get(rightmost).unwrap();
        assert_eq!(
            rightmost_cell.road.lane_type,
            LaneType::Regular,
            "no right exit to dedicate the rightmost lane for"
        );
    }

    /// Single-lane approach must stay Regular — the early `continue` for lanes_in_dir <= 1.
    #[test]
    fn autogen_single_lane_approach_stays_regular() {
        let mut grid = MapGrid::new(10, 10);

        // Single-tile cluster
        set_road(
            &mut grid,
            TilePos { x: 4, y: 4 },
            RoadKind::TwoLane,
            RoadDir::None,
            0,
        );

        // One northbound approach tile (TwoLane, half=1, lane=0 is both leftmost and rightmost).
        let approach = TilePos { x: 4, y: 3 };
        set_road(&mut grid, approach, RoadKind::TwoLane, RoadDir::North, 0);

        // Exits: North (straight) + West (left) — same rich exit set, but only 1 approach lane.
        set_road(
            &mut grid,
            TilePos { x: 4, y: 5 },
            RoadKind::TwoLane,
            RoadDir::North,
            0,
        );
        set_road(
            &mut grid,
            TilePos { x: 3, y: 4 },
            RoadKind::TwoLane,
            RoadDir::West,
            0,
        );

        autogen_turn_lanes_inner(&mut grid);

        let cell = grid.get(approach).unwrap();
        assert_eq!(
            cell.road.lane_type,
            LaneType::Regular,
            "single-lane approach must stay Regular"
        );
    }
}
