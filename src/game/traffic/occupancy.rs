use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};

use super::{Parked, TrafficConfig, Vehicle};

/// Traffic read model (derived data; not a source of truth).
///
/// **Semantics (punt C):**
/// - `per_tick_vehicles[idx]`: number of vehicles currently occupying the road tile at the end of
///   the latest fixed sim tick (not "cumulative visits").
/// - `heat(idx)`: exponentially-smoothed view of `per_tick_vehicles` for visualization.
///   This is what the Traffic overlay uses.
#[derive(Resource, Default)]
pub struct TrafficOccupancy {
    pub per_tick_vehicles: Vec<u16>,
    /// Indices touched in the *latest* occupancy build; used to clear `per_tick_vehicles`
    /// without an O(grid) fill every tick.
    pub(super) touched: Vec<usize>,
    /// Heat values stored in a scaled form to avoid an O(grid) decay every tick.
    ///
    /// The actual heat is `ema_scaled[i] * ema_global`.
    pub(super) ema_scaled: Vec<f32>,
    /// Global decay multiplier applied to all heat values.
    pub(super) ema_global: f32,
    /// Max over `ema_scaled` (monotonic between renormalizations), used to compute max heat in O(1).
    pub(super) max_scaled: f32,
}

impl TrafficOccupancy {
    pub fn heat_idx(&self, idx: usize) -> f32 {
        self.ema_scaled.get(idx).copied().unwrap_or(0.0) * self.ema_global
    }

    pub fn max_heat(&self) -> f32 {
        self.max_scaled * self.ema_global
    }

    pub(crate) fn ensure_len(&mut self, len: usize) {
        if self.per_tick_vehicles.len() != len {
            self.per_tick_vehicles.clear();
            self.per_tick_vehicles.resize(len, 0);
            self.touched.clear();
        }
        if self.ema_scaled.len() != len {
            self.ema_scaled.clear();
            self.ema_scaled.resize(len, 0.0);
            self.ema_global = 1.0;
            self.max_scaled = 0.0;
        }
        if self.ema_global <= 0.0 || !self.ema_global.is_finite() {
            self.ema_global = 1.0;
        }
        if !self.max_scaled.is_finite() {
            self.max_scaled = 0.0;
        }
    }

    #[cfg(test)]
    pub(crate) fn set_heat_for_test(&mut self, heat: Vec<f32>) {
        self.ensure_len(heat.len());
        self.ema_scaled = heat;
        self.ema_global = 1.0;
        self.max_scaled = self
            .ema_scaled
            .iter()
            .copied()
            .fold(0.0f32, |a, b| a.max(b));
    }
}

/// Aggregated traffic metrics for UI/economy.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct TrafficIndex {
    pub road_tiles: u32,
    pub vehicles_on_roads: u32,
    /// Average congestion in [0..1] across road tiles.
    pub avg_congestion: f32,
    /// Max congestion in [0..1] across road tiles.
    pub max_congestion: f32,
    /// Where `max_congestion` occurred (if any road tiles were touched).
    pub max_congestion_tile: Option<TilePos>,
    /// Vehicles on `max_congestion_tile` at end of tick.
    pub max_congestion_tile_vehicles: u16,
    /// Capacity on `max_congestion_tile` (0 if unknown/non-road).
    pub max_congestion_tile_capacity: u16,
}

/// Cached per-tile road capacities and total road tile count.
///
/// This avoids scanning the whole map each fixed tick when updating `TrafficIndex`.
#[derive(Resource, Default)]
pub(super) struct TrafficRoadCache {
    pub(super) grid_len: usize,
    pub(super) map_edit_version: u64,
    pub(super) capacity_per_tile: Vec<u16>, // 0 for non-road/non-driveable tiles
    pub(super) road_tiles: u32,
}

