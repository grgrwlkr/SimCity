use bevy::prelude::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

use crate::game::intersections::IntersectionIndex;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::traffic::TrafficOccupancy;

use super::{RegionGraph, RoadGraph};

mod cost;

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
    ax.abs_diff(bx) + ay.abs_diff(by)
}

fn idx_to_pos(idx: usize, w: usize) -> TilePos {
    TilePos {
        x: (idx % w) as i32,
        y: (idx / w) as i32,
    }
}

pub fn find_road_path_cached(
    ctx: &mut PathfindingCtx<'_>,
    start: TilePos,
    goal: TilePos,
) -> Vec<TilePos> {
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

    let key = PathKey {
        start,
        goal,
        version: ctx.graph.version,
    };

    // TTL eviction on access
    if let Some(entry) = ctx.cache.map.get(&key)
        && ctx.time_now_sec - entry.last_used_sec <= ctx.cfg.cache_ttl_secs
    {
        // refresh LRU
        ctx.cache.lru.push_back((key, ctx.time_now_sec));
        // clone path out (small vectors in MVP; ok)
        return entry.path.clone();
    }

    let allowed_regions = compute_allowed_regions(ctx, start, goal);

    // Try pruned search first, then fall back to full A* if needed.
    for attempt in 0..2 {
        let allowed = if attempt == 0 {
            allowed_regions.as_deref()
        } else {
            None
        };

        if let Some(out) = astar_road_graph(ctx, start_idx, goal_idx, allowed) {
            // insert into cache + maintain size
            ctx.cache.map.insert(
                key,
                CacheEntry {
                    path: out.clone(),
                    last_used_sec: ctx.time_now_sec,
                },
            );
            ctx.cache.lru.push_back((key, ctx.time_now_sec));
            enforce_cache_limits(ctx.time_now_sec, ctx.cfg, ctx.cache);
            return out;
        }

        if allowed_regions.is_none() {
            break;
        }
    }

    Vec::new()
}

