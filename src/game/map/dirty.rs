use bevy::prelude::*;

/// Bumps on any edit to the map grid content (roads/zones/buildings/erase/regenerate/load).
///
/// Unlike `GraphVersion`, this is NOT "topology only" and should not be used to rebuild
/// transport graphs. It exists to let expensive whole-map read models (service coverage, etc.)
/// recompute only when the underlying map content actually changed.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct MapEditVersion(pub u64);

impl MapEditVersion {
    pub fn bump(&mut self) {
        self.0 = self.0.wrapping_add(1);
        if self.0 == 0 {
            self.0 = 1;
        }
    }
}

#[derive(Resource, Debug)]
pub struct DirtyTiles {
    flags: Vec<bool>,
    list: Vec<usize>,
}

impl DirtyTiles {
    pub fn new(len: usize) -> Self {
        Self {
            flags: vec![false; len],
            list: Vec::new(),
        }
    }

    pub fn mark(&mut self, idx: usize) {
        if self.flags.get(idx) == Some(&false) {
            self.flags[idx] = true;
            self.list.push(idx);
        }
    }

    pub fn mark_all(&mut self) {
        self.list.clear();
        for (i, f) in self.flags.iter_mut().enumerate() {
            *f = true;
            self.list.push(i);
        }
    }

    /// Drains the current dirty index list into `out` without allocating.
    ///
    /// This is performance-critical: `sync_dirty_tiles_to_render` runs frequently, and the naive
    /// `Vec`-returning API would free the internal buffer every frame.
    pub fn drain_into(&mut self, out: &mut Vec<usize>) {
        out.clear();
        std::mem::swap(out, &mut self.list);
        for &i in out.iter() {
            if let Some(f) = self.flags.get_mut(i) {
                *f = false;
            }
        }
        // Keep `self.list`'s buffer for reuse (it's now `out`'s previous buffer).
    }

    #[cfg(test)]
    pub fn is_marked(&self, idx: usize) -> bool {
        self.flags.get(idx).copied().unwrap_or(false)
    }
}

/// Dirty list for road edits (used for incremental lane marking updates).
#[derive(Resource, Debug)]
pub(super) struct RoadDirtyTiles(pub(super) DirtyTiles);

impl RoadDirtyTiles {
    pub(super) fn new(len: usize) -> Self {
        Self(DirtyTiles::new(len))
    }

    pub(super) fn mark(&mut self, idx: usize) {
        self.0.mark(idx);
    }

    pub(super) fn mark_all(&mut self) {
        self.0.mark_all();
    }

    pub(super) fn drain_into(&mut self, out: &mut Vec<usize>) {
        self.0.drain_into(out);
    }

    pub(super) fn is_empty(&self) -> bool {
        self.0.list.is_empty()
    }
}
