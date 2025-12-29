//! Transport / routing layer (stability + performance guardrails).
//!
//! Hole B from `docs/master-plan.md`:
//! - Road graph as separate layer + GraphVersion incremented on road edits.
//! - Path cache keyed by (start, end, graph_version) with simple TTL + LRU-ish eviction.

use bevy::prelude::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

use crate::game::intersections::IntersectionIndex;
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
            .init_resource::<RegionGraph>()
            .init_resource::<PathfindingConfig>()
            .init_resource::<PathCache>()
            .add_systems(OnEnter(AppState::MainMenu), reset_transport)
            .add_systems(
                Update,
                rebuild_road_graph
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                rebuild_region_graph
                    .in_set(GameSet::GraphUpdate)
                    .after(rebuild_road_graph)
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

/// Pick a nearby road tile for spawning/routing from a building tile.
///
/// Tries `pos` first, then its 4-neighbors, preferring a road tile whose `RoadDir`
/// points roughly towards `target`. Falls back to "any adjacent road".
pub fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
    let want = desired_dir(pos, target);
    let mut best_any = None;

    // Check pos itself first, then 4-neighbors.
    let candidates = [
        pos,
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
    ];

    for cpos in candidates {
        if let Some(cell) = grid.get(cpos)
            && !cell.water
            && cell.road.is_some()
        {
            best_any = best_any.or(Some(cpos));
            if cell.road.dir == want {
                return Some(cpos);
            }
        }
    }

    best_any
}