impl TrafficRoadCache {
    fn ensure_built(&mut self, grid: &MapGrid, edit_v: Option<u64>) {
        let len = grid.len();
        let need_rebuild = self.grid_len != len
            || self.capacity_per_tile.len() != len
            || edit_v.is_some_and(|v| v != self.map_edit_version);
        if !need_rebuild {
            return;
        }

        self.grid_len = len;
        self.map_edit_version = edit_v.unwrap_or(self.map_edit_version);
        self.capacity_per_tile.clear();
        self.capacity_per_tile.resize(len, 0);
        self.road_tiles = 0;

        for y in 0..grid.height {
            for x in 0..grid.width {
                let pos = TilePos { x, y };
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let Some(cell) = grid.get(pos) else {
                    continue;
                };
                if cell.water || !cell.road.is_some() {
                    continue;
                }
                self.road_tiles = self.road_tiles.saturating_add(1);
                self.capacity_per_tile[idx] = cell.road.kind.capacity_per_lane_tile();
            }
        }
    }
}

pub(super) fn reset_traffic_aggregates(
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
) {
    occ.per_tick_vehicles.clear();
    occ.touched.clear();
    occ.ema_scaled.clear();
    occ.ema_global = 1.0;
    occ.max_scaled = 0.0;
    *idx = TrafficIndex::default();
}

/// Update the occupancy map based on current vehicle positions.
///
/// This system runs at the **beginning** of `GameSet::Sim` to ensure pathfinding
/// uses fresh occupancy data from the previous tick, not stale data.
#[allow(clippy::too_many_arguments)] // Bevy systems often need many parameters
pub(super) fn update_traffic_occupancy(
    grid: Res<MapGrid>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
    mut roads: ResMut<TrafficRoadCache>,
    path_pool: Res<super::super::transport::PathPool>,
    q: Query<&Vehicle, Without<Parked>>,
    cfg: Res<TrafficConfig>,
    edit_v: Option<Res<crate::game::map::MapEditVersion>>,
) {
    let len = grid.len();
    occ.ensure_len(len);
    roads.ensure_built(&grid, edit_v.as_deref().map(|v| v.0));

    // Clear last tick's counts without an O(grid) fill.
    let mut touched = std::mem::take(&mut occ.touched);
    for i in touched.drain(..) {
        if i < occ.per_tick_vehicles.len() {
            occ.per_tick_vehicles[i] = 0;
        }
    }

    // Count occupancy at end-of-tick. Skip parked vehicles - they don't block traffic.
    for vehicle in q.iter() {
        if let Some(pos) = path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor)
            && let Some(idx) = grid.idx(pos)
        {
            // saturate at u16::MAX; capacity is small in MVP anyway.
            occ.per_tick_vehicles[idx] = occ.per_tick_vehicles[idx].saturating_add(1);
            if occ.per_tick_vehicles[idx] == 1 {
                touched.push(idx);
            }
        }
    }

    // Compute TrafficIndex exactly from touched road tiles (untouched road tiles have 0 congestion).
    let mut vehicles_on_roads = 0u32;
    let mut sum_cong = 0.0f32;
    let mut max_cong = 0.0f32;
    let mut max_tile: Option<usize> = None;
    let mut max_tile_vehicles: u16 = 0;
    let mut max_tile_cap: u16 = 0;

    for &ti in touched.iter() {
        let cap = roads.capacity_per_tile.get(ti).copied().unwrap_or(0) as f32;
        if cap <= 0.0 {
            continue;
        }
        let c_u16 = occ.per_tick_vehicles[ti];
        vehicles_on_roads = vehicles_on_roads.saturating_add(c_u16 as u32);
        let cong = ((c_u16 as f32) / cap).clamp(0.0, 1.0);
        sum_cong += cong;
        if cong > max_cong {
            max_cong = cong;
            max_tile = Some(ti);
            max_tile_vehicles = c_u16;
            max_tile_cap = roads.capacity_per_tile.get(ti).copied().unwrap_or(0);
        }
    }

    idx.road_tiles = roads.road_tiles;
    idx.vehicles_on_roads = vehicles_on_roads;
    if roads.road_tiles > 0 {
        idx.avg_congestion = sum_cong / (roads.road_tiles as f32);
        idx.max_congestion = max_cong;
    } else {
        idx.avg_congestion = 0.0;
        idx.max_congestion = 0.0;
    }

    idx.max_congestion_tile = max_tile.map(|ti| TilePos {
        x: (ti % (grid.width as usize)) as i32,
        y: (ti / (grid.width as usize)) as i32,
    });
    idx.max_congestion_tile_vehicles = max_tile_vehicles;
    idx.max_congestion_tile_capacity = max_tile_cap;

    // Update scaled EMA heatmap in O(touched) time.
    let decay = cfg.heat_ema_decay.clamp(0.0, 0.999);
    if decay <= 0.0 {
        // Degenerate mode: no smoothing, heat == current occupancy.
        occ.ema_scaled.fill(0.0);
        occ.max_scaled = 0.0;
        for &ti in touched.iter() {
            let v = occ.per_tick_vehicles[ti] as f32;
            occ.ema_scaled[ti] = v;
            if v > occ.max_scaled {
                occ.max_scaled = v;
            }
        }
        occ.ema_global = 1.0;
    } else {
        occ.ema_global *= decay;
        if occ.ema_global < 1e-20 {
            // Renormalize periodically to avoid float overflow in `ema_scaled`.
            let g = occ.ema_global;
            for v in occ.ema_scaled.iter_mut() {
                *v *= g;
            }
            occ.max_scaled *= g;
            occ.ema_global = 1.0;
        }

        let inv_g = 1.0 / occ.ema_global.max(1e-30);
        let k = (1.0 - decay) * inv_g;
        for &ti in touched.iter() {
            let c = occ.per_tick_vehicles[ti] as f32;
            let new = occ.ema_scaled[ti] + c * k;
            occ.ema_scaled[ti] = new;
            if new > occ.max_scaled {
                occ.max_scaled = new;
            }
        }
    }

    // Persist touched list for next tick clearing.
    occ.touched = touched;
}

