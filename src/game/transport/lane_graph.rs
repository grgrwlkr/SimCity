use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::{RoadDir, RoadKind};

use super::GraphVersion;

/// Unique identifier for a lane segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LaneId(pub u32);

impl LaneId {
    pub const INVALID: LaneId = LaneId(u32::MAX);
}

/// A lane segment: a 1D stretch of road between intersections.
#[derive(Debug, Clone)]
pub struct Lane {
    /// Total length in world units (meters).
    pub length_m: f32,
    /// Start position and direction.
    pub start_pos: TilePos,
    pub direction: RoadDir,
    /// Connected lanes at the end (for routing).
    #[allow(dead_code)] // Reserved for future routing features
    pub next_lanes: Vec<LaneId>,
    /// Reverse lane (if bidirectional).
    #[allow(dead_code)] // Reserved for future bidirectional lane support
    pub reverse_lane: Option<LaneId>,
    /// Road kind (highway, normal, etc.).
    #[allow(dead_code)] // Reserved for future road type features
    pub kind: RoadKind,
    /// Speed limit (m/s).
    #[allow(dead_code)] // Reserved for future speed limit features
    pub speed_limit: f32,
}

impl Default for Lane {
    fn default() -> Self {
        Self {
            length_m: 0.0,
            start_pos: TilePos { x: 0, y: 0 },
            direction: RoadDir::North,
            next_lanes: Vec::new(),
            reverse_lane: None,
            kind: RoadKind::TwoLane,
            speed_limit: 13.89, // 50 km/h
        }
    }
}

/// Lane graph: lanes as 1D segments between intersections.
#[derive(Resource, Debug, Default)]
pub struct LaneGraph {
    pub version: u64,
    pub lanes: Vec<Lane>,
    /// Map tile positions to lane segments (for lookup).
    pub tile_to_lane: HashMap<TilePos, Vec<(LaneId, f32)>>, // (lane_id, s_offset)
    /// Lane connections for pathfinding.
    pub lane_connections: HashMap<LaneId, Vec<LaneId>>,
}

impl LaneGraph {
    pub fn is_built_for(&self, version: u64) -> bool {
        self.version == version && !self.lanes.is_empty()
    }

    /// Get lane by ID.
    pub fn get_lane(&self, id: LaneId) -> Option<&Lane> {
        self.lanes.get(id.0 as usize)
    }

    /// Get lane by ID (mutable).
    #[allow(dead_code)] // Public API method
    pub fn get_lane_mut(&mut self, id: LaneId) -> Option<&mut Lane> {
        self.lanes.get_mut(id.0 as usize)
    }

    /// Find lane at position.
    pub fn lane_at_pos(&self, pos: TilePos) -> Option<(LaneId, f32)> {
        self.tile_to_lane
            .get(&pos)
            .and_then(|lanes| lanes.first().copied())
    }

    /// Get all lanes connected to this one.
    #[allow(dead_code)] // Public API method
    pub fn connected_lanes(&self, id: LaneId) -> &[LaneId] {
        self.lane_connections
            .get(&id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Convert tile position + progress to lane + s coordinate.
    #[allow(dead_code)] // Public API method
    pub fn tile_progress_to_lane_s(
        &self,
        tile_pos: TilePos,
        progress: f32,
    ) -> Option<(LaneId, f32)> {
        self.tile_to_lane.get(&tile_pos).and_then(|lanes| {
            lanes
                .first()
                .map(|(lane_id, offset)| (*lane_id, offset + progress))
        })
    }

    /// Convert lane + s to approximate tile position.
    #[allow(dead_code)] // Used by update_vehicle_positions_for_interpolation
    pub fn lane_s_to_tile_pos(&self, lane_id: LaneId, s: f32) -> Option<TilePos> {
        let lane = self.get_lane(lane_id)?;
        let tile_offset = (s / 1.0).floor() as i32; // 1 tile = 1 unit

        match lane.direction {
            RoadDir::North => Some(TilePos {
                x: lane.start_pos.x,
                y: lane.start_pos.y + tile_offset,
            }),
            RoadDir::South => Some(TilePos {
                x: lane.start_pos.x,
                y: lane.start_pos.y - tile_offset,
            }),
            RoadDir::East => Some(TilePos {
                x: lane.start_pos.x + tile_offset,
                y: lane.start_pos.y,
            }),
            RoadDir::West => Some(TilePos {
                x: lane.start_pos.x - tile_offset,
                y: lane.start_pos.y,
            }),
            RoadDir::None => Some(lane.start_pos),
        }
    }
}

/// Build lane graph from tile-based road grid.
pub fn build_lane_graph(grid: &MapGrid, version: u64) -> LaneGraph {
    let mut graph = LaneGraph {
        version,
        lanes: Vec::new(),
        tile_to_lane: HashMap::new(),
        lane_connections: HashMap::new(),
    };

    // Find all road segments
    let mut visited = vec![false; grid.len()];
    let mut lane_id_counter = 0u32;

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else { continue };
            if !cell.road.is_some() || visited[grid.idx(pos).unwrap()] {
                continue;
            }

            // Start tracing a lane from this position
            if let Some(lane_id) =
                trace_lane_from_pos(grid, pos, &mut visited, &mut graph, &mut lane_id_counter)
            {
                // Connect this lane to others at intersections
                connect_lane_at_end(grid, &mut graph, lane_id);
            }
        }
    }

