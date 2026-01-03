use bevy::prelude::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

use crate::game::intersections::IntersectionIndex;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::traffic::TrafficOccupancy;

use super::{RegionGraph, RoadGraph};

mod astar;
mod r#async;
mod cache;
pub mod cost;
mod regions;

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct PathfindingConfig {
    pub cache_capacity: usize,
    pub cache_ttl_secs: f64,
    /// Congestion weight factor `k` in: `w = base_cost * (1 + k * congestion)`.
    pub congestion_k: f32,
    /// Clamp for congestion ratio (occupancy / capacity).
    pub congestion_max: f32,
    /// Cost penalty for lane changes (perpendicular move, same travel dir).
    pub lane_change_penalty: f32,
    /// Cost penalty for turns (perpendicular move into new dir lane).
    pub turn_penalty: f32,
    /// Scale factor converting float weights into integer A* costs.
    pub cost_scale: f32,

    /// Enable a simple hierarchical pre-pass (region graph) to prune A* search space.
    pub enable_hierarchical: bool,
    /// Region size in tiles for the hierarchical pre-pass.
    pub region_size: usize,
    /// How many neighbor regions around the high-level path to include (safety margin).
    pub region_pad: i32,
}

impl Default for PathfindingConfig {
    fn default() -> Self {
        Self {
            cache_capacity: 4096,
            cache_ttl_secs: 10.0,
            congestion_k: 2.0,
            congestion_max: 2.0,
            lane_change_penalty: 40.0,
            turn_penalty: 80.0,
            cost_scale: 1000.0,

            enable_hierarchical: true,
            region_size: 16,
            region_pad: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
struct PathKey {
    start: TilePos,
    goal: TilePos,
    version: u64,
}

#[derive(Clone, Debug)]
struct CacheEntry {
    path: Vec<TilePos>,
    last_used_sec: f64,
}

/// A very small, dependency-free cache (TTL + approximate LRU).
#[derive(Resource, Debug, Default)]
pub struct PathCache {
    map: HashMap<PathKey, CacheEntry>,
    // (key, last_used_sec_at_push) allows skipping stale deque entries
    lru: VecDeque<(PathKey, f64)>,
}

impl PathCache {
    #[allow(dead_code)] // Public API method
    pub fn clear(&mut self) {
        self.map.clear();
        self.lru.clear();
    }
}

/// Find a road path using the current road graph and cache.
///
/// Returns empty vec if:
/// - graph not built for version
/// - start/goal not road nodes
/// - no path found
pub struct PathfindingCtx<'a> {
    pub time_now_sec: f64,
    pub cfg: &'a PathfindingConfig,
    pub cache: &'a mut PathCache,
    pub graph: &'a RoadGraph,
    pub regions: Option<&'a RegionGraph>,
    pub traffic: &'a TrafficOccupancy,
    pub grid: &'a MapGrid,
    pub intersections: &'a IntersectionIndex,
}

#[derive(Copy, Clone, Eq, PartialEq)]
struct HeapState {
    f: u32,
    g: u32,
    idx: usize,
}

impl Ord for HeapState {
    fn cmp(&self, other: &Self) -> Ordering {
        // reverse for min-heap behavior
        other
            .f
            .cmp(&self.f)
            .then_with(|| other.g.cmp(&self.g))
            .then_with(|| other.idx.cmp(&self.idx))
    }
}
impl PartialOrd for HeapState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn manhattan_idx(a: usize, b: usize, w: usize) -> u32 {
    let ax = (a % w) as i32;
    let ay = (a / w) as i32;
    let bx = (b % w) as i32;
    let by = (b / w) as i32;
    ((ax - bx).abs() + (ay - by).abs()) as u32
}

fn idx_to_pos(idx: usize, w: usize) -> TilePos {
    TilePos {
        x: (idx % w) as i32,
        y: (idx / w) as i32,
    }
}

/// Find a road path using the current road graph and cache.
///
/// Returns empty vec if:
/// - graph not built for version
/// - start/goal not road nodes
/// - no path found
pub fn find_road_path_cached(
    ctx: &mut PathfindingCtx<'_>,
    start: TilePos,
    goal: TilePos,
) -> Vec<TilePos> {
    if ctx.graph.version != ctx.cache.map.keys().next().map(|k| k.version).unwrap_or(0) {
        ctx.cache.map.clear();
        ctx.cache.lru.clear();
    }

    let key = PathKey {
        start,
        goal,
        version: ctx.graph.version,
    };

    // Check cache
    if let Some(entry) = ctx.cache.map.get(&key) {
        // Touch for LRU
        ctx.cache.lru.retain(|(k, _)| k != &key);
        ctx.cache.lru.push_back((key, ctx.time_now_sec));
        // Update last_used_sec
        // Note: We can't modify the entry directly since it's behind &mut, but we update on access
        return entry.path.clone();
    }

    // Compute path
    let path = find_road_path(ctx, start, goal);

    // Cache if reasonable size
    if path.len() >= 2 && path.len() <= 1000 {
        ctx.cache.map.insert(
            key,
            CacheEntry {
                path: path.clone(),
                last_used_sec: ctx.time_now_sec,
            },
        );
        ctx.cache.lru.push_back((key, ctx.time_now_sec));
        cache::enforce_cache_limits(ctx.time_now_sec, ctx.cfg, ctx.cache);
    }

    path
}

fn find_road_path(ctx: &mut PathfindingCtx<'_>, start: TilePos, goal: TilePos) -> Vec<TilePos> {
    if start == goal {
        return vec![start];
    }
    if ctx.graph.edges.is_empty() || ctx.graph.width == 0 {
        return Vec::new();
    }

    let w = ctx.graph.width;
    let len = ctx.graph.edges.len();

    let start_idx = (start.y as isize) * (w as isize) + (start.x as isize);
    let goal_idx = (goal.y as isize) * (w as isize) + (goal.x as isize);
    if start_idx < 0 || goal_idx < 0 {
        return Vec::new();
    }
    let start_idx = start_idx as usize;
    let goal_idx = goal_idx as usize;
    if start_idx >= len || goal_idx >= len {
        return Vec::new();
    }
    if ctx.graph.edges[start_idx] == 0 {
        // Must be on road graph (note: dead-end road would still have mask != 0 if connected).
        return Vec::new();
    }

    // Hierarchical pre-pass to compute allowed regions
    let allowed_regions = regions::compute_allowed_regions(ctx, start, goal);

    // A* search
    astar::astar_road_graph(ctx, start_idx, goal_idx, allowed_regions.as_deref())
        .unwrap_or_default()
}
