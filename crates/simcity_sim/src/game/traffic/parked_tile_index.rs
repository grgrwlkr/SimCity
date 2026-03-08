use bevy::prelude::*;

/// Per-tile parked vehicle counts (cheap to query for UI/debug).
///
/// This is filled as part of the existing parked-vehicle position update (so no extra scans).
#[derive(Resource, Debug, Default, Clone)]
pub struct ParkedVehicleTileIndex {
    grid_len: usize,
    counts: Vec<u32>,
    touched: Vec<usize>,
}

impl ParkedVehicleTileIndex {
    pub fn ensure_len(&mut self, len: usize) {
        if self.grid_len != len {
            self.grid_len = len;
            self.counts.clear();
            self.counts.resize(len, 0);
            self.touched.clear();
        }
    }

    pub fn begin_frame(&mut self, len: usize) {
        self.ensure_len(len);
        for &i in self.touched.iter() {
            self.counts[i] = 0;
        }
        self.touched.clear();
    }

    pub fn bump(&mut self, tile_idx: usize) {
        let Some(slot) = self.counts.get_mut(tile_idx) else {
            return;
        };
        if *slot == 0 {
            self.touched.push(tile_idx);
        }
        *slot = slot.saturating_add(1);
    }

    pub fn count(&self, tile_idx: usize) -> u32 {
        self.counts.get(tile_idx).copied().unwrap_or(0)
    }
}
