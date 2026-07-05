use super::*;
use crate::game::transport::{PathPool, PathfindingConfig};

mod planning;
pub(super) use planning::plan_lane_changes;

/// Prevents frequent lane-change oscillations.
#[derive(Component, Debug, Clone, Copy)]
pub(super) struct LaneChangeCooldown {
    remaining_secs: f32,
}

/// Marker state to prefer staying left briefly while overtaking, then returning right.
#[derive(Component, Debug, Clone, Copy)]
pub(super) struct Overtaking {
    remaining_secs: f32,
}

pub(super) fn tick_lane_change_cooldowns(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut LaneChangeCooldown)>,
) {
    let dt = time.delta_secs();
    for (e, mut cd) in q.iter_mut() {
        cd.remaining_secs -= dt;
        if cd.remaining_secs <= 0.0 {
            commands.entity(e).remove::<LaneChangeCooldown>();
        }
    }
}

pub(super) fn tick_overtaking(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut Overtaking)>,
) {
    let dt = time.delta_secs();
    for (e, mut ov) in q.iter_mut() {
        ov.remaining_secs -= dt;
        if ov.remaining_secs <= 0.0 {
            commands.entity(e).remove::<Overtaking>();
        }
    }
}

fn route_has_near_intersection_n(route: &[TilePos], grid: &MapGrid, lookahead: usize) -> bool {
    for t in route.iter().skip(1).take(lookahead) {
        if let Some(c) = grid.get(*t)
            && c.road.is_some()
            && c.road.dir == RoadDir::None
        {
            return true;
        }
    }
    false
}

fn route_has_near_intersection(route: &[TilePos], grid: &MapGrid) -> bool {
    route_has_near_intersection_n(route, grid, LANE_CHANGE_INTERSECTION_LOOKAHEAD)
}

// (moved to `lane_change/planning.rs`)

pub(super) fn build_traffic_spatial_index_pre_lane_changes(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    path_pool: Res<PathPool>,
    q_vehicles: Query<(Entity, &Vehicle), Without<Parked>>,
    mut index: ResMut<TrafficSpatialIndex>,
) {
    index.rebuild(&cfg, &grid, &path_pool, &q_vehicles);
}

pub(super) fn build_traffic_spatial_index(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    path_pool: Res<PathPool>,
    q_vehicles: Query<(Entity, &Vehicle), Without<Parked>>,
    mut index: ResMut<TrafficSpatialIndex>,
) {
    index.rebuild(&cfg, &grid, &path_pool, &q_vehicles);
}
