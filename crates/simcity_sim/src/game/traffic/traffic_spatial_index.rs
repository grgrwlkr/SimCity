use std::collections::HashMap;

use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::transport::{PathHandle, PathPool};

use super::{Parked, Vehicle};

#[derive(Copy, Clone, Debug)]
pub struct VehicleTileEntry {
    pub entity: Entity,
    pub progress: f32,
    pub speed: f32,
}

/// Per-tile vehicle ordering, rebuilt on demand.
///
/// Goal: enable leader detection / occupancy checks without rebuilding multiple `HashMap<TilePos, Vec<...>>`
/// in several systems every tick.
#[derive(Resource, Debug, Default)]
pub struct TrafficSpatialIndex {
    grid_len: usize,
    /// For each tile idx: number of vehicles in that tile (0 if none).
    counts: Vec<u32>,
    /// For each tile idx: start offset into `entries` (undefined if count==0).
    offsets: Vec<u32>,
    /// Tile indices that were non-empty during the last rebuild.
    touched: Vec<usize>,
    /// Cached counts for touched tiles (parallel to `touched` after sort).
    touched_lens: Vec<u32>,

    entries: Vec<VehicleTileEntry>,

    /// For each vehicle that has a leader on the same tile: (gap_world, leader_speed).
    leader_same_tile: HashMap<Entity, (f32, f32)>,
    /// Absolute progress of the same-tile leader (in tile fractions) for hard clamp.
    leader_same_tile_progress: HashMap<Entity, f32>,
}

impl TrafficSpatialIndex {
    #[inline]
    pub fn is_built_for_len(&self, len: usize) -> bool {
        self.grid_len == len && self.counts.len() == len && self.offsets.len() == len
    }

    pub fn rebuild(
        &mut self,
        cfg: &MapConfig,
        grid: &MapGrid,
        path_pool: &PathPool,
        q_vehicles: &Query<(Entity, &Vehicle), Without<Parked>>,
    ) {
        let len = grid.len();
        if self.grid_len != len {
            self.grid_len = len;
            self.counts.clear();
            self.offsets.clear();
            self.counts.resize(len, 0);
            self.offsets.resize(len, 0);
            self.touched.clear();
            self.touched_lens.clear();
            self.entries.clear();
            self.leader_same_tile.clear();
            self.leader_same_tile_progress.clear();
        } else {
            // Reset last-tick touched tiles in O(touched) instead of O(grid.len()).
            for &idx in self.touched.iter() {
                self.counts[idx] = 0;
                self.offsets[idx] = 0;
            }
            self.touched.clear();
            self.touched_lens.clear();
            self.entries.clear();
            self.leader_same_tile.clear();
            self.leader_same_tile_progress.clear();
        }

        // Pass 1: count vehicles per tile, track touched tiles. Vehicles with no active route
        // (idle service fleet at a station tile) are not traffic: indexing them makes every one
        // a zero-speed same-tile IDM leader that stalls real cars behind the station.
        for (_e, v) in q_vehicles.iter() {
            if path_pool.len(v.path_handle) <= 1 {
                continue;
            }
            let Some(tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
                continue;
            };
            let Some(idx) = grid.idx(tile) else {
                continue;
            };
            let c = &mut self.counts[idx];
            if *c == 0 {
                self.touched.push(idx);
            }
            *c = c.saturating_add(1);
        }

        if self.touched.is_empty() {
            return;
        }

        // Deterministic order.
        self.touched.sort_unstable();

        // Snapshot lens (we'll reuse `counts` as per-tile cursor in pass 2).
        self.touched_lens.reserve(self.touched.len());
        for &idx in self.touched.iter() {
            self.touched_lens.push(self.counts[idx]);
        }

        // Prefix sums -> offsets, and reset counts to 0 to become write cursors.
        let mut total: u32 = 0;
        for (&idx, &count) in self.touched.iter().zip(self.touched_lens.iter()) {
            self.offsets[idx] = total;
            self.counts[idx] = 0;
            total = total.saturating_add(count);
        }

        self.entries.resize(
            total as usize,
            VehicleTileEntry {
                entity: Entity::from_raw_u32(1).expect("valid placeholder entity"),
                progress: 0.0,
                speed: 0.0,
            },
        );

        // Pass 2: fill per-tile buckets into the flat array.
        for (e, v) in q_vehicles.iter() {
            if path_pool.len(v.path_handle) <= 1 {
                continue;
            }
            let Some(tile) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
                continue;
            };
            let Some(idx) = grid.idx(tile) else {
                continue;
            };
            let start = self.offsets[idx] as usize;
            let w = self.counts[idx] as usize;
            self.counts[idx] = self.counts[idx].saturating_add(1);

            let pos = start + w;
            if let Some(slot) = self.entries.get_mut(pos) {
                *slot = VehicleTileEntry {
                    entity: e,
                    progress: v.progress.clamp(0.0, 1.0),
                    speed: v.speed.max(0.0),
                };
            }
        }