fn desired_dir(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() >= dy.abs() {
        if dx >= 0 {
            RoadDir::East
        } else {
            RoadDir::West
        }
    } else if dy >= 0 {
        RoadDir::North
    } else {
        RoadDir::South
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
    fn is_built_for(&self, version: u64, region_size: usize, w: usize, h: usize) -> bool {
        if self.version != version || self.region_size != region_size || self.edges.is_empty() {
            return false;
        }
        let expect_w = w.div_ceil(region_size);
        let expect_h = h.div_ceil(region_size);
        self.regions_w == expect_w && self.regions_h == expect_h
    }

    fn region_id(&self, pos: TilePos) -> Option<usize> {
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

fn reset_transport(
    mut gv: ResMut<GraphVersion>,
    mut graph: ResMut<RoadGraph>,
    mut regions: ResMut<RegionGraph>,
    mut cache: ResMut<PathCache>,
) {
    gv.0 = 1;
    graph.version = 0;
    graph.edges.clear();
    graph.road_indices.clear();
    regions.version = 0;
    regions.edges.clear();
    cache.clear();
}

fn rebuild_road_graph(grid: Res<MapGrid>, gv: Res<GraphVersion>, mut graph: ResMut<RoadGraph>) {
    rebuild_road_graph_inner(&grid, &gv, &mut graph);
}

pub(crate) fn rebuild_road_graph_inner(grid: &MapGrid, gv: &GraphVersion, graph: &mut RoadGraph) {
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

        // One-way roads: ignore lane tiles that don't match the one-way direction.
        // This prevents pathfinding from using the "opposite" carriageway tiles on one-way segments.
        if let crate::game::roads::RoadFlow::OneWay(one_way_dir) = cur.flow
            && cur.dir != RoadDir::None
            && cur.dir != one_way_dir
        {
            continue;
        }
        graph.road_indices.push(idx);

        let x = idx % w;
        let y = idx / w;

        let mut mask = 0u8;

        // Movement rules (strict lane-based, right-hand traffic):
        // 1. Straight: move in cur.dir only, to a neighbor lane tile whose dir == cur.dir.
        // 2. Lane change: move left/right (perpendicular), staying in same dir, only to adjacent lane.
        // 3. Turn: move left/right into a tile whose dir matches the movement direction,
        //    only from outer lanes (left turn from leftmost, right turn from rightmost).
        // 4. U-turn: only allowed at intersections (tile with multiple road directions).
        //
        // FORBIDDEN:
        // - Moving against lane direction (driving wrong way).
        // - Crossing into oncoming traffic lanes (except at intersections for turns).
        // - Lane changes to oncoming lanes.
        let mut consider = |bit: u8, nidx: usize, move_dir: RoadDir| {
            let Some(next) = road_at_idx(nidx) else {
                return;
            };

            // One-way roads: reject entering lane tiles that don't match the one-way direction.
            // NOTE: do NOT gate on `move_dir` (lane changes are perpendicular moves).
            if let crate::game::roads::RoadFlow::OneWay(one_way_dir) = next.flow
                && next.dir != RoadDir::None
                && next.dir != one_way_dir
            {
                return;
            }

            // Check lane type restrictions for turn-lane entry.
            // IMPORTANT: apply this only when entering an intersection tile from a lane tile.
            // (Intersection tiles themselves may keep default lane_type values and shouldn't affect circulation.)
            if cur.dir != RoadDir::None && next.dir == RoadDir::None {
                // At intersection - check if lane type allows this movement
                let is_left_turn = move_dir == cur.dir.left();
                let is_right_turn = move_dir == cur.dir.right();
                let is_straight = move_dir == cur.dir;

                match cur.lane_type {
                    crate::game::roads::LaneType::LeftTurnOnly => {
                        // Only allow left turn
                        if !is_left_turn {
                            return;
                        }
                    }
                    crate::game::roads::LaneType::RightTurnOnly => {
                        // Only allow right turn
                        if !is_right_turn {
                            return;
                        }
                    }
                    crate::game::roads::LaneType::StraightOnly => {
                        // Only allow straight
                        if !is_straight {
                            return;
                        }
                    }
                    crate::game::roads::LaneType::Regular => {
                        // Regular lane allows all movements
                    }
                }
            }

            // Intersection nodes (`dir: None`) are special:
            // - allow entering from straight or valid turn entry
            // - allow leaving only into lanes matching movement direction
            // - allow movement within intersection tiles
            match (cur.dir, next.dir) {
                (RoadDir::None, RoadDir::None) => {
                    // Movement within intersection: enforce circular movement (counter-clockwise for right-hand traffic).
                    // This prevents vehicles from crossing into oncoming lanes during intersection navigation.
                    //
                    // For counter-clockwise circulation (right-hand traffic):
                    // - Top edge: can only move West (left)
                    // - Left edge: can only move South (down)
                    // - Bottom edge: can only move East (right)
                    // - Right edge: can only move North (up)
                    //
                    // This creates a circular flow around the perimeter of the intersection,
                    // preventing illegal maneuvers like crossing the center diagonally.

                    if !lanes_on_same_road_side(cur, next) {
                        return;
                    }

                    // Determine which edge of the intersection we're on and enforce circular flow.
                    // We need to find the bounds of the current intersection cluster.
                    let cur_x = idx % w;
                    let cur_y = idx / w;

                    // For now, use a simple heuristic: check neighboring intersection tiles
                    // to determine our position in the intersection grid.
                    let has_intersection_west =
                        cur_x > 0 && road_at_idx(idx - 1).is_some_and(|r| r.dir == RoadDir::None);
                    let has_intersection_east = cur_x + 1 < w
                        && road_at_idx(idx + 1).is_some_and(|r| r.dir == RoadDir::None);
                    let has_intersection_south =
                        cur_y > 0 && road_at_idx(idx - w).is_some_and(|r| r.dir == RoadDir::None);
                    let has_intersection_north = cur_y + 1 < h
                        && road_at_idx(idx + w).is_some_and(|r| r.dir == RoadDir::None);

                    // Determine position in intersection and allowed movement directions.
                    // Corners allow two directions: one along the circular flow, one for exit.
                    // Edges allow one direction along the circular flow.
                    // Interior tiles allow any direction (for larger intersections).

                    let allowed = if !has_intersection_north && !has_intersection_east {
                        // Top-right corner: allow West (circular) or South (toward exit/continue)
                        move_dir == RoadDir::West || move_dir == RoadDir::South
                    } else if !has_intersection_north && !has_intersection_west {
                        // Top-left corner: allow South (circular) or could exit North/West
                        move_dir == RoadDir::South
                            || move_dir == RoadDir::West
                            || move_dir == RoadDir::North
                    } else if !has_intersection_south && !has_intersection_west {
                        // Bottom-left corner: allow East (circular) or South (toward exit)
                        move_dir == RoadDir::East
                            || move_dir == RoadDir::South
                            || move_dir == RoadDir::West
                    } else if !has_intersection_south && !has_intersection_east {
                        // Bottom-right corner: allow North (circular) or East (continue)
                        move_dir == RoadDir::North || move_dir == RoadDir::East
                    } else if !has_intersection_north {
                        // Top edge (but not corner): move West only
                        move_dir == RoadDir::West
                    } else if !has_intersection_west {
                        // Left edge (but not corner): move South only
                        move_dir == RoadDir::South
                    } else if !has_intersection_south {
                        // Bottom edge (but not corner): move East only
                        move_dir == RoadDir::East
                    } else if !has_intersection_east {
                        // Right edge (but not corner): move North only
                        move_dir == RoadDir::North
                    } else {
                        // Interior tile: allow movement in any direction
                        true
                    };

                    if allowed {
                        mask |= 1 << bit;
                    }
                    return;
                }
                (RoadDir::None, nd) => {
                    // Leaving an intersection: must enter a lane that matches movement dir.
                    // CRITICAL: The target tile must be PHYSICALLY in the direction of movement
                    // AND the lane must be going in the same direction as we're moving.
                    // This prevents "teleporting" across oncoming lanes at intersections.
                    if nd == RoadDir::None || nd != move_dir {
                        return;
                    }

                    let cur_x = idx % w;
                    let cur_y = idx / w;
                    let next_x = nidx % w;
                    let next_y = nidx / w;

                    let delta = move_dir.delta();
                    let actual_dx = (next_x as i32) - (cur_x as i32);
                    let actual_dy = (next_y as i32) - (cur_y as i32);

                    // Only allow movement if the target is in the correct physical direction.
                    if actual_dx == delta.x && actual_dy == delta.y {
                        // ADDITIONAL CHECK: Ensure we enter the correct lane for the direction.
                        // For right-hand traffic, turns should enter appropriate lanes:
                        // - Right turn: enter rightmost lane of target direction
                        // - Left turn: enter leftmost lane of target direction
                        // - Straight: can enter any lane of target direction

                        // For now, allow any valid lane. The turn logic should have ensured
                        // we only reach here from valid entry points.
                        mask |= 1 << bit;
                    }
                    return;
                }
                (cd, RoadDir::None) => {
                    // Entering an intersection: allow straight or a valid turn entry.
                    // CRITICAL: Verify target tile is physically in the movement direction.
                    let cur_x = idx % w;
                    let cur_y = idx / w;
                    let next_x = nidx % w;
                    let next_y = nidx / w;

                    let delta = move_dir.delta();
                    let actual_dx = (next_x as i32) - (cur_x as i32);
                    let actual_dy = (next_y as i32) - (cur_y as i32);

                    // Must be moving in the correct physical direction.
                    if actual_dx != delta.x || actual_dy != delta.y {
                        return;
                    }

                    let left = cd.left();
                    let right = cd.right();

                    // Straight: always allowed (moving in lane direction).
                    if move_dir == cd {
                        mask |= 1 << bit;
                        return;
                    }
                    // Left turn: only from leftmost lane (closest to center).
                    // CRITICAL: Check that we don't cross into oncoming traffic lanes
                    if move_dir == left && cur.is_leftmost_for_dir() {
                        // For left turn, ensure the target lane is on the same side of road
                        // (same direction or intersection lane)
                        if (next.dir == RoadDir::None || next.dir == move_dir)
                            && lanes_on_same_road_side(cur, next)
                        {
                            mask |= 1 << bit;
                            return;
                        }
                    }
                    // Right turn: only from rightmost lane.
                    // CRITICAL: Check that we don't cross into oncoming traffic lanes
                    if move_dir == right && cur.is_rightmost_for_dir() {
                        // For right turn, ensure the target lane is on the same side of road
                        // (same direction or intersection lane)
                        if (next.dir == RoadDir::None || next.dir == move_dir)
                            && lanes_on_same_road_side(cur, next)
                        {
                            mask |= 1 << bit;
                        }
                    }
                    return;
                }
                _ => {}
            }

            // BLOCK: Never allow moving opposite to our lane direction (wrong-way driving).
            if move_dir == cur.dir.opposite() {
                return;
            }

            // BLOCK: Never allow entering a lane going opposite to us (head-on collision).
            if next.dir == cur.dir.opposite() {
                return;
            }

            let left = cur.dir.left();
            let right = cur.dir.right();

            // Straight movement: only if moving in our direction and next lane matches.
            if move_dir == cur.dir && next.dir == cur.dir {
                mask |= 1 << bit;
                return;
            }

            // Lane change (perpendicular move, same travel dir on same road).
            if (move_dir == left || move_dir == right)
                && next.dir == cur.dir
                && next.kind == cur.kind
                && next.lanes_total() == cur.lanes_total()
            {
                // Only adjacent lane (lane index differs by 1).
                if next.lane.abs_diff(cur.lane) == 1 {
                    mask |= 1 << bit;
                }
                return;
            }

            // Turn at intersection (perpendicular move into new direction lane).
            // Standard traffic rules: turn into the nearest lane of the target direction.
            //
            // CRITICAL: Ensure we don't cross into oncoming traffic lanes during turns.
            // For multi-lane roads, lanes are divided: lower indices = one direction, higher = opposite.
            // Turns must stay within the same "side" of the road.

            // Left turn: from leftmost lane → into leftmost lane of new direction.
            if move_dir == left
                && next.dir == left
                && cur.is_leftmost_for_dir()
                && next.is_leftmost_for_dir()
                && lanes_on_same_road_side(cur, next)
            {
                mask |= 1 << bit;
                return;
            }
            // Right turn: from rightmost lane → into rightmost lane of new direction.
            if move_dir == right
                && next.dir == right
                && cur.is_rightmost_for_dir()
                && next.is_rightmost_for_dir()
                && lanes_on_same_road_side(cur, next)
            {
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

fn rebuild_region_graph(
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
    pub regions: Option<&'a RegionGraph>,
    pub traffic: &'a TrafficOccupancy,
    pub grid: &'a MapGrid,
    pub intersections: &'a IntersectionIndex,
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
                step_cost_for_edge(StepCostParams {
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
                step_cost_for_edge(StepCostParams {
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
                step_cost_for_edge(StepCostParams {
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
                step_cost_for_edge(StepCostParams {
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

struct StepCostParams<'a> {
    cur_idx: usize,
    next_idx: usize,
    move_dir: RoadDir,
    w: usize,
    cfg: &'a PathfindingConfig,
    traffic: &'a TrafficOccupancy,
    grid: &'a MapGrid,
    intersections: &'a IntersectionIndex,
}

fn step_cost_for_edge(params: StepCostParams) -> u32 {
    let StepCostParams {
        cur_idx,
        next_idx,
        move_dir,
        w,
        cfg,
        traffic,
        grid,
        intersections,
    } = params;
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
    // We compute the weight for entering `next_idx` (cost-to-enter model).
    let congestion = (occupancy / capacity).clamp(0.0, cfg.congestion_max.max(0.0));

    let travel_time = 1.0 / speed;
    let desirability_factor = 1.0 / desirability;
    let base_cost = travel_time * desirability_factor;
    let congestion_factor = 1.0 + cfg.congestion_k * congestion;

    let raw = base_cost * congestion_factor * cfg.cost_scale.max(1.0);

    // Extra penalties to stabilize lane behavior:
    // - lane change: small penalty so we don't zig-zag
    // - turn: slightly larger penalty (turns are "harder" and limited anyway)
    let mut penalty = 0.0f32;
    if cur.dir != RoadDir::None && next.dir != RoadDir::None {
        let left = cur.dir.left();
        let right = cur.dir.right();
        if (move_dir == left || move_dir == right) && next.dir == cur.dir {
            penalty += cfg.lane_change_penalty.max(0.0);
        } else if (move_dir == left || move_dir == right) && next.dir == move_dir {
            penalty += cfg.turn_penalty.max(0.0);
        }
    }

    // Traffic light penalty: average wait time (half cycle duration)
    let mut traffic_light_penalty = 0.0f32;
    let next_pos = idx_to_pos(next_idx, w);
    if intersections.has_traffic_light_at(next_pos) {
        // Average delay: half of a typical cycle (10s / 2 = 5s)
        // Convert to cost units (assuming 1.0 = 1 tile travel time)
        let avg_wait_secs = 5.0;
        traffic_light_penalty = avg_wait_secs * cfg.cost_scale.max(1.0);
    }

    (raw + penalty + traffic_light_penalty).max(1.0) as u32
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

/// Check if two lanes are on the same side of a multi-lane road.
/// For roads with even number of lanes, lower half = one direction, upper half = opposite.
/// This prevents turns from crossing into oncoming traffic.
fn lanes_on_same_road_side(cur: RoadCell, next: RoadCell) -> bool {
    let cur_lanes = cur.lanes_total();
    let next_lanes = next.lanes_total();

    // Different road types or lane counts - be conservative
    if cur.kind != next.kind || cur_lanes != next_lanes {
        return false;
    }

    let half_lanes = cur_lanes / 2;

    // For single-direction roads (2 lanes), all lanes are same direction
    if cur_lanes <= 2 {
        return true;
    }

    // Check if both lanes are in the same half (same traffic direction)
    let cur_side = if cur.lane < half_lanes { 0 } else { 1 };
    let next_side = if next.lane < half_lanes { 0 } else { 1 };

    cur_side == next_side
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};

    #[test]
    fn congestion_affects_route_choice_between_parallel_lanes() {
        // Two parallel east-bound lane tiles (y=0 lane0, y=1 lane1) from x=0..3.
        // We congest the lower lane around the middle so pathfinding should lane-change to avoid it.
        let mut grid = MapGrid::new(4, 2);
        for x in 0..4 {
            let pos0 = TilePos { x, y: 0 };
            let mut c0 = grid.get(pos0).unwrap_or_default();
            c0.water = false;
            c0.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos0, c0);

            let pos1 = TilePos { x, y: 1 };
            let mut c1 = grid.get(pos1).unwrap_or_default();
            c1.water = false;
            c1.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 1,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos1, c1);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);
        assert!(graph.is_built_for(gv.0));

        // Congest tiles (1,0) and (2,0) to push the route onto y=1.
        let mut traffic = TrafficOccupancy::default();
        traffic.per_tick_vehicles.resize(grid.len(), 0);
        traffic.ema_heat.resize(grid.len(), 0.0);
        let idx_10 = grid.idx(TilePos { x: 1, y: 0 }).unwrap();
        let idx_20 = grid.idx(TilePos { x: 2, y: 0 }).unwrap();
        traffic.per_tick_vehicles[idx_10] = 6;
        traffic.per_tick_vehicles[idx_20] = 6;

        let cfg = PathfindingConfig::default();
        let mut cache = PathCache::default();
        let intersections = IntersectionIndex::default();
        let mut ctx = PathfindingCtx {
            time_now_sec: 0.0,
            cfg: &cfg,
            cache: &mut cache,
            graph: &graph,
            regions: None,
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };

        let start = TilePos { x: 0, y: 0 };
        let goal = TilePos { x: 3, y: 0 };
        let path = find_road_path_cached(&mut ctx, start, goal);

        assert_eq!(path.first().copied(), Some(start));
        assert_eq!(path.last().copied(), Some(goal));
        assert!(
            path.iter().any(|p| p.y == 1),
            "Expected path to use the alternate lane due to congestion"
        );
        assert!(
            !path.contains(&TilePos { x: 1, y: 0 }),
            "Expected path to avoid congested tile (1,0)"
        );
        assert!(
            !path.contains(&TilePos { x: 2, y: 0 }),
            "Expected path to avoid congested tile (2,0)"
        );
    }

    #[test]
    fn lane_type_left_turn_only_allows_only_left_entry_into_intersection() {
        // Lane tile at (1,1) going North, surrounded by intersection tiles on North/West/East.
        let mut grid = MapGrid::new(3, 3);
        let lane = TilePos { x: 1, y: 1 };

        let mut c = grid.get(lane).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::North,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::LeftTurnOnly,
        };
        grid.set(lane, c);

        for pos in [
            TilePos { x: 1, y: 2 },
            TilePos { x: 0, y: 1 },
            TilePos { x: 2, y: 1 },
        ] {
            let mut ic = grid.get(pos).unwrap_or_default();
            ic.water = false;
            ic.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::None,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos, ic);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let idx = grid.idx(lane).unwrap();
        let mask = graph.edges[idx];

        // W=bit0, E=bit1, S=bit2, N=bit3
        assert_ne!(
            mask & (1 << 0),
            0,
            "left turn should be allowed (West entry)"
        );
        assert_eq!(mask & (1 << 1), 0, "right entry should be blocked");
        assert_eq!(mask & (1 << 3), 0, "straight entry should be blocked");
    }

    #[test]
    fn lane_type_right_turn_only_allows_only_right_entry_into_intersection() {
        let mut grid = MapGrid::new(3, 3);
        let lane = TilePos { x: 1, y: 1 };

        let mut c = grid.get(lane).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::North,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::RightTurnOnly,
        };
        grid.set(lane, c);

        for pos in [
            TilePos { x: 1, y: 2 },
            TilePos { x: 0, y: 1 },
            TilePos { x: 2, y: 1 },
        ] {
            let mut ic = grid.get(pos).unwrap_or_default();
            ic.water = false;
            ic.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::None,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos, ic);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let idx = grid.idx(lane).unwrap();
        let mask = graph.edges[idx];

        assert_eq!(mask & (1 << 0), 0, "left entry should be blocked");
        assert_ne!(
            mask & (1 << 1),
            0,
            "right turn should be allowed (East entry)"
        );
        assert_eq!(mask & (1 << 3), 0, "straight entry should be blocked");
    }

    #[test]
    fn lane_type_straight_only_allows_only_straight_entry_into_intersection() {
        let mut grid = MapGrid::new(3, 3);
        let lane = TilePos { x: 1, y: 1 };

        let mut c = grid.get(lane).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::North,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::StraightOnly,
        };
        grid.set(lane, c);

        for pos in [
            TilePos { x: 1, y: 2 },
            TilePos { x: 0, y: 1 },
            TilePos { x: 2, y: 1 },
        ] {
            let mut ic = grid.get(pos).unwrap_or_default();
            ic.water = false;
            ic.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::None,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos, ic);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let idx = grid.idx(lane).unwrap();
        let mask = graph.edges[idx];

        assert_eq!(mask & (1 << 0), 0, "left entry should be blocked");
        assert_eq!(mask & (1 << 1), 0, "right entry should be blocked");
        assert_ne!(
            mask & (1 << 3),
            0,
            "straight should be allowed (North entry)"
        );
    }

    #[test]
    fn one_way_ignores_opposite_direction_lane_tiles() {
        // Three adjacent tiles, all marked one-way East:
        // - left tile is incorrectly "West" dir (should be ignored)
        // - middle/right tiles are "East" dir (valid)
        // The middle one should have a usable outgoing edge to the right.
        let mut grid = MapGrid::new(3, 1);

        let west_lane = TilePos { x: 0, y: 0 };
        let east_lane_mid = TilePos { x: 1, y: 0 };
        let east_lane_end = TilePos { x: 2, y: 0 };

        for (pos, dir) in [
            (west_lane, RoadDir::West),
            (east_lane_mid, RoadDir::East),
            (east_lane_end, RoadDir::East),
        ] {
            let mut c = grid.get(pos).unwrap_or_default();
            c.water = false;
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir,
                lane: 0,
                flow: crate::game::roads::RoadFlow::OneWay(RoadDir::East),
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos, c);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let idx_bad = grid.idx(west_lane).unwrap();
        let idx_ok = grid.idx(east_lane_mid).unwrap();

        assert_eq!(
            graph.edges[idx_bad], 0,
            "opposite-direction lane should be ignored"
        );
        assert_ne!(
            graph.edges[idx_ok], 0,
            "valid one-way lane should remain usable"
        );
    }

    #[test]
    fn one_way_allows_lane_change_between_same_direction_lanes() {
        // Two parallel eastbound lanes (y=0 and y=1), both one-way East.
        // Ensure lane-change edge is not blocked by one-way logic (perpendicular move).
        let mut grid = MapGrid::new(1, 2);

        for y in 0..2 {
            let pos = TilePos { x: 0, y };
            let mut c = grid.get(pos).unwrap_or_default();
            c.water = false;
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: y as u8,
                flow: crate::game::roads::RoadFlow::OneWay(RoadDir::East),
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos, c);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let idx0 = grid.idx(TilePos { x: 0, y: 0 }).unwrap();
        let idx1 = grid.idx(TilePos { x: 0, y: 1 }).unwrap();

        // From y=0 to y=1 is a North move (bit3).
        assert_ne!(
            graph.edges[idx0] & (1 << 3),
            0,
            "lane-change across one-way lanes should be allowed"
        );
        // From y=1 to y=0 is a South move (bit2).
        assert_ne!(
            graph.edges[idx1] & (1 << 2),
            0,
            "lane-change across one-way lanes should be allowed"
        );
    }
}
