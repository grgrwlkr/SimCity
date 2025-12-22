//! M3: Traffic simulation – vehicles moving along roads via A* pathfinding.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::commands::GameCommand;
use crate::game::ids::CitizenId;
use crate::game::intersections::{IntersectionIndex, IntersectionPriority, TrafficLight};
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::public_transport::{
    BusVehicle, PendingTransitTrips, PendingTrip, PublicTransportConfig, PublicTransportIndex,
};
use crate::game::roads::RoadDir;
use crate::game::services::ServiceVehicle;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph, find_road_path_cached,
};
use crate::game::trips::{TripFinished, TripRequested};
use crate::game::ui_state::{OverlayMode, UiState};
use bevy::window::PrimaryWindow;

/// Vehicle entity – stores route and visual offset.
#[derive(Component)]
pub struct Vehicle {
    /// A* route as list of tile positions (from current towards goal).
    pub route: Vec<TilePos>,
    /// 0 = at start, 1 = at route[0]; interpolated smoothly.
    pub progress: f32,
    /// World units per second.
    pub speed: f32,
    /// Maximum speed for this vehicle.
    pub max_speed: f32,
    /// Maximum acceleration (world units per second squared).
    pub max_accel: f32,
}

impl Default for Vehicle {
    fn default() -> Self {
        Self {
            route: Vec::new(),
            progress: 0.0,
            speed: 0.0,
            max_speed: 60.0, // Default speed
            max_accel: 20.0, // Default acceleration
        }
    }
}

/// State of vehicle relative to traffic lights
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub enum VehicleTrafficState {
    /// Moving freely (no traffic light ahead)
    FreeFlow,
    /// Approaching a traffic light
    Approaching {
        light_pos: TilePos,
        distance_to_stop: f32,
    },
    /// Braking before stop line
    Braking {
        light_pos: TilePos,
        target_speed: f32,
    },
    /// Stopped in queue
    Stopped {
        light_pos: TilePos,
        queue_position: u8,
    },
    /// Waiting for green light
    WaitingForGreen { light_pos: TilePos },
    /// Accelerating after green
    Accelerating,
    /// Crossing intersection
    CrossingIntersection,
}

/// Braking parameters for vehicles
#[derive(Resource)]
pub struct BrakingParams {
    /// Comfortable deceleration (world units per second squared)
    pub comfortable_decel: f32,
    /// Maximum deceleration (emergency)
    pub max_decel: f32,
    /// Minimum distance to start braking
    pub min_braking_distance: f32,
}

impl Default for BrakingParams {
    fn default() -> Self {
        Self {
            comfortable_decel: 30.0,
            max_decel: 80.0,
            min_braking_distance: 0.5,
        }
    }
}

/// Distance to detect traffic lights ahead (in tiles)
const TRAFFIC_LIGHT_DETECTION_DISTANCE: f32 = 8.0;

/// Safe distance between vehicles in queue (in tiles)
const QUEUE_GAP: f32 = 0.3;

/// Stop line offset relative to intersection (0.0 = tile boundary)
const STOP_LINE_OFFSET: f32 = 0.15;

#[derive(Component, Debug, Copy, Clone)]
struct TripPassenger {
    citizen: CitizenId,
    purpose: crate::game::trips::TripPurpose,
}

/// Traffic read model (derived data; not a source of truth).
///
/// **Semantics (punt C):**
/// - `per_tick_vehicles[idx]`: number of vehicles currently occupying the road tile at the end of
///   the latest fixed sim tick (not "cumulative visits").
/// - `ema_heat[idx]`: exponentially-smoothed view of `per_tick_vehicles` for visualization.
///   This is what the Traffic overlay uses.
#[derive(Resource, Default)]
pub struct TrafficOccupancy {
    pub per_tick_vehicles: Vec<u16>,
    pub ema_heat: Vec<f32>,
}

/// Aggregated traffic metrics for UI/economy.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct TrafficIndex {
    pub road_tiles: u32,
    pub vehicles_on_roads: u32,
    /// Average congestion in [0..1] across road tiles.
    pub avg_congestion: f32,
    /// Max congestion in [0..1] across road tiles.
    pub max_congestion: f32,
}