fn astar_road_graph(
    ctx: &mut PathfindingCtx<'_>,
    start_idx: usize,
    goal_idx: usize,
    allowed_regions: Option<&[bool]>,
) -> Option<Vec<TilePos>> {
    let w = ctx.graph.width;
    let len = ctx.graph.edges.len();

    // A* over road graph
    let mut came_from: Vec<Option<usize>> = vec![None; len];
    let mut best_g: Vec<u32> = vec![u32::MAX; len];
    let mut heap = BinaryHeap::<HeapState>::new();

    best_g[start_idx] = 0;
    heap.push(HeapState {
        g: 0,
        f: manhattan_idx(start_idx, goal_idx, w),
        idx: start_idx,
    });

    let regions = ctx.regions;
    let is_allowed = |idx: usize| -> bool {
        let Some(mask) = allowed_regions else {
            return true;
        };
        let Some(rg) = regions else {
            return true;
        };
        let Some(rid) = rg.region_id(idx_to_pos(idx, w)) else {
            return true;
        };
        mask.get(rid).copied().unwrap_or(true)
    };

    while let Some(HeapState { g, idx, .. }) = heap.pop() {
        if g != best_g[idx] {
            continue;
        }
        if idx == goal_idx {
            let mut out = Vec::new();
            let mut cur = Some(goal_idx);
            while let Some(ci) = cur {
                out.push(idx_to_pos(ci, w));
                cur = came_from[ci];
            }
            out.reverse();
            return Some(out);
        }

        let mask = ctx.graph.edges[idx];
        if mask == 0 {
            continue;
        }

        // neighbors in W,E,S,N
        let mut push_neighbor = |nidx: usize, step_cost: u32| {
            if !is_allowed(nidx) {
                return;
            }
            let ng = g.saturating_add(step_cost.max(1));
            if ng < best_g[nidx] {
                best_g[nidx] = ng;
                came_from[nidx] = Some(idx);
                let f = ng.saturating_add(manhattan_idx(nidx, goal_idx, w));
                heap.push(HeapState {
                    g: ng,
                    f,
                    idx: nidx,
                });
            }
        };

        if (mask & (1 << 0)) != 0 && idx > 0 {
            push_neighbor(
                idx - 1,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx - 1,
                    move_dir: RoadDir::West,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
        if (mask & (1 << 1)) != 0 && idx + 1 < len {
            push_neighbor(
                idx + 1,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx + 1,
                    move_dir: RoadDir::East,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
        if (mask & (1 << 2)) != 0 && idx >= w {
            push_neighbor(
                idx - w,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx - w,
                    move_dir: RoadDir::South,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
        if (mask & (1 << 3)) != 0 && idx + w < len {
            push_neighbor(
                idx + w,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx + w,
                    move_dir: RoadDir::North,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
    }

    None
}

fn compute_allowed_regions(
    ctx: &PathfindingCtx<'_>,
    start: TilePos,
    goal: TilePos,
) -> Option<Vec<bool>> {
    if !ctx.cfg.enable_hierarchical {
        return None;
    }
    let rg = ctx.regions?;
    if !rg.is_built_for(
        ctx.graph.version,
        ctx.cfg.region_size.max(1),
        ctx.graph.width,
        ctx.graph.height,
    ) {
        return None;
    }

    let start_r = rg.region_id(start)?;
    let goal_r = rg.region_id(goal)?;
    if start_r == goal_r {
        return None;
    }

    let region_path = bfs_region_path(rg, start_r, goal_r)?;
    let pad = ctx.cfg.region_pad.max(0);

    let mut allowed = vec![false; rg.edges.len()];
    for rid in region_path {
        let rx = (rid % rg.regions_w) as i32;
        let ry = (rid / rg.regions_w) as i32;
        for dy in -pad..=pad {
            for dx in -pad..=pad {
                let nx = rx + dx;
                let ny = ry + dy;
                if nx < 0 || ny < 0 {
                    continue;
                }
                let nxu = nx as usize;
                let nyu = ny as usize;
                if nxu >= rg.regions_w || nyu >= rg.regions_h {
                    continue;
                }
                allowed[nyu * rg.regions_w + nxu] = true;
            }
        }
    }

    Some(allowed)
}

fn bfs_region_path(rg: &RegionGraph, start: usize, goal: usize) -> Option<Vec<usize>> {
    let n = rg.edges.len();
    if start >= n || goal >= n {
        return None;
    }
    let mut pred = vec![usize::MAX; n];
    let mut q = VecDeque::new();
    pred[start] = start;
    q.push_back(start);

    while let Some(cur) = q.pop_front() {
        if cur == goal {
            break;
        }
        let mask = rg.edges[cur];
        let x = cur % rg.regions_w;
        let y = cur / rg.regions_w;

        let visit = |nidx: usize, pred: &mut [usize], q: &mut VecDeque<usize>| {
            if pred[nidx] == usize::MAX {
                pred[nidx] = cur;
                q.push_back(nidx);
            }
        };

        if (mask & (1 << 0)) != 0 && x > 0 {
            visit(cur - 1, &mut pred, &mut q);
        }
        if (mask & (1 << 1)) != 0 && x + 1 < rg.regions_w {
            visit(cur + 1, &mut pred, &mut q);
        }
        if (mask & (1 << 2)) != 0 && y > 0 {
            visit(cur - rg.regions_w, &mut pred, &mut q);
        }
        if (mask & (1 << 3)) != 0 && y + 1 < rg.regions_h {
            visit(cur + rg.regions_w, &mut pred, &mut q);
        }
    }

    if pred[goal] == usize::MAX {
        return None;
    }
    let mut path = Vec::new();
    let mut cur = goal;
    path.push(cur);
    while cur != start {
        cur = pred[cur];
        path.push(cur);
    }
    path.reverse();
    Some(path)
}

fn enforce_cache_limits(time_now_sec: f64, cfg: &PathfindingConfig, cache: &mut PathCache) {
    // TTL purge (approximate, front-biased)
    while let Some((key, used)) = cache.lru.front().copied() {
        if time_now_sec - used <= cfg.cache_ttl_secs {
            break;
        }
        cache.lru.pop_front();
        if let Some(e) = cache.map.get(&key)
            && (e.last_used_sec - used).abs() < f64::EPSILON
        {
            cache.map.remove(&key);
        }
    }

    // Capacity purge (approximate LRU)
    while cache.map.len() > cfg.cache_capacity {
        let Some((key, used)) = cache.lru.pop_front() else {
            break;
        };
        if let Some(e) = cache.map.get(&key)
            && (e.last_used_sec - used).abs() < f64::EPSILON
        {
            cache.map.remove(&key);
        }
    }
}

/// Async pathfinding request ID
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct PathRequestId(pub u64);

/// Async pathfinding request
#[derive(Debug, Clone)]
pub struct PathRequest {
    pub id: PathRequestId,
    pub start: TilePos,
    pub goal: TilePos,
    pub priority: i32, // Higher = more important
}

/// Async pathfinding result
#[derive(Debug)]
pub struct PathResult {
    pub request_id: PathRequestId,
    pub path: Option<Vec<TilePos>>,
}

/// Queue of pending pathfinding requests
#[derive(Resource, Default)]
pub struct PathRequestQueue {
    next_id: u64,
    requests: Vec<PathRequest>,
    processing: HashMap<PathRequestId, PathRequest>,
}

/// Results of completed pathfinding requests
#[derive(Resource, Default)]
pub struct PathResultQueue {
    results: Vec<PathResult>,
}

/// Plugin for async pathfinding system
pub struct AsyncPathfindingPlugin;

impl Plugin for AsyncPathfindingPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PathRequestQueue>()
            .init_resource::<PathResultQueue>()
            .add_systems(FixedUpdate, process_pathfinding_requests);
    }
}

impl PathRequestQueue {
    /// Submit a new pathfinding request
    pub fn submit(&mut self, start: TilePos, goal: TilePos, priority: i32) -> PathRequestId {
        let id = PathRequestId(self.next_id);
        self.next_id = self.next_id.wrapping_add(1);

        let request = PathRequest {
            id,
            start,
            goal,
            priority,
        };
        self.requests.push(request);
        id
    }

    /// Get next request to process (highest priority first)
    pub fn pop_next(&mut self) -> Option<PathRequest> {
        if self.requests.is_empty() {
            return None;
        }

        // Find highest priority request
        let mut best_idx = 0;
        let mut best_priority = self.requests[0].priority;

        for (i, req) in self.requests.iter().enumerate().skip(1) {
            if req.priority > best_priority {
                best_priority = req.priority;
                best_idx = i;
            }
        }

        let request = self.requests.swap_remove(best_idx);
        self.processing.insert(request.id, request.clone());
        Some(request)
    }

    /// Mark request as completed
    pub fn complete(&mut self, id: PathRequestId) {
        self.processing.remove(&id);
    }

    /// Get pending request count
    pub fn pending_count(&self) -> usize {
        self.requests.len()
    }

    /// Get processing request count
    pub fn processing_count(&self) -> usize {
        self.processing.len()
    }
}

impl PathResultQueue {
    /// Add completed pathfinding result
    pub fn push(&mut self, result: PathResult) {
        self.results.push(result);
    }

    /// Get all pending results
    pub fn drain(&mut self) -> std::vec::Drain<PathResult> {
        self.results.drain(..)
    }
}

/// Process pathfinding requests with budget per tick
fn process_pathfinding_requests(
    time: Res<Time>,
    cfg: Res<PathfindingConfig>,
    mut cache: ResMut<PathCache>,
    graph: Res<RoadGraph>,
    regions: Option<Res<RegionGraph>>,
    traffic: Option<Res<TrafficOccupancy>>,
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    mut request_queue: ResMut<PathRequestQueue>,
    mut result_queue: ResMut<PathResultQueue>,
) {
    // Budget: process up to 8 requests per tick to avoid stalls
    const MAX_REQUESTS_PER_TICK: usize = 8;
    let mut processed = 0;

    // Default traffic occupancy for when none is available
    let default_traffic = TrafficOccupancy::default();

    while processed < MAX_REQUESTS_PER_TICK {
        let Some(request) = request_queue.pop_next() else {
            break;
        };

        // Create pathfinding context for this request
        let mut ctx = PathfindingCtx {
            time_now_sec: time.elapsed_secs_f64(),
            cfg: &cfg,
            cache: &mut cache,
            graph: &graph,
            regions: regions.as_deref(),
            traffic: traffic.as_deref().unwrap_or(&default_traffic),
            grid: &grid,
            intersections: &intersections,
        };

        // Process the pathfinding request
        let path = find_road_path_cached(&mut ctx, request.start, request.goal);

        // Store result
        result_queue.push(PathResult {
            request_id: request.id,
            path: Some(path),
        });

        // Mark as completed
        request_queue.complete(request.id);
        processed += 1;
    }
}
