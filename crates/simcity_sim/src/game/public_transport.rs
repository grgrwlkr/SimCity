//! Public Transport System - Bus routes and stops.
//!
//! Buses follow fixed routes between stops, picking up passengers.

use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::Vehicle;
use crate::game::transport::{PathHandle, PathPool};

pub struct PublicTransportPlugin;

impl Plugin for PublicTransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BusRouteManager>().add_systems(
            FixedUpdate,
            (spawn_buses, move_buses)
                .in_set(GameSet::Sim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Bus stop marker
#[derive(Component, Debug)]
pub struct BusStop {
    pub pos: TilePos,
    pub route_id: u32,
    pub stop_index: usize,
}

/// Bus component
#[derive(Component, Debug)]
pub struct Bus {
    pub route_id: u32,
    pub current_stop: usize,
    pub next_stop: usize,
    pub path_handle: PathHandle,
    pub path_cursor: usize,
    pub passengers: u16,
    pub capacity: u16,
    pub state: BusState,
}

/// Bus state machine
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BusState {
    MovingToStop,
    AtStop { timer: f32 },
    WaitingForPassengers { timer: f32 },
}

/// Bus route definition
#[derive(Debug, Clone)]
pub struct BusRoute {
    pub id: u32,
    pub stops: Vec<TilePos>,
    pub name: String,
}

/// Manager for all bus routes
#[derive(Resource, Default)]
pub struct BusRouteManager {
    pub routes: Vec<BusRoute>,
    pub next_route_id: u32,
}

impl BusRouteManager {
    /// Create a new bus route
    pub fn create_route(&mut self, stops: Vec<TilePos>, name: String) -> u32 {
        let id = self.next_route_id;
        self.next_route_id = self.next_route_id.wrapping_add(1);
        self.routes.push(BusRoute { id, stops, name });
        id
    }

    /// Get route by ID
    pub fn get_route(&self, id: u32) -> Option<&BusRoute> {
        self.routes.iter().find(|r| r.id == id)
    }
}

/// Spawn buses for each route
fn spawn_buses(
    mut commands: Commands,
    mut route_mgr: ResMut<BusRouteManager>,
    grid: Res<MapGrid>,
    mut path_pool: ResMut<PathPool>,
    q_existing: Query<&Bus>,
) {
    // Create default route if none exists
    if route_mgr.routes.is_empty() && grid.width > 10 {
        // Create a simple loop route
        let mut stops = Vec::new();
        let margin = 5i32;

        // Top edge
        for x in (margin..(grid.width - margin)).step_by(10) {
            stops.push(TilePos { x, y: margin });
        }
        // Right edge
        for y in (margin..(grid.height - margin)).step_by(10) {
            stops.push(TilePos {
                x: grid.width - margin,
                y,
            });
        }
        // Bottom edge
        for x in ((margin..(grid.width - margin)).rev()).step_by(10) {
            stops.push(TilePos {
                x,
                y: grid.height - margin,
            });
        }
        // Left edge
        for y in ((margin..(grid.height - margin)).rev()).step_by(10) {
            stops.push(TilePos { x: margin, y });
        }

        route_mgr.create_route(stops, "Route 1".to_string());
    }

    // Spawn one bus per route
    for route in &route_mgr.routes {
        let existing_buses = q_existing.iter().filter(|b| b.route_id == route.id).count();
        if existing_buses >= 1 {
            continue; // One bus per route for MVP
        }

        if route.stops.len() < 2 {
            continue;
        }

        // Find road tile near first stop
        let Some(start_pos) = find_road_near(&grid, route.stops[0]) else {
            continue;
        };
        let Some(goal_pos) = find_road_near(&grid, route.stops[1]) else {
            continue;
        };

        // Create path (simplified - would use full pathfinding in production)
        let mut path = vec![start_pos];
        path.push(goal_pos);

        let path_handle = path_pool.intern(path);

        let world_pos = tile_to_world(&grid, start_pos);

        commands.spawn((
            Sprite {
                color: Color::srgb(0.9, 0.7, 0.2), // Yellow bus
                custom_size: Some(Vec2::new(1.2, 0.7)),
                ..default()
            },
            Transform::from_xyz(world_pos.x, world_pos.y, 11.0),
            Bus {
                route_id: route.id,
                current_stop: 0,
                next_stop: 1,
                path_handle,
                path_cursor: 0,
                passengers: 0,
                capacity: 30,
                state: BusState::MovingToStop,
            },
            Vehicle {
                path_handle,
                path_cursor: 0,
                progress: 0.0,
                speed: 50.0,
                max_speed: 50.0,
                speed_factor: 1.0,
                max_accel: 15.0,
                ..default()
            },
        ));
    }
}

/// Move buses along their routes
fn move_buses(
    time: Res<Time>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut Bus, &mut Vehicle, &Transform)>,
    route_mgr: Res<BusRouteManager>,
    grid: Res<MapGrid>,
    mut path_pool: ResMut<PathPool>,
) {
    let delta = time.delta_secs();

    for (entity, mut bus, mut vehicle, _transform) in q.iter_mut() {
        match &mut bus.state {
            BusState::MovingToStop => {
                // Move towards next stop
                vehicle.progress += vehicle.speed * delta / 100.0; // Simplified movement

                if vehicle.progress >= 1.0 {
                    vehicle.progress = 0.0;
                    bus.state = BusState::AtStop { timer: 2.0 }; // Stop for 2 seconds

                    // Update stop indices
                    bus.current_stop = bus.next_stop;
                    bus.next_stop = (bus.next_stop + 1) % {
                        route_mgr
                            .get_route(bus.route_id)
                            .map(|r| r.stops.len())
                            .unwrap_or(1)
                    };

                    // Plan next segment
                    if let Some(route) = route_mgr.get_route(bus.route_id)
                        && let Some(current) = find_road_near(&grid, route.stops[bus.current_stop])
                        && let Some(next) = find_road_near(&grid, route.stops[bus.next_stop])
                    {
                        let path = vec![current, next];
                        bus.path_handle = path_pool.intern(path);
                        bus.path_cursor = 0;
                        vehicle.path_handle = bus.path_handle;
                        vehicle.path_cursor = 0;
                    }
                }
            }
            BusState::AtStop { timer } => {
                *timer -= delta;
                if *timer <= 0.0 {
                    bus.state = BusState::WaitingForPassengers { timer: 1.0 };
                }
            }
            BusState::WaitingForPassengers { timer } => {
                *timer -= delta;
                if *timer <= 0.0 {
                    // Pick up passengers (simplified)
                    bus.passengers = (bus.passengers + 5).min(bus.capacity);
                    bus.state = BusState::MovingToStop;
                }
            }
        }

        // Update vehicle position
        if let Some(path) = path_pool.get(vehicle.path_handle)
            && let Some(&current_tile) = path.get(vehicle.path_cursor)
        {
            let world_pos = tile_to_world(&grid, current_tile);
            let mut tf = commands.entity(entity);
            tf.insert(Transform::from_xyz(world_pos.x, world_pos.y, 11.0));
        }
    }
}

/// Find a road tile near the given position
fn find_road_near(grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
    // Check the position itself first
    if let Some(cell) = grid.get(pos)
        && cell.road.is_some()
    {
        return Some(pos);
    }

    // Check neighbors
    for dx in -2..=2 {
        for dy in -2..=2 {
            let check = TilePos {
                x: pos.x + dx,
                y: pos.y + dy,
            };
            if let Some(cell) = grid.get(check)
                && cell.road.is_some()
            {
                return Some(check);
            }
        }
    }

    None
}

/// Convert tile position to world position
fn tile_to_world(grid: &MapGrid, pos: TilePos) -> Vec2 {
    let tile_size = 1.0; // Simplified
    let origin_x = -((grid.width - 1) as f32) * tile_size * 0.5;
    let origin_y = -((grid.height - 1) as f32) * tile_size * 0.5;
    Vec2::new(
        origin_x + pos.x as f32 * tile_size,
        origin_y + pos.y as f32 * tile_size,
    )
}