    graph
}

/// Trace a lane segment starting from a position.
fn trace_lane_from_pos(
    grid: &MapGrid,
    start_pos: TilePos,
    visited: &mut [bool],
    graph: &mut LaneGraph,
    lane_id_counter: &mut u32,
) -> Option<LaneId> {
    let start_idx = grid.idx(start_pos)?;
    if visited[start_idx] {
        return None;
    }

    let start_cell = grid.get(start_pos)?;
    let start_dir = start_cell.road.dir;
    if start_dir == RoadDir::None {
        return None; // Intersection tile
    }

    // Create new lane
    let lane_id = LaneId(*lane_id_counter);
    *lane_id_counter += 1;

    let mut lane = Lane {
        start_pos,
        direction: start_dir,
        kind: start_cell.road.kind,
        speed_limit: match start_cell.road.kind {
            RoadKind::SixLane => 27.78,  // highway speed
            RoadKind::FourLane => 16.67, // city road speed
            RoadKind::TwoLane => 13.89,  // local street speed
            RoadKind::None => 8.33,      // fallback
        },
        ..Default::default()
    };

    // Trace along the lane
    let mut current_pos = start_pos;
    let mut length_tiles = 0;

    loop {
        let idx = grid.idx(current_pos)?;
        visited[idx] = true;

        // Record this tile belongs to this lane
        graph
            .tile_to_lane
            .entry(current_pos)
            .or_default()
            .push((lane_id, length_tiles as f32));

        length_tiles += 1;

        // Move to next tile in direction
        let next_pos = match start_dir {
            RoadDir::North => TilePos {
                x: current_pos.x,
                y: current_pos.y + 1,
            },
            RoadDir::South => TilePos {
                x: current_pos.x,
                y: current_pos.y - 1,
            },
            RoadDir::East => TilePos {
                x: current_pos.x + 1,
                y: current_pos.y,
            },
            RoadDir::West => TilePos {
                x: current_pos.x - 1,
                y: current_pos.y,
            },
            RoadDir::None => break,
        };

        let Some(next_cell) = grid.get(next_pos) else {
            break;
        };
        if !next_cell.road.is_some() || next_cell.road.dir != start_dir {
            break; // End of lane segment
        }

        current_pos = next_pos;
    }

    lane.length_m = length_tiles as f32; // 1 tile = 1 meter

    // Resize lanes vector if needed
    let id_idx = lane_id.0 as usize;
    if graph.lanes.len() <= id_idx {
        graph.lanes.resize(id_idx + 1, Lane::default());
    }
    graph.lanes[id_idx] = lane;

    Some(lane_id)
}

/// Connect lane to other lanes at its endpoint.
fn connect_lane_at_end(_grid: &MapGrid, graph: &mut LaneGraph, lane_id: LaneId) {
    let lane = graph.get_lane(lane_id).unwrap();
    let end_pos = match lane.direction {
        RoadDir::North => TilePos {
            x: lane.start_pos.x,
            y: lane.start_pos.y + (lane.length_m as i32),
        },
        RoadDir::South => TilePos {
            x: lane.start_pos.x,
            y: lane.start_pos.y - (lane.length_m as i32),
        },
        RoadDir::East => TilePos {
            x: lane.start_pos.x + (lane.length_m as i32),
            y: lane.start_pos.y,
        },
        RoadDir::West => TilePos {
            x: lane.start_pos.x - (lane.length_m as i32),
            y: lane.start_pos.y,
        },
        RoadDir::None => return,
    };

    // Find lanes starting at the endpoint (intersection connections)
    let mut connections = Vec::new();

    // Check adjacent tiles for lane starts
    let adjacent_positions = [
        TilePos {
            x: end_pos.x - 1,
            y: end_pos.y,
        },
        TilePos {
            x: end_pos.x + 1,
            y: end_pos.y,
        },
        TilePos {
            x: end_pos.x,
            y: end_pos.y - 1,
        },
        TilePos {
            x: end_pos.x,
            y: end_pos.y + 1,
        },
    ];

    for adj_pos in adjacent_positions {
        if let Some((other_lane_id, _)) = graph.lane_at_pos(adj_pos)
            && other_lane_id != lane_id
        {
            connections.push(other_lane_id);
        }
    }

    graph.lane_connections.insert(lane_id, connections);
}

/// System to rebuild lane graph when roads change.
pub fn rebuild_lane_graph(
    grid: Res<MapGrid>,
    version: Res<GraphVersion>,
    mut lane_graph: ResMut<LaneGraph>,
) {
    if !lane_graph.is_built_for(version.0) {
        *lane_graph = build_lane_graph(&grid, version.0);
    }
}
