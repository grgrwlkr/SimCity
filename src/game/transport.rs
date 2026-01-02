//! Transport / routing layer (stability + performance guardrails).
//!
//! Hole B from `docs/master-plan.md`:
//! - Road graph as separate layer + GraphVersion incremented on road edits.
//! - Path cache keyed by (start, end, graph_version) with simple TTL + LRU-ish eviction.

use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::sets::GameSet;
use crate::game::state::AppState;

mod version;
pub use version::GraphVersion;

mod turn_lanes;
use turn_lanes::{TurnLaneAutogenState, autogen_turn_lanes};

mod pathfinding;
pub use pathfinding::{PathCache, PathfindingConfig, PathfindingCtx, find_road_path_cached};

mod path_pool;
pub use path_pool::{PathHandle, PathPool, PathPoolStats};

mod road_graph;
pub use road_graph::RoadGraph;
use road_graph::rebuild_road_graph;

mod region_graph;
pub use region_graph::RegionGraph;
use region_graph::rebuild_region_graph;

pub struct TransportPlugin;

impl Plugin for TransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GraphVersion>()
            .init_resource::<TurnLaneAutogenState>()
            .init_resource::<RoadGraph>()
            .init_resource::<RegionGraph>()
            .init_resource::<PathfindingConfig>()
            .init_resource::<PathCache>()
            .init_resource::<PathPool>()
            .add_systems(OnEnter(AppState::MainMenu), reset_transport)
            .add_systems(
                Update,
                autogen_turn_lanes
                    .in_set(GameSet::GraphUpdate)
                    .before(rebuild_road_graph)
                    .run_if(in_game_or_paused),
            )
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
// RoadGraph/RegionGraph live in `transport/road_graph.rs` and `transport/region_graph.rs`.

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

#[cfg(test)]
pub(crate) fn rebuild_road_graph_inner(grid: &MapGrid, gv: &GraphVersion, graph: &mut RoadGraph) {
    road_graph::rebuild_road_graph_inner(grid, gv, graph);
}

// Rebuild systems live in `transport/road_graph.rs` and `transport/region_graph.rs`.

#[cfg(test)]
mod tests;
