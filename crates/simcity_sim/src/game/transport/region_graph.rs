use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};

use super::{GraphVersion, PathfindingConfig};

/// Coarse region connectivity graph used to prune low-level A* searches.
#[derive(Resource, Debug, Default, Clone)]
pub struct RegionGraph {
    pub version: u64,
    pub region_size: usize,
    pub regions_w: usize,
    pub regions_h: usize,
    /// Per-region 4-bit neighbor mask (W,E,S,N).
    pub edges: Vec<u8>,
}

impl RegionGraph {
    pub(super) fn is_built_for(
        &self,
        version: u64,
        region_size: usize,
        w: usize,
        h: usize,
    ) -> bool {
        if self.version != version || self.region_size != region_size || self.edges.is_empty() {
            return false;
        }
        let expect_w = w.div_ceil(region_size);
        let expect_h = h.div_ceil(region_size);
        self.regions_w == expect_w && self.regions_h == expect_h
    }

    pub(super) fn region_id(&self, pos: TilePos) -> Option<usize> {
        if pos.x < 0 || pos.y < 0 {
            return None;
        }
        let x = pos.x as usize;
        let y = pos.y as usize;
        let rx = x / self.region_size;
        let ry = y / self.region_size;
        if rx >= self.regions_w || ry >= self.regions_h {
            return None;
        }
        Some(ry * self.regions_w + rx)
    }
}

pub(super) fn rebuild_region_graph(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    cfg: Res<PathfindingConfig>,
    mut regions: ResMut<RegionGraph>,
) {
    let w = grid.width as usize;
    let h = grid.height as usize;
    let region_size = cfg.region_size.max(1);

    if regions.is_built_for(gv.0, region_size, w, h) {
        return;
    }

    let regions_w = w.div_ceil(region_size);
    let regions_h = h.div_ceil(region_size);
    let region_count = regions_w * regions_h;

    regions.version = gv.0;
    regions.region_size = region_size;
    regions.regions_w = regions_w;
    regions.regions_h = regions_h;
    regions.edges.clear();
    regions.edges.resize(region_count, 0);

    let region_id_xy = |x: i32, y: i32| -> Option<usize> {
        if x < 0 || y < 0 || x >= grid.width || y >= grid.height {
            return None;
        }
        let rx = (x as usize) / region_size;
        let ry = (y as usize) / region_size;
        Some(ry * regions_w + rx)
    };

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water || !cell.road.is_some() {
                continue;
            }

            let Some(rid) = region_id_xy(x, y) else {
                continue;
            };

            // Connect regions if any road tiles touch across a region boundary.
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                let Some(npos_cell) = grid.get(TilePos { x: nx, y: ny }) else {
                    continue;
                };
                if npos_cell.water || !npos_cell.road.is_some() {
                    continue;
                }
                let Some(nrid) = region_id_xy(nx, ny) else {
                    continue;
                };
                if nrid == rid {
                    continue;
                }

                let rx = rid % regions_w;
                let ry = rid / regions_w;
                let nrx = nrid % regions_w;
                let nry = nrid / regions_w;

                if nrx + 1 == rx {
                    regions.edges[rid] |= 1 << 0; // W
                    regions.edges[nrid] |= 1 << 1; // E
                } else if nrx == rx + 1 {
                    regions.edges[rid] |= 1 << 1; // E
                    regions.edges[nrid] |= 1 << 0; // W
                } else if nry + 1 == ry {
                    regions.edges[rid] |= 1 << 2; // S
                    regions.edges[nrid] |= 1 << 3; // N
                } else if nry == ry + 1 {
                    regions.edges[rid] |= 1 << 3; // N
                    regions.edges[nrid] |= 1 << 2; // S
                }
            }
        }
    }
}
