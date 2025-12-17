//! Transport / routing layer (stability + performance guardrails).
//!
//! Hole B from `docs/master-plan.md`:
//! - Road graph as separate layer + GraphVersion incremented on road edits.
//! - Path cache keyed by (start, end, graph_version) with simple TTL + LRU-ish eviction.

use bevy::prelude::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{RoadCell, RoadDir};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficOccupancy;

pub struct TransportPlugin;

impl Plugin for TransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GraphVersion>()
            .init_resource::<RoadGraph>()
            .init_resource::<PathfindingConfig>()
            .init_resource::<PathCache>()
            .add_systems(OnEnter(AppState::MainMenu), reset_transport)
            .add_systems(
                Update,
                rebuild_road_graph
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct GraphVersion(pub u64);

impl GraphVersion {
    pub fn bump(&mut self) {
        self.0 = self.0.wrapping_add(1);
        if self.0 == 0 {
            // Avoid 0 as "special" value in cache keys after wrap.
            self.0 = 1;
        }
    }
}

/// Compact road graph: per-tile bitmask of connected road neighbors + list of road nodes.
#[derive(Resource, Debug, Default, Clone)]
pub struct RoadGraph {
    pub version: u64,
    pub width: usize,
    pub height: usize,
    /// For each tile idx: 4-bit mask (W,E,N,S) indicating adjacent connected road tiles.
    pub edges: Vec<u8>,
    /// Cached list of road tile indices (for random selection / iteration).
    pub road_indices: Vec<usize>,
}

impl RoadGraph {
    pub fn is_built_for(&self, version: u64) -> bool {
        self.version == version && !self.edges.is_empty()
    }
}

#[derive(Resource, Debug, Clone)]
pub struct PathfindingConfig {
    pub cache_capacity: usize,
    pub cache_ttl_secs: f64,
}

impl Default for PathfindingConfig {
    fn default() -> Self {
        Self {
            cache_capacity: 4096,
            cache_ttl_secs: 10.0,
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

fn reset_transport(
    mut gv: ResMut<GraphVersion>,
    mut graph: ResMut<RoadGraph>,
    mut cache: ResMut<PathCache>,
) {
    gv.0 = 1;
    graph.version = 0;
    graph.edges.clear();
    graph.road_indices.clear();
    cache.clear();
}

fn rebuild_road_graph(grid: Res<MapGrid>, gv: Res<GraphVersion>, mut graph: ResMut<RoadGraph>) {
    if graph.is_built_for(gv.0)
        && graph.width == grid.width as usize
        && graph.height == grid.height as usize
    {
        return;
    }

    let w = grid.width as usize;
    let h = grid.height as usize;
    let len = w * h;

    graph.version = gv.0;
    graph.width = w;
    graph.height = h;
    graph.edges.clear();
    graph.edges.resize(len, 0);
    graph.road_indices.clear();

    let road_at_idx = |idx: usize| -> Option<RoadCell> {
        let x = (idx % w) as i32;
        let y = (idx / w) as i32;
        let pos = TilePos { x, y };
        grid.get(pos)
            .and_then(|c| (!c.water && c.road.is_some()).then_some(c.road))
    };

    for idx in 0..len {
        let Some(cur) = road_at_idx(idx) else {
            continue;
        };
        graph.road_indices.push(idx);

        let x = idx % w;
        let y = idx / w;

        let mut mask = 0u8;

        // Movement rules (MVP, right-hand, lane-based):
        // - Straight: move in cur.dir only, to a neighbor lane tile whose dir == cur.dir.
        // - Lane change: move left/right (perpendicular), staying in same dir, only to adjacent lane.
        // - Turn: move left/right into a tile whose dir matches the movement direction,
        //   only from outer lanes (left turn from leftmost, right turn from rightmost).
        let mut consider = |bit: u8, nidx: usize, move_dir: RoadDir| {
            let Some(next) = road_at_idx(nidx) else {
                return;
            };
            if cur.dir == RoadDir::None || next.dir == RoadDir::None {
                return;
            }

            // Straight
            if move_dir == cur.dir && next.dir == cur.dir {
                mask |= 1 << bit;
                return;
            }

            let left = cur.dir.left();
            let right = cur.dir.right();

            // Lane change (perpendicular move, same travel dir)
            if (move_dir == left || move_dir == right)
                && next.dir == cur.dir
                && next.kind == cur.kind
                && next.lanes_total() == cur.lanes_total()
            {
                if next.lane.abs_diff(cur.lane) == 1 {
                    mask |= 1 << bit;
                }
                return;
            }

            // Turn (perpendicular move into new dir lane)
            if move_dir == left && next.dir == left && cur.is_leftmost_for_dir() {
                mask |= 1 << bit;
                return;
            }
            if move_dir == right && next.dir == right && cur.is_rightmost_for_dir() {
                mask |= 1 << bit;
            }
        };

        // W
        if x > 0 {
            consider(0, idx - 1, RoadDir::West);
        }
        // E
        if x + 1 < w {
            consider(1, idx + 1, RoadDir::East);
        }
        // y decreases -> world down -> South
        if y > 0 {
            consider(2, idx - w, RoadDir::South);
        }
        // y increases -> world up -> North
        if y + 1 < h {
            consider(3, idx + w, RoadDir::North);
        }
        graph.edges[idx] = mask;
    }
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
    pub traffic: &'a TrafficOccupancy,
    pub grid: &'a MapGrid,
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

        let mask = ctx.graph.edges[idx];
        if mask == 0 {
            continue;
        }
        // neighbors in W,E,N,S
        let mut push_neighbor =
            |nidx: usize, step_cost: u32, came_from: &mut [Option<usize>], best_g: &mut [u32]| {
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
                step_cost_for_edge(idx, idx - 1, RoadDir::West, w, ctx.traffic, ctx.grid),
                &mut came_from,
                &mut best_g,
            );
        }
        if (mask & (1 << 1)) != 0 && idx + 1 < len {
            push_neighbor(
                idx + 1,
                step_cost_for_edge(idx, idx + 1, RoadDir::East, w, ctx.traffic, ctx.grid),
                &mut came_from,
                &mut best_g,
            );
        }
        if (mask & (1 << 2)) != 0 && idx >= w {
            push_neighbor(
                idx - w,
                step_cost_for_edge(idx, idx - w, RoadDir::South, w, ctx.traffic, ctx.grid),
                &mut came_from,
                &mut best_g,
            );
        }
        if (mask & (1 << 3)) != 0 && idx + w < len {
            push_neighbor(
                idx + w,
                step_cost_for_edge(idx, idx + w, RoadDir::North, w, ctx.traffic, ctx.grid),
                &mut came_from,
                &mut best_g,
            );
        }
    }

    Vec::new()
}

fn step_cost_for_edge(
    cur_idx: usize,
    next_idx: usize,
    move_dir: RoadDir,
    w: usize,
    traffic: &TrafficOccupancy,
    grid: &MapGrid,
) -> u32 {
    // Weight model (MVP):
    // travel_time = 1 / speed_limit
    // congestion_factor = 1 + k * congestion
    // desirability_factor = 1 / desirability
    //
    // edge_weight = travel_time * congestion_factor * desirability_factor
    // Scaled to u32 for A*.
    let cur = grid
        .get(idx_to_pos(cur_idx, w))
        .map(|c| c.road)
        .unwrap_or_default();
    let next = grid
        .get(idx_to_pos(next_idx, w))
        .map(|c| c.road)
        .unwrap_or_default();

    let road_kind = next.kind;

    let speed = road_kind.speed_limit().max(1.0);
    let capacity = (road_kind.capacity_per_lane_tile() as f32).max(1.0);
    let desirability = road_kind.desirability().max(0.1);

    let occupancy = traffic
        .per_tick_vehicles
        .get(next_idx)
        .copied()
        .unwrap_or(0) as f32;
    let congestion = (occupancy / capacity).clamp(0.0, 2.0);

    let congestion_k = 2.0;
    let travel_time = 1.0 / speed;
    let congestion_factor = 1.0 + congestion_k * congestion;
    let desirability_factor = 1.0 / desirability;

    let raw = travel_time * congestion_factor * desirability_factor * 1000.0;

    // Extra penalties to stabilize lane behavior:
    // - lane change: small penalty so we don't zig-zag
    // - turn: slightly larger penalty (turns are "harder" and limited anyway)
    let mut penalty = 0.0f32;
    if cur.dir != RoadDir::None && next.dir != RoadDir::None {
        let left = cur.dir.left();
        let right = cur.dir.right();
        if (move_dir == left || move_dir == right) && next.dir == cur.dir {
            penalty += 40.0;
        } else if (move_dir == left || move_dir == right) && next.dir == move_dir {
            penalty += 80.0;
        }
    }

    (raw + penalty).max(1.0) as u32
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
