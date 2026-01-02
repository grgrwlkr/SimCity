use super::super::*;
use std::collections::{HashMap, HashSet};

pub fn update_vehicle_traffic_state(
    _time: Res<Time<Fixed>>,
    _traffic_cfg: Res<TrafficConfig>,
    _cfg: Res<MapConfig>,
    _grid: Res<MapGrid>,
    _intersections: Res<IntersectionIndex>,
    _reservations: Res<IntersectionReservations>,
    _path_pool: Res<super::super::super::transport::PathPool>,
    _commands: Commands,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    q_priorities: Query<&crate::game::intersections::IntersectionPriorityMarker>,
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    mut light_by_key: Local<
        HashMap<
            crate::game::intersections::IntersectionKey,
            crate::game::intersections::TrafficLight,
        >,
    >,
    mut stop_sign_tiles: Local<HashSet<TilePos>>,
) {
    // Build light index once per tick (O(lights)) instead of scanning all lights per vehicle.
    light_by_key.clear();
    for l in q_lights.iter() {
        light_by_key.insert(l.intersection_key, l.clone());
    }

    // We only need to distinguish StopSign-driven stops from light-driven stops.
    // If a light gets removed while vehicles are stopped at it, we must release them.
    stop_sign_tiles.clear();
    for m in q_priorities.iter() {
        if m.priority == IntersectionPriority::StopSign {
            stop_sign_tiles.insert(m.pos);
        }
    }

    // TODO: re-enable intersection logic
    for (_entity, _vehicle, _state) in q_vehicles.iter_mut() {
        // Temporarily disabled - needs route/path_pool fixes
    }
}

pub fn compute_exit_direction(
    route: &[TilePos],
    grid: &MapGrid,
    first_intersection_tile: TilePos,
) -> RoadDir {
    let Some(start_i) = route.iter().position(|t| *t == first_intersection_tile) else {
        return RoadDir::None;
    };
    let mut i = start_i;
    while i < route.len() && is_intersection_tile(grid, route[i]) {
        i += 1;
    }
    if i == 0 || i >= route.len() {
        return RoadDir::None;
    }
    let last_intersection = route[i - 1];
    let exit_tile = route[i];
    dir_between_adjacent(last_intersection, exit_tile)
}

pub fn check_intersection_priority(
    _grid: Res<MapGrid>,
    _cfg: Res<MapConfig>,
    _intersections: Res<IntersectionIndex>,
    _q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    _q_intersections: Query<&crate::game::intersections::IntersectionPriorityMarker>,
    _priority_by_tile: Local<
        std::collections::HashMap<TilePos, crate::game::intersections::IntersectionPriority>,
    >,
) {
    // TODO: re-implement intersection priority logic
}