/// Marker for road tile overlays that show traffic heat.
#[derive(Component)]
struct TrafficOverlayTile;

pub struct TrafficPlugin;

impl Plugin for TrafficPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TrafficOccupancy>()
            .init_resource::<TrafficIndex>()
            .init_resource::<TrafficConfig>()
            .init_resource::<BrakingParams>()
            .add_systems(
                OnEnter(AppState::MainMenu),
                (cleanup_traffic_entities, reset_traffic_aggregates),
            )
            // Commands (should respond even when paused)
            .add_systems(
                Update,
                clear_vehicles
                    .in_set(GameSet::CommandApply)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            )
            .add_systems(
                Update,
                spawn_debug_vehicles
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            )
            // Simulation
            .add_systems(
                FixedUpdate,
                (
                    update_vehicle_traffic_state,
                    update_traffic_queues.after(update_vehicle_traffic_state),
                    check_intersection_priority.after(update_traffic_queues),
                    spawn_trip_vehicles,
                    move_vehicles.after(check_intersection_priority),
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                FixedUpdate,
                update_traffic_occupancy
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Rendering
            .add_systems(
                Update,
                (render_traffic_overlay, cull_vehicle_lod).in_set(GameSet::RenderSync),
            );
    }
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct TrafficConfig {
    /// Hard cap on active vehicles (debug + trip-driven).
    max_active_vehicles: usize,
    /// Guardrail: max number of route plans performed per tick.
    max_route_plans_per_tick: usize,
    /// EMA decay for heatmap in [0..1). Higher = slower to change.
    heat_ema_decay: f32,
    /// If true, traffic drives on the right (US/Russia). If false, drives on the left (UK/Japan).
    #[serde(default = "default_drive_on_right")]
    pub drive_on_right: bool,
}

fn default_drive_on_right() -> bool {
    true
}

impl Default for TrafficConfig {
    fn default() -> Self {
        Self {
            max_active_vehicles: 1500,
            max_route_plans_per_tick: 64,
            heat_ema_decay: 0.92,
            drive_on_right: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

fn cleanup_traffic_entities(
    mut commands: Commands,
    q_vehicles: Query<Entity, With<Vehicle>>,
    q_overlay: Query<Entity, With<TrafficOverlayTile>>,
) {
    for e in q_vehicles.iter() {
        commands.entity(e).despawn();
    }
    for e in q_overlay.iter() {
        commands.entity(e).despawn();
    }
}

fn reset_traffic_aggregates(mut occ: ResMut<TrafficOccupancy>, mut idx: ResMut<TrafficIndex>) {
    occ.per_tick_vehicles.clear();
    occ.ema_heat.clear();
    *idx = TrafficIndex::default();
}

/// Spawn a batch of debug vehicles when GameCommand::SpawnDebugVehicles is received.
fn spawn_debug_vehicles(
    mut reader: bevy::ecs::message::MessageReader<GameCommand>,
    mut p: SpawnDebugVehiclesParams,
) {
    for msg in reader.read() {
        if let GameCommand::SpawnDebugVehicles { count } = msg {
            let roads = collect_road_tiles(&p.grid);
            if roads.len() < 2 {
                continue;
            }

            let mut rng = rand::rng();

            let mut spawned = 0u32;
            let mut total = p.q_vehicles.iter().count();

            for _ in 0..*count {
                if total >= p.traffic_cfg.max_active_vehicles {
                    break;
                }
                // Pick random start/goal from road tiles.
                let start_i = rng.random_range(0..roads.len());
                let mut goal_i = rng.random_range(0..roads.len());
                if goal_i == start_i {
                    goal_i = (goal_i + 1) % roads.len();
                }
                let start = roads[start_i];
                let goal = roads[goal_i];

                let mut ctx = PathfindingCtx {
                    time_now_sec: p.time.elapsed_secs_f64(),
                    cfg: &p.path_cfg,
                    cache: &mut p.path_cache,
                    graph: &p.graph,
                    regions: Some(&p.regions),
                    traffic: &p.traffic,
                    grid: &p.grid,
                    intersections: &p.intersections,
                };

                let route = find_road_path_cached(&mut ctx, start, goal);
                // No fallback to astar_path - vehicles must follow lane rules.
                if route.is_empty() {
                    // Debug: log when no valid path is found
                    // println!("[traffic] No valid path from {:?} to {:?}", start, goal);
                    continue;
                }

                let world_pos = tile_to_world(&p.cfg, start);

                let speed = 60.0 + rng.random_range(0.0..40.0);
                p.commands.spawn((
                    Sprite {
                        color: Color::linear_rgb(1.0, 0.8, 0.1),
                        custom_size: Some(Vec2::splat(p.cfg.tile_size * 0.6)),
                        ..default()
                    },
                    Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
                    Vehicle {
                        route,
                        progress: 0.0,
                        speed,
                        max_speed: speed,
                        max_accel: 20.0,
                    },
                    VehicleTrafficState::FreeFlow,
                ));
                spawned += 1;
                total += 1;
            }
            if spawned > 0 {
                debug!("Spawned {spawned} debug vehicles");
            }
        }
    }
}

#[derive(SystemParam)]
struct SpawnDebugVehiclesParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    time: Res<'w, Time>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, TrafficOccupancy>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    intersections: Res<'w, IntersectionIndex>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    traffic_cfg: Res<'w, TrafficConfig>,
}

fn spawn_trip_vehicles(
    mut reader: bevy::ecs::message::MessageReader<TripRequested>,
    mut p: SpawnTripVehiclesParams,
) {
    let mut planned = 0usize;
    let mut total = p.q_vehicles.iter().count();
    for msg in reader.read() {
        if planned >= p.traffic_cfg.max_route_plans_per_tick {
            break;
        }
        if total >= p.traffic_cfg.max_active_vehicles {
            break;
        }
        let Some(start) = adjacent_road_towards(&p.grid, msg.from, msg.to) else {
            continue;
        };
        let Some(goal) = adjacent_road_towards(&p.grid, msg.to, msg.from) else {
            continue;
        };
        let mut ctx = PathfindingCtx {
            time_now_sec: p.time.elapsed_secs_f64(),
            cfg: &p.path_cfg,
            cache: &mut p.path_cache,
            graph: &p.graph,
            regions: Some(&p.regions),
            traffic: &p.traffic,
            grid: &p.grid,
            intersections: &p.intersections,
        };

        let route = find_road_path_cached(&mut ctx, start, goal);
        // No fallback to astar_path - vehicles must follow lane rules.
        if route.is_empty() {
            continue;
        }

        // Public transport (MVP): if both endpoints are bus stops, optionally satisfy the trip
        // without spawning an individual car.
        if let (Some(pt), Some(pt_cfg), Some(pending)) =
            (p.pt.as_deref(), p.pt_cfg.as_deref(), p.pt_pending.as_mut())
            && pt.stops.contains(&start)
            && pt.stops.contains(&goal)
        {
            let mut rng = rand::rng();
            if rng.random_range(0.0..1.0) <= pt_cfg.adoption_rate.clamp(0.0, 1.0) {
                let dist_world = (route.len() as f32) * p.cfg.tile_size;
                let travel_secs =
                    (dist_world / pt_cfg.bus_speed.max(1.0)) + pt_cfg.wait_secs.max(0.0);
                pending.trips.push(PendingTrip {
                    citizen: msg.citizen,
                    purpose: msg.purpose,
                    remaining_secs: travel_secs,
                });
                planned += 1;
                continue;
            }
        }

        let world_pos = tile_to_world(&p.cfg, start);
        let max_speed = 70.0;
        p.commands.spawn((
            Sprite {
                color: Color::linear_rgb(0.95, 0.95, 0.95),
                custom_size: Some(Vec2::splat(p.cfg.tile_size * 0.55)),
                ..default()
            },
            Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
            Vehicle {
                route,
                progress: 0.0,
                speed: max_speed,
                max_speed,
                max_accel: 20.0,
            },
            VehicleTrafficState::FreeFlow,
            TripPassenger {
                citizen: msg.citizen,
                purpose: msg.purpose,
            },
        ));
        planned += 1;
        total += 1;
    }
}

#[derive(SystemParam)]
struct SpawnTripVehiclesParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    time: Res<'w, Time<bevy::time::Fixed>>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, TrafficOccupancy>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    intersections: Res<'w, IntersectionIndex>,
    pt_cfg: Option<Res<'w, PublicTransportConfig>>,
    pt: Option<Res<'w, PublicTransportIndex>>,
    pt_pending: Option<ResMut<'w, PendingTransitTrips>>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    traffic_cfg: Res<'w, TrafficConfig>,
}

/// Despawn all vehicles when GameCommand::ClearVehicles is received.
fn clear_vehicles(
    mut reader: bevy::ecs::message::MessageReader<GameCommand>,
    mut commands: Commands,
    q_vehicles: Query<Entity, With<Vehicle>>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
) {
    for msg in reader.read() {
        if matches!(
            msg,
            GameCommand::ClearVehicles | GameCommand::GenerateMap { .. }
        ) {
            for entity in q_vehicles.iter() {
                commands.entity(entity).despawn();
            }
            // C) Traffic: reset derived aggregates when clearing vehicles / regenerating map.
            occ.per_tick_vehicles.clear();
            occ.ema_heat.clear();
            *idx = TrafficIndex::default();
        }
    }
}

/// Move vehicles along their routes.
#[allow(clippy::type_complexity)]
fn move_vehicles(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    braking_params: Res<BrakingParams>,
    mut commands: Commands,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut q: Query<(
        Entity,
        &mut Vehicle,
        &mut Transform,
        &VehicleTrafficState,
        Option<&TripPassenger>,
        Option<&ServiceVehicle>,
        Option<&BusVehicle>,
    )>,
) {
    let dt = time.delta_secs();

    for (entity, mut v, mut tf, state, passenger, service_vehicle, bus_vehicle) in q.iter_mut() {
        if v.route.is_empty() {
            // Arrived – despawn trip vehicles, keep service vehicles (idle).
            if service_vehicle.is_none() && bus_vehicle.is_none() {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                commands.entity(entity).despawn();
            }
            continue;
        }

        // Compute acceleration based on traffic state
        let accel = compute_acceleration(&v, state, &braking_params, dt);

        // Update speed
        v.speed = (v.speed + accel * dt).clamp(0.0, v.max_speed);

        // Check if movement is blocked
        let can_move = match state {
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. } => {
                false
            }
            _ => true,
        };

        if !can_move {
            continue; // Don't move
        }

        // Distance to advance this frame.
        let dist = v.speed * dt;
        v.progress += dist / cfg.tile_size;

        while v.progress >= 1.0 && !v.route.is_empty() {
            v.progress -= 1.0;
            v.route.remove(0);
        }

        if v.route.is_empty() {
            if service_vehicle.is_none() && bus_vehicle.is_none() {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                commands.entity(entity).despawn();
            }
            continue;
        }

        // Lerp between current tile and next.
        let curr = v.route[0];
        let next = if v.route.len() > 1 {
            v.route[1]
        } else {
            v.route[0]
        };

        let curr_world = tile_to_world(&cfg, curr);
        let next_world = tile_to_world(&cfg, next);
        let lerped = curr_world.lerp(next_world, v.progress.clamp(0.0, 1.0));
        tf.translation.x = lerped.x;
        tf.translation.y = lerped.y;
    }
}

/// Update vehicle traffic state relative to traffic lights
fn update_vehicle_traffic_state(
    _time: Res<Time<Fixed>>,
    _cfg: Res<MapConfig>,
    _grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    mut q_vehicles: Query<(&Vehicle, &mut VehicleTrafficState)>,
) {
    for (vehicle, mut state) in q_vehicles.iter_mut() {
        // Find nearest traffic light on route
        let light_ahead = find_traffic_light_ahead(
            &vehicle.route,
            vehicle.progress,
            TRAFFIC_LIGHT_DETECTION_DISTANCE,
            &intersections,
        );

        match (&*state, light_ahead) {
            // No traffic light ahead
            (_, None) => {
                *state = VehicleTrafficState::FreeFlow;
            }
            // Traffic light detected - start approaching
            (VehicleTrafficState::FreeFlow, Some((light_pos, distance))) => {
                *state = VehicleTrafficState::Approaching {
                    light_pos,
                    distance_to_stop: distance,
                };
            }
            // Approaching - check if need to brake
            (
                VehicleTrafficState::Approaching {
                    light_pos,
                    distance_to_stop,
                },
                Some((pos, distance)),
            ) if pos == *light_pos => {
                // Get light state
                if find_light_at(&q_lights, *light_pos) {
                    if let Some(light) = q_lights.iter().find(|l| l.pos == *light_pos) {
                        let entry_dir = compute_entry_direction(&vehicle.route, *light_pos);

                        if !light.is_green(entry_dir) {
                            // Red/yellow - start braking
                            *state = VehicleTrafficState::Braking {
                                light_pos: *light_pos,
                                target_speed: 0.0,
                            };
                        } else {
                            // Green - can proceed
                            *state = VehicleTrafficState::CrossingIntersection;
                        }
                    }
                }
            }
            // Braking - check if stopped
            (VehicleTrafficState::Braking { light_pos, .. }, Some((pos, distance)))
                if pos == *light_pos && distance <= STOP_LINE_OFFSET =>
            {
                *state = VehicleTrafficState::Stopped {
                    light_pos: *light_pos,
                    queue_position: 0,
                };
            }
            // Stopped - wait for green
            (VehicleTrafficState::Stopped { light_pos, .. }, _) => {
                if let Some(light) = q_lights.iter().find(|l| l.pos == *light_pos) {
                    let entry_dir = compute_entry_direction(&vehicle.route, *light_pos);

                    if light.is_green(entry_dir) {
                        *state = VehicleTrafficState::Accelerating;
                    } else {
                        *state = VehicleTrafficState::WaitingForGreen {
                            light_pos: *light_pos,
                        };
                    }
                }
            }
            // Waiting for green - check if it turned green
            (VehicleTrafficState::WaitingForGreen { light_pos }, _) => {
                if let Some(light) = q_lights.iter().find(|l| l.pos == *light_pos) {
                    let entry_dir = compute_entry_direction(&vehicle.route, *light_pos);

                    if light.is_green(entry_dir) {
                        *state = VehicleTrafficState::Accelerating;
                    }
                }
            }
            // Accelerating - transition to crossing
            (VehicleTrafficState::Accelerating, _) => {
                if vehicle.speed >= vehicle.max_speed * 0.5 {
                    *state = VehicleTrafficState::CrossingIntersection;
                }
            }
            // Crossing - check if passed
            (VehicleTrafficState::CrossingIntersection, Some((pos, _))) => {
                // Check if we've passed the intersection
                if let Some(current_tile) = vehicle.route.first() {
                    if *current_tile != pos {
                        // Passed the intersection
                        *state = VehicleTrafficState::FreeFlow;
                    }
                }
            }
            _ => {}
        }
    }
}

/// Find traffic light ahead on route
fn find_traffic_light_ahead(
    route: &[TilePos],
    progress: f32,
    max_distance: f32,
    intersections: &IntersectionIndex,
) -> Option<(TilePos, f32)> {
    let mut distance = 1.0 - progress; // Remaining distance to end of current tile

    for (_i, tile) in route.iter().enumerate().skip(1) {
        if distance > max_distance {
            return None;
        }

        if intersections.traffic_light_positions.contains(tile) {
            return Some((*tile, distance));
        }

        distance += 1.0;
    }

    None
}

/// Find traffic light at position
fn find_light_at(q_lights: &Query<&TrafficLight>, pos: TilePos) -> bool {
    q_lights.iter().any(|light| light.pos == pos)
}

/// Compute entry direction to intersection
fn compute_entry_direction(route: &[TilePos], intersection_pos: TilePos) -> RoadDir {
    if route.len() < 2 {
        return RoadDir::None;
    }

    // Find the tile before intersection
    for i in 0..route.len().saturating_sub(1) {
        if route[i + 1] == intersection_pos {
            let from = route[i];
            let dx = intersection_pos.x - from.x;
            let dy = intersection_pos.y - from.y;

            if dx > 0 {
                return RoadDir::East;
            } else if dx < 0 {
                return RoadDir::West;
            } else if dy > 0 {
                return RoadDir::North;
            } else if dy < 0 {
                return RoadDir::South;
            }
        }
    }

    RoadDir::None
}

/// Update traffic queues before traffic lights
fn update_traffic_queues(mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>) {
    use std::collections::HashMap;

    // Group vehicles by traffic light
    let mut queues: HashMap<TilePos, Vec<(Entity, f32)>> = HashMap::new();

    for (entity, vehicle, state) in q_vehicles.iter() {
        let light_pos = match state {
            VehicleTrafficState::Stopped { light_pos, .. }
            | VehicleTrafficState::Braking { light_pos, .. }
            | VehicleTrafficState::WaitingForGreen { light_pos }
            | VehicleTrafficState::Approaching { light_pos, .. } => *light_pos,
            _ => continue,
        };

        // Calculate distance to light
        let dist = compute_distance_to_light(&vehicle.route, vehicle.progress, light_pos);
        queues.entry(light_pos).or_default().push((entity, dist));
    }

    // Sort by distance and assign queue positions
    for (_light_pos, mut queue) in queues {
        queue.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

        for (i, (entity, _)) in queue.iter().enumerate() {
            if let Ok((_, _, mut state)) = q_vehicles.get_mut(*entity) {
                if let VehicleTrafficState::Stopped { light_pos: pos, .. } = &mut *state {
                    *state = VehicleTrafficState::Stopped {
                        light_pos: *pos,
                        queue_position: i as u8,
                    };
                }
            }
        }
    }
}

/// Compute distance to traffic light along route
fn compute_distance_to_light(route: &[TilePos], progress: f32, light_pos: TilePos) -> f32 {
    let mut distance = 1.0 - progress;

    for tile in route.iter().skip(1) {
        if *tile == light_pos {
            return distance;
        }
        distance += 1.0;
    }

    distance
}

/// Check intersection priority rules (yield/stop signs)
fn check_intersection_priority(
    _grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    q_vehicles: Query<(Entity, &Vehicle, &VehicleTrafficState)>,
    _q_intersections: Query<&IntersectionPriority>,
) {
    // For intersections without traffic lights, apply priority rules
    // Simplified implementation: check if vehicle is approaching intersection
    // and apply yield/stop rules based on priority type

    for (_entity, vehicle, _state) in q_vehicles.iter() {
        // Only check for vehicles in FreeFlow state approaching intersections
        // This is a placeholder - full implementation would:
        // 1. Check if vehicle is approaching intersection without traffic light
        // 2. Check intersection priority (yield/stop/main road)
        // 3. Apply rules (stop, yield to right, etc.)
        // 4. Update VehicleTrafficState accordingly

        // For now, just check if next tile is intersection without traffic light
        if let Some(next_tile) = vehicle.route.first() {
            let _has_traffic_light = intersections.traffic_light_positions.contains(next_tile);
            // Priority rules would be applied here
        }
    }
}

/// Compute acceleration based on traffic state
fn compute_acceleration(
    vehicle: &Vehicle,
    state: &VehicleTrafficState,
    params: &BrakingParams,
    dt: f32,
) -> f32 {
    match state {
        VehicleTrafficState::FreeFlow | VehicleTrafficState::CrossingIntersection => {
            // Accelerate to max speed
            let delta_v = vehicle.max_speed - vehicle.speed;
            (delta_v * 2.0).clamp(-params.max_decel, vehicle.max_accel)
        }
        VehicleTrafficState::Approaching {
            distance_to_stop, ..
        } => {
            // Smooth braking based on distance
            let required_decel =
                (vehicle.speed * vehicle.speed) / (2.0 * distance_to_stop.max(0.1));

            if required_decel > params.comfortable_decel {
                -required_decel.min(params.max_decel)
            } else {
                0.0
            }
        }
        VehicleTrafficState::Braking { target_speed, .. } => {
            // Active braking to target speed
            let delta_v = *target_speed - vehicle.speed;
            if delta_v < 0.0 {
                delta_v.max(-params.max_decel * dt) / dt
            } else {
                0.0
            }
        }
        VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. } => {
            // Full stop
            if vehicle.speed > 0.01 {
                -params.max_decel
            } else {
                0.0
            }
        }
        VehicleTrafficState::Accelerating => {
            // Smooth start
            vehicle.max_accel * 0.8
        }
    }
}

