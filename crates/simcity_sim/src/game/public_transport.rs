//! Public Transport System — buses drive real routes between stops as first-class
//! `Vehicle` traffic agents (Phase A). Passenger boarding is Phase C; player-placed
//! routes are Phase B. Buses are moved by the shared `move_vehicles`; this module only
//! spawns them, seeds a demo route, and ticks their stop/dwell state machine.

use bevy::prelude::*;

use crate::game::intersections::IntersectionIndex;
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::state::AppState;
use crate::game::traffic::{
    TrafficConfig, TrafficOccupancy, VEHICLE_VISUAL_LENGTH_TILES, VEHICLE_VISUAL_WIDTH_TILES,
    Vehicle, VehicleTrafficState, kmh_to_world_speed, route_direction_ok,
};
use crate::game::transport::{
    PathCache, PathPool, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    adjacent_road_towards, find_road_path_cached,
};

/// Seconds a bus dwells at each stop before advancing to the next.
pub const DWELL_SECS: f32 = 3.0;

/// Bus body color (yellow).
const BUS_COLOR: Color = Color::srgb(0.9, 0.7, 0.2);
/// Roof marker color for buses (dark, contrasts with any body).
const BUS_ROOF_COLOR: Color = Color::srgb(0.12, 0.12, 0.12);
/// Cruising speed cap for buses (km/h) — moderate, below fast cars.
const BUS_MAX_SPEED_KMH: f32 = 55.0;

/// Marker on the child roof-symbol sprite of a special vehicle (bus / service).
#[derive(Component)]
pub struct VehicleRoofMarker;

pub struct PublicTransportPlugin;

impl Plugin for PublicTransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BusRouteManager>().add_systems(
            FixedUpdate,
            // Chained: spawn produces buses that the tick advances; both touch `Bus`/`PathPool`.
            (spawn_buses, tick_buses)
                .chain()
                .in_set(crate::game::SimStep::PublicTransport)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// A bus stop location on a route.
#[derive(Component, Debug)]
pub struct BusStop {
    pub pos: TilePos,
    pub route_id: u32,
    pub stop_index: usize,
}

/// Bus vehicle component (rides on top of a `Vehicle`). No passenger accounting in Phase A.
#[derive(Component, Debug)]
pub struct Bus {
    pub route_id: u32,
    /// Index into the route's `stops` the bus is currently driving toward.
    pub target_stop_idx: usize,
    pub state: BusState,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BusState {
    Driving,
    Dwelling { timer: f32 },
}

/// An ordered stop sequence. Buses loop it: `stops[i] -> stops[i+1] -> ... -> stops[0]`.
#[derive(Debug, Clone)]
pub struct BusRoute {
    pub id: u32,
    pub stops: Vec<TilePos>,
}

/// All active bus routes.
#[derive(Resource, Default)]
pub struct BusRouteManager {
    pub routes: Vec<BusRoute>,
    pub next_route_id: u32,
}

impl BusRouteManager {
    pub fn create_route(&mut self, stops: Vec<TilePos>) -> u32 {
        let id = self.next_route_id;
        self.next_route_id = self.next_route_id.wrapping_add(1);
        self.routes.push(BusRoute { id, stops });
        id
    }

    pub fn get_route(&self, id: u32) -> Option<&BusRoute> {
        self.routes.iter().find(|r| r.id == id)
    }

    /// Clear all routes and rewind the id counter — called on map load/regeneration.
    pub fn reset(&mut self) {
        self.routes.clear();
        self.next_route_id = 0;
    }
}

/// World position of a tile center, matching the traffic renderer's `map_origin` convention.
fn tile_to_world(cfg: &MapConfig, pos: TilePos) -> Vec2 {
    let origin = Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    );
    origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
}

/// Car-shaped body sprite (same dimensions as regular vehicles). Shared by buses/service vehicles.
pub(crate) fn car_body_sprite(cfg: &MapConfig, body: Color) -> Sprite {
    Sprite {
        color: body,
        custom_size: Some(Vec2::new(
            cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES,
            cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES,
        )),
        ..default()
    }
}

/// Roof-symbol child sprite (small contrasting square that reads as "special vehicle").
pub(crate) fn roof_marker_sprite(cfg: &MapConfig, color: Color) -> Sprite {
    Sprite {
        color,
        custom_size: Some(Vec2::splat(cfg.tile_size * 0.35)),
        ..default()
    }
}

/// Spawn one bus per route as a real `Vehicle` on a road-A* route to its first stop.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn spawn_buses(
    mut commands: Commands,
    route_mgr: Res<BusRouteManager>,
    grid: Res<MapGrid>,
    cfg: Res<MapConfig>,
    traffic_cfg: Res<TrafficConfig>,
    traffic: Res<TrafficOccupancy>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    path_cfg: Res<PathfindingConfig>,
    intersections: Res<IntersectionIndex>,
    time: Res<Time>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    q_existing: Query<&Bus>,
) {
    for route in &route_mgr.routes {
        if route.stops.len() < 2 {
            continue;
        }
        if q_existing.iter().any(|b| b.route_id == route.id) {
            continue; // one bus per route (Phase A)
        }
        // Road tiles at stop 0 (toward stop 1) and stop 1 (toward stop 0).
        let Some(start) = adjacent_road_towards(&grid, route.stops[0], route.stops[1]) else {
            continue;
        };
        let Some(goal) = adjacent_road_towards(&grid, route.stops[1], route.stops[0]) else {
            continue;
        };

        let mut ctx = PathfindingCtx {
            time_now_sec: time.elapsed_secs_f64(),
            cfg: &path_cfg,
            cache: &mut path_cache,
            graph: &graph,
            regions: Some(&regions),
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };
        let route_tiles = find_road_path_cached(&mut ctx, start, goal);
        if route_tiles.is_empty() || !route_direction_ok(&route_tiles, &grid) {
            continue;
        }

        let world_pos = tile_to_world(&cfg, start);
        commands
            .spawn((
                car_body_sprite(&cfg, BUS_COLOR),
                Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
                Vehicle {
                    path_handle: path_pool.intern(route_tiles),
                    path_cursor: 0,
                    progress: 0.0,
                    tile_pos: start,
                    speed: 0.0,
                    max_speed: kmh_to_world_speed(&cfg, &traffic_cfg, BUS_MAX_SPEED_KMH),
                    speed_factor: 1.0,
                    max_accel: 20.0,
                    prev_world_pos: world_pos,
                    curr_world_pos: world_pos,
                    is_reversing: false,
                },
                VehicleTrafficState::FreeFlow,
                Bus {
                    route_id: route.id,
                    target_stop_idx: 1,
                    state: BusState::Driving,
                },
            ))
            .with_children(|parent| {
                parent.spawn((
                    roof_marker_sprite(&cfg, BUS_ROOF_COLOR),
                    Transform::from_xyz(0.0, 0.0, 1.0),
                    VehicleRoofMarker,
                ));
            });
    }
}

/// Advance each bus's dwell/stop state machine (filled in Task 4).
fn tick_buses(_q: Query<&mut Bus>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_manager_reset_clears_routes_and_id() {
        let mut mgr = BusRouteManager::default();
        let id0 = mgr.create_route(vec![TilePos { x: 1, y: 1 }, TilePos { x: 5, y: 1 }]);
        assert_eq!(id0, 0);
        assert_eq!(mgr.routes.len(), 1);
        assert_eq!(mgr.next_route_id, 1);

        mgr.reset();
        assert!(mgr.routes.is_empty(), "reset must clear routes");
        assert_eq!(mgr.next_route_id, 0, "reset must rewind the id counter");
    }
}