/// Update TrafficIndex metrics at end of Sim tick for UI display.
///
/// This runs after all vehicle movement to provide accurate end-of-tick metrics.
#[allow(clippy::too_many_arguments)]
pub(super) fn update_traffic_index(
    grid: Res<MapGrid>,
    occ: Res<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
    roads: Res<TrafficRoadCache>,
    _path_pool: Res<super::super::transport::PathPool>,
    _q: Query<&Vehicle, Without<Parked>>,
    _cfg: Res<TrafficConfig>,
) {
    // Recompute metrics from current occupancy
    let mut vehicles_on_roads = 0u32;
    let mut sum_cong = 0.0f32;
    let mut max_cong = 0.0f32;
    let mut max_tile: Option<usize> = None;
    let mut max_tile_vehicles: u16 = 0;
    let mut max_tile_cap: u16 = 0;

    for ti in 0..grid.len() {
        let cap = roads.capacity_per_tile.get(ti).copied().unwrap_or(0) as f32;
        if cap <= 0.0 {
            continue;
        }
        let c_u16 = occ.per_tick_vehicles[ti];
        vehicles_on_roads = vehicles_on_roads.saturating_add(c_u16 as u32);
        let cong = ((c_u16 as f32) / cap).clamp(0.0, 1.0);
        sum_cong += cong;
        if cong > max_cong {
            max_cong = cong;
            max_tile = Some(ti);
            max_tile_vehicles = c_u16;
            max_tile_cap = roads.capacity_per_tile.get(ti).copied().unwrap_or(0);
        }
    }

    idx.road_tiles = roads.road_tiles;
    idx.vehicles_on_roads = vehicles_on_roads;
    if roads.road_tiles > 0 {
        idx.avg_congestion = sum_cong / (roads.road_tiles as f32);
        idx.max_congestion = max_cong;
    } else {
        idx.avg_congestion = 0.0;
        idx.max_congestion = 0.0;
    }

    idx.max_congestion_tile = max_tile.map(|ti| TilePos {
        x: (ti % (grid.width as usize)) as i32,
        y: (ti / (grid.width as usize)) as i32,
    });
    idx.max_congestion_tile_vehicles = max_tile_vehicles;
    idx.max_congestion_tile_capacity = max_tile_cap;
}