/// Update the occupancy map based on current vehicle positions.
fn update_traffic_occupancy(
    grid: Res<MapGrid>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
    q: Query<&Vehicle>,
    cfg: Res<TrafficConfig>,
) {
    // Ensure vectors match grid size.
    let len = grid.len();
    if occ.per_tick_vehicles.len() != len {
        occ.per_tick_vehicles.clear();
        occ.per_tick_vehicles.resize(len, 0);
    } else {
        occ.per_tick_vehicles.fill(0);
    }
    if occ.ema_heat.len() != len {
        occ.ema_heat.clear();
        occ.ema_heat.resize(len, 0.0);
    }

    // Count occupancy at end-of-tick.
    for vehicle in q.iter() {
        if let Some(pos) = vehicle.route.first()
            && let Some(idx) = grid.idx(*pos)
        {
            // saturate at u16::MAX; capacity is small in MVP anyway.
            occ.per_tick_vehicles[idx] = occ.per_tick_vehicles[idx].saturating_add(1);
        }
    }

    // Update EMA heatmap (for overlay) and compute TrafficIndex.
    let mut road_tiles = 0u32;
    let mut vehicles_on_roads = 0u32;
    let mut sum_cong = 0.0f32;
    let mut max_cong = 0.0f32;

    let decay = cfg.heat_ema_decay.clamp(0.0, 0.999);

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(ti) = grid.idx(pos) else { continue };
            let Some(cell) = grid.get(pos) else { continue };
            if cell.water || !cell.road.is_some() {
                continue;
            }
            road_tiles += 1;

            let c = occ.per_tick_vehicles[ti] as f32;
            vehicles_on_roads = vehicles_on_roads.saturating_add(occ.per_tick_vehicles[ti] as u32);

            let cap = (cell.road.kind.capacity_per_lane_tile() as f32).max(1.0);
            let cong = (c / cap).clamp(0.0, 1.0);
            sum_cong += cong;
            if cong > max_cong {
                max_cong = cong;
            }

            // EMA: keep a smooth overlay.
            occ.ema_heat[ti] = occ.ema_heat[ti] * decay + c * (1.0 - decay);
        }
    }

    idx.road_tiles = road_tiles;
    idx.vehicles_on_roads = vehicles_on_roads;
    if road_tiles > 0 {
        idx.avg_congestion = sum_cong / (road_tiles as f32);
        idx.max_congestion = max_cong;
    } else {
        idx.avg_congestion = 0.0;
        idx.max_congestion = 0.0;
    }
}

