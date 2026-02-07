//! Shared path pool for vehicle routes.
//!
//! Eliminates Vec<TilePos> duplication across vehicles following the same route.
//! Uses refcounting for automatic cleanup when routes are no longer used.

use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::map::TilePos;

/// Handle to a shared path in the pool (dense u32 index).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct PathHandle(pub u32);

impl PathHandle {
    pub const INVALID: Self = Self(u32::MAX);

    pub fn is_valid(self) -> bool {
        self.0 != u32::MAX
    }
}

impl Default for PathHandle {
    fn default() -> Self {
        Self::INVALID
    }
}

/// A path entry in the pool with refcounting.
#[derive(Debug, Clone)]
struct PathEntry {
    /// The actual path tiles.
    path: Vec<TilePos>,
    /// Hash of the path content (used for dedup/removal without cloning).
    path_hash: u64,
    /// Reference count (number of vehicles using this path).
    refcount: u32,
    /// Version/timestamp for cache invalidation.
    version: u64,
    /// Total length in world units (cached for performance).
    #[allow(dead_code)] // Reserved for future distance calculations
    length_world: f32,
}

/// Shared path pool with deduplication and refcounting.
///
/// Design goals:
/// - Eliminate Vec<TilePos> duplication across vehicles
/// - Automatic cleanup via refcounting
/// - O(1) access by PathHandle
/// - Deduplication by path content + version
#[derive(Resource, Debug, Default)]
pub struct PathPool {
    /// Dense array of path entries.
    entries: Vec<PathEntry>,
    /// Free slots for reuse (indices into entries).
    free_slots: Vec<usize>,
    /// Deduplication map: (path_hash, version) -> handles (collision-safe).
    dedup: HashMap<(u64, u64), Vec<PathHandle>>,
    /// Current version counter for cache invalidation.
    current_version: u64,
}

impl PathPool {
    /// Bump the version (invalidates old cached paths).
    #[allow(dead_code)] // Public API method
    pub fn bump_version(&mut self) {
        self.current_version = self.current_version.wrapping_add(1);
        // Note: we don't clear dedup here - let old entries be garbage collected naturally
    }

    /// Get a path by handle. Returns None if handle is invalid.
    pub fn get(&self, handle: PathHandle) -> Option<&[TilePos]> {
        if !handle.is_valid() {
            return None;
        }
        let idx = handle.0 as usize;
        self.entries.get(idx).map(|e| e.path.as_slice())
    }

    /// Get path length in tiles.
    pub fn len(&self, handle: PathHandle) -> usize {
        self.get(handle).map(|p| p.len()).unwrap_or(0)
    }

    /// Get cached world length.
    #[allow(dead_code)] // Public API method
    pub fn length_world(&self, handle: PathHandle) -> f32 {
        if !handle.is_valid() {
            return 0.0;
        }
        let idx = handle.0 as usize;
        self.entries.get(idx).map(|e| e.length_world).unwrap_or(0.0)
    }

    /// Get a tile at specific index in the path.
    pub fn get_tile(&self, handle: PathHandle, index: usize) -> Option<TilePos> {
        self.get(handle)?.get(index).copied()
    }

    /// Get remaining path from cursor position.
    pub fn remaining_from(&self, handle: PathHandle, cursor: usize) -> Option<&[TilePos]> {
        self.get(handle)?.get(cursor..)
    }

    /// Intern a path: return existing handle if identical path exists, otherwise create new.
    ///
    /// Takes ownership of the path vector for efficiency.
    pub fn intern(&mut self, path: Vec<TilePos>) -> PathHandle {
        if path.is_empty() {
            return PathHandle::INVALID;
        }

        // Compute hash for deduplication
        let path_hash = self.compute_path_hash(&path);

        // Check if we already have this exact path at current version
        let key = (path_hash, self.current_version);
        if let Some(handles) = self.dedup.get(&key) {
            for &existing in handles {
                if let Some(entry) = self.entries.get(existing.0 as usize)
                    && entry.refcount > 0
                    && entry.version == self.current_version
                    && entry.path == path
                {
                    // Increment refcount and return existing handle
                    if let Some(entry) = self.entries.get_mut(existing.0 as usize) {
                        entry.refcount = entry.refcount.saturating_add(1);
                    }
                    return existing;
                }
            }
        }

        // Need to create new entry
        let length_world = self.compute_length_world(&path);
        let entry = PathEntry {
            path,
            path_hash,
            refcount: 1,
            version: self.current_version,
            length_world,
        };

        // Find slot (reuse free or append)
        let idx = if let Some(free_idx) = self.free_slots.pop() {
            self.entries[free_idx] = entry;
            free_idx
        } else {
            let new_idx = self.entries.len();
            self.entries.push(entry);
            new_idx
        };

        let handle = PathHandle(idx as u32);

        // Add to dedup map
        self.dedup.entry(key).or_default().push(handle);

        handle
    }

