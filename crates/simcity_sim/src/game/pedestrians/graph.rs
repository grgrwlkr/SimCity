use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{RoadDir, RoadKind};
use crate::game::transport::GraphVersion;

/// Derived walk graph:
/// - walkable sidewalk tiles (non-road tiles adjacent to non-highway roads),
/// - plus intersection tiles (`RoadDir::None`) to allow crossing at intersections.
#[derive(Resource, Debug, Default)]
pub struct PedestrianGraph {
    pub version: u64,
    pub width: usize,
    pub height: usize,
    pub(crate) walkable: Vec<bool>,
}

impl PedestrianGraph {
    pub fn is_built_for(&self, version: u64) -> bool {
        self.version == version && !self.walkable.is_empty()
    }

    pub fn is_walkable(&self, pos: TilePos) -> bool {
        self.idx(pos)
            .is_some_and(|i| self.walkable.get(i) == Some(&true))
    }

    pub(crate) fn idx(&self, pos: TilePos) -> Option<usize> {
        if pos.x < 0 || pos.y < 0 {
            return None;
        }
        let x = pos.x as usize;
        let y = pos.y as usize;
        if x >= self.width || y >= self.height {
            return None;
        }
        Some(y * self.width + x)
    }

    pub(crate) fn pos(&self, idx: usize) -> TilePos {
        let x = (idx % self.width) as i32;
        let y = (idx / self.width) as i32;
        TilePos { x, y }
    }

    pub(crate) fn neighbors_idx(&self, idx: usize) -> [usize; 4] {
        let x = idx % self.width;
        let y = idx / self.width;

        let mut out = [idx; 4];
        let mut n = 0usize;

        let try_push = |out: &mut [usize; 4], n: &mut usize, i: usize, ok: bool| {
            if ok && *n < 4 {
                out[*n] = i;
                *n += 1;
            }
        };

        if x > 0 {
            let i = idx - 1;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }
        if x + 1 < self.width {
            let i = idx + 1;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }
        if y > 0 {
            let i = idx - self.width;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }
        if y + 1 < self.height {
            let i = idx + self.width;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }

        out
    }
}

pub(crate) fn rebuild_pedestrian_graph(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut graph: ResMut<PedestrianGraph>,
) {
    if graph.is_built_for(gv.0) && graph.width == grid.width.max(0) as usize {
        return;
    }

    graph.version = gv.0;
    graph.width = grid.width.max(0) as usize;
    graph.height = grid.height.max(0) as usize;

    let len = grid.len();
    graph.walkable.clear();
    graph.walkable.resize(len, false);

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                continue;
            }

            let walk = if cell.road.is_some() {
                cell.road.dir == RoadDir::None
            } else {
                // "Corner" nodes: allow standing/walking right next to intersection clusters
                // even when the adjacent road is a SixLane highway. This enables crossing highways
                // at intersections while still preventing walking along highway segments.
                is_corner_near_intersection(&grid, pos) || is_sidewalk_tile(&grid, pos)
            };
            if walk && let Some(i) = grid.idx(pos) {
                graph.walkable[i] = true;
            }
        }
    }
}

fn is_sidewalk_tile(grid: &MapGrid, pos: TilePos) -> bool {
    // Sidewalk tiles exist next to roads that "provide sidewalk" (i.e. not SixLane lane tiles).
    for npos in [
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ] {
        if let Some(ncell) = grid.get(npos)
            && !ncell.water
            && road_provides_sidewalk(ncell.road)
        {
            return true;
        }
    }
    false
}

fn is_corner_near_intersection(grid: &MapGrid, pos: TilePos) -> bool {
    // If a non-road tile is directly adjacent to an intersection tile (dir=None),
    // treat it as walkable "corner" space.
    for npos in [
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ] {
        if let Some(ncell) = grid.get(npos)
            && !ncell.water
            && ncell.road.is_some()
            && ncell.road.dir == RoadDir::None
        {
            return true;
        }
    }
    false
}

fn road_provides_sidewalk(road: crate::game::roads::RoadCell) -> bool {
    if !road.is_some() {
        return false;
    }
    if road.dir == RoadDir::None {
        return true;
    }
    // Highways: no sidewalks along segments (but intersections are still walkable via dir=None tiles).
    road.kind != RoadKind::SixLane
}