/// Render traffic overlay on road tiles.
fn render_traffic_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    occ: Res<TrafficOccupancy>,
    mut commands: Commands,
    existing: Query<Entity, With<TrafficOverlayTile>>,
) {
    // Always despawn existing overlay tiles first.
    for e in existing.iter() {
        commands.entity(e).despawn();
    }

    if ui.overlay != OverlayMode::Traffic {
        return;
    }

    if occ.ema_heat.len() != grid.len() {
        return;
    }

    let max_heat = occ
        .ema_heat
        .iter()
        .copied()
        .fold(0.0f32, |a, b| a.max(b))
        .max(0.001);

    let origin = map_origin(&cfg);

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(idx) = grid.idx(pos) else { continue };
            let Some(cell) = grid.get(pos) else { continue };
            if !cell.road.is_some() {
                continue;
            }

            let heat = (occ.ema_heat[idx] / max_heat).clamp(0.0, 1.0);

            // Low traffic: green, high traffic: red.
            let color = Color::linear_rgb(heat, 1.0 - heat, 0.0);

            let world = origin + Vec2::new(x as f32 * cfg.tile_size, y as f32 * cfg.tile_size);

            commands.spawn((
                TrafficOverlayTile,
                Sprite {
                    color,
                    custom_size: Some(Vec2::splat(cfg.tile_size * 0.85)),
                    ..default()
                },
                Transform::from_xyz(world.x, world.y, 5.0),
            ));
        }
    }
}