        // Per-tile sort by progress (stable ordering not required).
        for &idx in self.touched.iter() {
            let start = self.offsets[idx] as usize;
            let count = self.counts[idx] as usize;
            let end = start + count;
            if end <= self.entries.len() {
                self.entries[start..end].sort_unstable_by(|a, b| {
                    a.progress
                        .partial_cmp(&b.progress)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        }

        // Leader map (same tile): adjacent entries after sorting.
        self.leader_same_tile
            .reserve(self.entries.len().saturating_sub(1));
        let tile_size = cfg.tile_size.max(0.1);
        for &idx in self.touched.iter() {
            let start = self.offsets[idx] as usize;
            let count = self.counts[idx] as usize;
            let end = start + count;
            let Some(slice) = self.entries.get(start..end) else {
                continue;
            };
            let vehicle_len_world = crate::game::traffic::VEHICLE_VISUAL_LENGTH_TILES * tile_size;
            for w in slice.windows(2) {
                let ego = w[0];
                let lead = w[1];
                let center_gap = ((lead.progress - ego.progress).max(0.0)) * tile_size;
                let gap_world = (center_gap - vehicle_len_world).max(0.0);
                self.leader_same_tile
                    .insert(ego.entity, (gap_world, lead.speed));
                self.leader_same_tile_progress
                    .insert(ego.entity, lead.progress);
            }
        }
    }

    #[inline]
    pub fn tile_has_any(&self, tile_idx: usize) -> bool {
        self.counts.get(tile_idx).copied().unwrap_or(0) > 0
    }

    #[inline]
    pub fn tile_count(&self, tile_idx: usize) -> u32 {
        self.counts.get(tile_idx).copied().unwrap_or(0)
    }

    #[inline]
    pub fn tile_min_progress_speed(&self, tile_idx: usize) -> Option<(f32, f32)> {
        let count = *self.counts.get(tile_idx)? as usize;
        if count == 0 {
            return None;
        }
        let start = *self.offsets.get(tile_idx)? as usize;
        self.entries.get(start).map(|e| (e.progress, e.speed))
    }

    #[inline]
    pub fn tile_first(&self, tile_idx: usize) -> Option<VehicleTileEntry> {
        let count = *self.counts.get(tile_idx)? as usize;
        if count == 0 {
            return None;
        }
        let start = *self.offsets.get(tile_idx)? as usize;
        self.entries.get(start).copied()
    }

    pub fn tile_entries(&self, tile_idx: usize) -> Option<&[VehicleTileEntry]> {
        let count = *self.counts.get(tile_idx)? as usize;
        if count == 0 {
            return Some(&[]);
        }
        let start = *self.offsets.get(tile_idx)? as usize;
        let end = start + count;
        self.entries.get(start..end)
    }

    #[inline]
    pub fn leader_same_tile(&self, ego: Entity) -> Option<(f32, f32)> {
        self.leader_same_tile.get(&ego).copied()
    }

    /// Absolute progress of the immediate same-tile leader of `ego` (if any), in tile fractions.
    #[inline]
    pub fn leader_same_tile_progress(&self, ego: Entity) -> Option<f32> {
        self.leader_same_tile_progress.get(&ego).copied()
    }

    /// True if there exists a vehicle on `tile_idx` with progress within `radius` of `center`.
    pub fn tile_has_progress_within(&self, tile_idx: usize, center: f32, radius: f32) -> bool {
        let count = match self.counts.get(tile_idx).copied() {
            Some(c) => c as usize,
            None => return false,
        };
        if count == 0 {
            return false;
        }
        let start = match self.offsets.get(tile_idx).copied() {
            Some(s) => s as usize,
            None => return false,
        };
        let end = start + count;
        let Some(slice) = self.entries.get(start..end) else {
            return false;
        };

        let lo = (center - radius).clamp(0.0, 1.0);
        let hi = (center + radius).clamp(0.0, 1.0);

        let i0 = slice.partition_point(|e| e.progress < lo);
        slice.get(i0).is_some_and(|e| e.progress <= hi)
    }

    /// Leader ahead of the ego position on its current tile or the next tile.
    /// Returns (gap_tiles, leader_speed).
    pub fn leader_ahead(
        &self,
        grid: &MapGrid,
        path_pool: &PathPool,
        ego_tile: TilePos,
        ego_progress: f32,
        path_handle: PathHandle,
        path_cursor: usize,
    ) -> Option<(f32, f32)> {
        let mut best: Option<(f32, f32)> = None;

        if let Some(tile_idx) = grid.idx(ego_tile) {
            let count = self.counts.get(tile_idx).copied().unwrap_or(0) as usize;
            if count > 0 {
                let start = self.offsets.get(tile_idx).copied().unwrap_or(0) as usize;
                let end = start + count;
                if let Some(slice) = self.entries.get(start..end) {
                    let i0 = slice.partition_point(|e| e.progress <= ego_progress);
                    if let Some(lead) = slice.get(i0) {
                        best = Some(((lead.progress - ego_progress).max(0.0), lead.speed));
                    }
                }
            }
        }

        if let Some(next_tile) = path_pool.get_tile(path_handle, path_cursor + 1)
            && let Some(next_idx) = grid.idx(next_tile)
            && let Some(e) = self.tile_first(next_idx)
        {
            let g = (1.0_f32 - ego_progress) + e.progress;
            best = Some(match best {
                Some((bg, bv)) if bg <= g => (bg, bv),
                _ => (g.max(0.0), e.speed),
            });
        }

        best
    }

    #[allow(clippy::too_many_arguments)] // Public API method
    pub fn leader_ahead_entity(
        &self,
        grid: &MapGrid,
        path_pool: &PathPool,
        ego: Entity,
        ego_tile: TilePos,
        ego_progress: f32,
        path_handle: PathHandle,
        path_cursor: usize,
    ) -> Option<(Entity, f32, f32)> {
        let tile_idx = grid.idx(ego_tile)?;
        let count = *self.counts.get(tile_idx)? as usize;
        if count == 0 {
            return None;
        }
        let start = *self.offsets.get(tile_idx)? as usize;
        let end = start + count;
        let slice = self.entries.get(start..end)?;

        // Same tile: first vehicle strictly ahead.
        let i0 = slice.partition_point(|e| e.progress <= ego_progress);
        for e in slice.iter().skip(i0) {
            if e.entity != ego {
                return Some((e.entity, (e.progress - ego_progress).max(0.0), e.speed));
            }
        }

        // Next tile: earliest vehicle (closest to entry).
        if let Some(next_tile) = path_pool.get_tile(path_handle, path_cursor + 1) {
            let next_idx = grid.idx(next_tile)?;
            if let Some(e) = self.tile_first(next_idx) {
                let g = (1.0 - ego_progress) + e.progress;
                return Some((e.entity, g.max(0.0), e.speed));
            }
        }
        None
    }
}
