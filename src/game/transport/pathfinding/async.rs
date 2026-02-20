use bevy::prelude::*;

use crate::game::map::TilePos;

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
    processing: std::collections::HashMap<PathRequestId, PathRequest>,
}

/// Results of completed pathfinding requests
#[derive(Resource, Default)]
pub struct PathResultQueue {
    results: Vec<PathResult>,
}

/// Configuration for async pathfinding budget
#[derive(Resource, Debug, Clone)]
pub struct AsyncPathfindingConfig {
    /// Maximum pathfinding requests to process per tick
    pub max_requests_per_tick: usize,
    /// Maximum A* iterations per request (prevents long paths from blocking)
    pub max_iterations_per_request: usize,
}

impl Default for AsyncPathfindingConfig {
    fn default() -> Self {
        Self {
            max_requests_per_tick: 8,
            max_iterations_per_request: 1000,
        }
    }
}

/// Plugin for async pathfinding system
pub struct AsyncPathfindingPlugin;

impl Plugin for AsyncPathfindingPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PathRequestQueue>()
            .init_resource::<PathResultQueue>()
            .init_resource::<AsyncPathfindingConfig>()
            .add_systems(
                FixedUpdate,
                process_pathfinding_requests.in_set(crate::game::sets::GameSet::Sim),
            );
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
    #[allow(dead_code)]
    pub fn pending_count(&self) -> usize {
        self.requests.len()
    }

    /// Get processing request count
    #[allow(dead_code)]
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
    pub fn drain(&mut self) -> std::vec::Drain<'_, PathResult> {
        self.results.drain(..)
    }
}

/// Process pathfinding requests with budget per tick
fn process_pathfinding_requests(
    time: Res<Time>,
    async_cfg: Res<AsyncPathfindingConfig>,
    cfg: Res<super::PathfindingConfig>,
    mut cache: ResMut<super::PathCache>,
    graph: Res<super::RoadGraph>,
    regions: Option<Res<super::RegionGraph>>,
    traffic: Option<Res<crate::game::traffic::TrafficOccupancy>>,
    grid: Res<crate::game::map::MapGrid>,
    intersections: Res<crate::game::intersections::IntersectionIndex>,
    mut request_queue: ResMut<PathRequestQueue>,
    mut result_queue: ResMut<PathResultQueue>,
) {
    // Budget: process up to N requests per tick to avoid stalls
    let max_requests = async_cfg.max_requests_per_tick;
    let max_iterations = async_cfg.max_iterations_per_request;
    let mut processed = 0;

    // Default traffic occupancy for when none is available
    let default_traffic = crate::game::traffic::TrafficOccupancy::default();

    while processed < max_requests {
        let Some(request) = request_queue.pop_next() else {
            break;
        };

        // Create pathfinding context for this request
        let mut ctx = super::PathfindingCtx {
            time_now_sec: time.elapsed_secs_f64(),
            cfg: &cfg,
            cache: &mut cache,
            graph: &graph,
            regions: regions.as_deref(),
            traffic: traffic.as_deref().unwrap_or(&default_traffic),
            grid: &grid,
            intersections: &intersections,
            max_iterations: Some(max_iterations),
        };

        // Process the pathfinding request
        let path = super::find_road_path_cached(&mut ctx, request.start, request.goal);

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