    /// Increment refcount for a handle.
    #[allow(dead_code)] // Public API method
    pub fn retain(&mut self, handle: PathHandle) {
        if !handle.is_valid() {
            return;
        }
        if let Some(entry) = self.entries.get_mut(handle.0 as usize) {
            entry.refcount = entry.refcount.saturating_add(1);
        }
    }

    /// Decrement refcount for a handle. If refcount reaches 0, mark for cleanup.
    pub fn release(&mut self, handle: PathHandle) {
        if !handle.is_valid() {
            return;
        }

        let Some((key_hash, key_version, will_free)) =
            self.entries.get(handle.0 as usize).map(|e| {
                (
                    e.path_hash,
                    e.version,
                    e.refcount == 1, // Will become 0 after decrement
                )
            })
        else {
            return;
        };

        if let Some(entry) = self.entries.get_mut(handle.0 as usize) {
            entry.refcount = entry.refcount.saturating_sub(1);
            if entry.refcount == 0 {
                // Mark slot as free
                self.free_slots.push(handle.0 as usize);
                // Remove from dedup
                if will_free {
                    let key = (key_hash, key_version);
                    if let Some(handles) = self.dedup.get_mut(&key) {
                        handles.retain(|h| *h != handle);
                        if handles.is_empty() {
                            self.dedup.remove(&key);
                        }
                    }
                }
            }
        }
    }

    /// Periodic cleanup: remove unused entries and compact if needed.
    #[allow(dead_code)] // Public API method
    pub fn cleanup(&mut self) {
        // For now, just collect free slots. Full compaction could be added later.
        // The free_slots vec allows reuse, which is the main benefit.
    }

    /// Get pool statistics for debugging.
    #[allow(dead_code)] // Public API method
    pub fn stats(&self) -> PathPoolStats {
        let used_slots = self.entries.len() - self.free_slots.len();
        let dedup_handles = self.dedup.values().map(|v| v.len()).sum::<usize>();
        let total_memory = self
            .entries
            .iter()
            .map(|e| e.path.len() * std::mem::size_of::<TilePos>())
            .sum::<usize>()
            + self.entries.len() * std::mem::size_of::<PathEntry>()
            + self.dedup.len() * std::mem::size_of::<(u64, u64)>()
            + dedup_handles * std::mem::size_of::<PathHandle>();

        PathPoolStats {
            total_entries: self.entries.len(),
            used_entries: used_slots,
            free_entries: self.free_slots.len(),
            dedup_entries: dedup_handles,
            total_memory_bytes: total_memory,
            current_version: self.current_version,
        }
    }

    // Internal helpers
    fn compute_path_hash(&self, path: &[TilePos]) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        hasher.finish()
    }

    fn compute_length_world(&self, path: &[TilePos]) -> f32 {
        // Simple manhattan distance approximation
        // Could be improved with actual road geometry later
        let mut length = 0.0_f32;
        for window in path.windows(2) {
            let dx = (window[1].x - window[0].x).abs() as f32;
            let dy = (window[1].y - window[0].y).abs() as f32;
            length += dx + dy; // Manhattan
        }
        length
    }
}

/// Statistics for debugging path pool usage.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Reserved for future debugging features
pub struct PathPoolStats {
    pub total_entries: usize,
    pub used_entries: usize,
    pub free_entries: usize,
    pub dedup_entries: usize,
    pub total_memory_bytes: usize,
    pub current_version: u64,
}