/// Simple vehicle LOD: hide vehicles outside the camera viewport.
fn cull_vehicle_lod(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_vehicles: Query<(&Transform, &mut Visibility), With<Vehicle>>,
) {
    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };

    let viewport = camera
        .logical_viewport_size()
        .unwrap_or(Vec2::new(window.width(), window.height()))
        .max(Vec2::ONE);
    let corners = [
        Vec2::new(0.0, 0.0),
        Vec2::new(viewport.x, 0.0),
        Vec2::new(0.0, viewport.y),
        Vec2::new(viewport.x, viewport.y),
    ];

    let mut min = Vec2::splat(f32::INFINITY);
    let mut max = Vec2::splat(f32::NEG_INFINITY);
    for c in corners {
        let Ok(w) = camera.viewport_to_world_2d(cam_gt, c) else {
            // If we can't compute bounds, keep everything visible.
            for (_, mut vis) in q_vehicles.iter_mut() {
                *vis = Visibility::Visible;
            }
            return;
        };
        min = min.min(w);
        max = max.max(w);
    }

    let margin = cfg.tile_size * 4.0;
    let min = min - Vec2::splat(margin);
    let max = max + Vec2::splat(margin);

    for (tf, mut vis) in q_vehicles.iter_mut() {
        let p = tf.translation.truncate();
        let inside = p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
        *vis = if inside {
            Visibility::Visible
        } else {
            Visibility::Hidden
        };
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn collect_road_tiles(grid: &MapGrid) -> Vec<TilePos> {
    let mut roads = Vec::new();
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            if let Some(cell) = grid.get(pos)
                && cell.road.is_some()
            {
                roads.push(pos);
            }
        }
    }
    roads
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

fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
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

fn tile_to_world(cfg: &MapConfig, pos: TilePos) -> Vec2 {
    let origin = map_origin(cfg);
    origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::ids::CitizenId;
    use crate::game::trips::TripPurpose;
    use bevy::app::App;
    use bevy::ecs::message::MessageReader;

    #[derive(Resource, Default)]
    struct FinishCount(u32);

    fn count_trip_finished(mut reader: MessageReader<TripFinished>, mut cnt: ResMut<FinishCount>) {
        for _ in reader.read() {
            cnt.0 += 1;
        }
    }

    #[test]
    fn vehicle_arrival_emits_trip_finished() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<TripFinished>()
            .insert_resource(MapConfig {
                width: 8,
                height: 8,
                tile_size: 16.0,
            })
            .insert_resource(FinishCount::default())
            .add_systems(Update, (move_vehicles, count_trip_finished).chain());

        let citizen = CitizenId(42);
        let vehicle = app
            .world_mut()
            .spawn((
                Vehicle {
                    route: Vec::new(),
                    progress: 0.0,
                    speed: 0.0,
                },
                Transform::default(),
                TripPassenger {
                    citizen,
                    purpose: TripPurpose::Work,
                },
            ))
            .id();

        app.update();

        assert_eq!(app.world().resource::<FinishCount>().0, 1);
        assert!(app.world().get_entity(vehicle).is_err());
    }
}
