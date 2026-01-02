//! 5.4 Random emergency events (MVP).
//!
//! Spawns random emergencies at buildings, dispatches service vehicles, and renders map markers.
//! Persistence is intentionally out of scope for now (see roadmap).

use std::collections::HashMap;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::prelude::*;

use crate::game::buildings::Building;
use crate::game::intersections::IntersectionIndex;
use crate::game::map::{BuildingKind, MapConfig, MapGrid, TilePos};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::roads::RoadDir;
use crate::game::services::{ServiceKind, ServiceStation, ServiceVehicle, ServiceVehicleState};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::{Parked, TrafficOccupancy, Vehicle};
use crate::game::transport::{
    PathCache, PathPool, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    find_road_path_cached,
};
use crate::game::ui_state::UiState;

#[derive(Component)]
pub struct EmergencyMarker {
    pub blink_timer: Timer,
}

pub struct EmergenciesPlugin;

/// O(1) lookup of emergencies by tile for UI/inspector/debug.
#[derive(Resource, Default)]
pub(crate) struct EmergencyEntityIndex {
    by_pos: std::collections::HashMap<TilePos, Entity>,
    by_entity: std::collections::HashMap<Entity, TilePos>,
}

impl EmergencyEntityIndex {
    pub(crate) fn get(&self, pos: TilePos) -> Option<Entity> {
        self.by_pos.get(&pos).copied()
    }
}

impl Plugin for EmergenciesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmergencyManager>()
            .init_resource::<EmergencyEntityIndex>()
            .add_systems(
                FixedUpdate,
                (
                    spawn_emergencies,
                    dispatch_emergency_vehicles,
                    update_emergency_timers,
                    resolve_emergencies,
                    apply_emergency_consequences,
                    cleanup_resolved_emergencies,
                )
                    .chain()
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );

        // Maintain cheap tile->emergency lookup for UI (no per-frame scans).
        app.add_systems(
            Update,
            track_emergency_index
                .in_set(GameSet::CommandApply)
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        );

        // Visual markers (render sync) - TODO: implement if needed
        // app.add_systems(
        //     Update,
        //     render_emergency_markers
        //         .in_set(GameSet::RenderSync)
        //         .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        // );
    }
}

fn track_emergency_index(
    mut idx: ResMut<EmergencyEntityIndex>,
    q_added: Query<(Entity, &Emergency), Added<Emergency>>,
    mut removed: RemovedComponents<Emergency>,
) {
    for (e, em) in q_added.iter() {
        idx.by_pos.insert(em.pos, e);
        idx.by_entity.insert(e, em.pos);
    }
    for e in removed.read() {
        let Some(pos) = idx.by_entity.remove(&e) else {
            continue;
        };
        if idx.by_pos.get(&pos).copied() == Some(e) {
            idx.by_pos.remove(&pos);
        }
    }
}

/// Type of emergency.
#[allow(dead_code)]
#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum EmergencyKind {
    Fire,
    Crime,
    Medical,
}

impl EmergencyKind {
    pub fn required_service(self) -> ServiceKind {
        match self {
            EmergencyKind::Fire => ServiceKind::Fire,
            EmergencyKind::Crime => ServiceKind::Police,
            EmergencyKind::Medical => ServiceKind::Medical,
        }
    }

    pub fn response_deadline(self) -> f32 {
        match self {
            EmergencyKind::Fire => 30.0,
            EmergencyKind::Crime => 45.0,
            EmergencyKind::Medical => 25.0,
        }
    }

    pub fn resolution_time(self) -> f32 {
        match self {
            EmergencyKind::Fire => 15.0,
            EmergencyKind::Crime => 10.0,
            EmergencyKind::Medical => 12.0,
        }
    }

    pub fn marker_color(self) -> Color {
        match self {
            EmergencyKind::Fire => Color::srgb(1.0, 0.4, 0.0),
            EmergencyKind::Crime => Color::srgb(1.0, 0.0, 0.0),
            EmergencyKind::Medical => Color::srgb(1.0, 1.0, 0.0),
        }
    }
}

/// Active emergency event in the world.
#[allow(dead_code)]
#[derive(Component, Debug)]
pub struct Emergency {
    pub kind: EmergencyKind,
    pub pos: TilePos,
    pub severity: f32,            // 0..1
    pub time_remaining: f32,      // until deadline, if not responded
    pub resolution_progress: f32, // 0..1
    pub responded: bool,
    pub assigned_vehicle: Option<Entity>,
    pub consequence_applied: bool,
    pub resolved: bool,
    pub failed: bool,
}

/// Runtime stats for UI later.
#[allow(dead_code)]
#[derive(serde::Serialize, serde::Deserialize, Default, Debug, Clone)]
pub struct EmergencyStats {
    pub total_fires: u32,
    pub total_crimes: u32,
    pub total_medical: u32,
    pub unresponded_fires: u32,
    pub unresponded_medical: u32,
    pub unresponded_crime: u32,
    pub total_resolved: u32,
    pub resolved_in_time: u32,
    pub failed_responses: u32,
}

#[allow(dead_code)]
#[derive(Resource)]
pub struct EmergencyManager {
    pub spawn_timer: Timer,
    pub base_spawn_chance: f32,
    pub max_active_emergencies: usize,
    pub stats: EmergencyStats,
}

impl Default for EmergencyManager {
    fn default() -> Self {
        Self {
            // Conservative defaults: emergencies are occasional and shouldn't overwhelm sim/UI.
            spawn_timer: Timer::from_seconds(6.0, TimerMode::Repeating),
            base_spawn_chance: 0.06,
            max_active_emergencies: 8,
            stats: EmergencyStats::default(),
        }
    }
}

fn spawn_emergencies(
    time: Res<Time<Fixed>>,
    city: Res<City>,
    mut manager: ResMut<EmergencyManager>,
    notifications: Option<ResMut<Notifications>>,
    mut commands: Commands,
    q_emergencies: Query<&Emergency>,
    q_buildings: Query<&Building>,
) {
    manager.spawn_timer.tick(time.delta());
    if !manager.spawn_timer.just_finished() {
        return;
    }

    if q_emergencies.iter().count() >= manager.max_active_emergencies {
        return;
    }

    // Keep a minimum factor so a small/empty city still produces events for debugging.
    let population_factor = (city.population as f32 / 100.0).max(0.4);
    let spawn_chance = manager.base_spawn_chance * population_factor;

    let mut rng = rand::rng();
    if rng.random_range(0.0..1.0) > spawn_chance {
        return;
    }

    let buildings: Vec<TilePos> = q_buildings
        .iter()
        .filter(|b| {
            matches!(
                b.kind,
                BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
            )
        })
        .map(|b| b.pos)
        .collect();

    if buildings.is_empty() {
        return;
    }

    let pos = *buildings.choose(&mut rng).unwrap();
    let kind = match rng.random_range(0..3) {
        0 => EmergencyKind::Fire,
        1 => EmergencyKind::Crime,
        _ => EmergencyKind::Medical,
    };
    let severity = rng.random_range(0.3..1.0);

    commands.spawn(Emergency {
        kind,
        pos,
        severity,
        time_remaining: kind.response_deadline(),
        resolution_progress: 0.0,
        responded: false,
        assigned_vehicle: None,
        consequence_applied: false,
        resolved: false,
        failed: false,
    });

    match kind {
        EmergencyKind::Fire => manager.stats.total_fires += 1,
        EmergencyKind::Crime => manager.stats.total_crimes += 1,
        EmergencyKind::Medical => manager.stats.total_medical += 1,
    }

    // Emit notification
    if let Some(mut notif) = notifications {
        let kind_name = match kind {
            EmergencyKind::Fire => "Fire",
            EmergencyKind::Crime => "Crime",
            EmergencyKind::Medical => "Medical",
        };
        notif.add(
            format!("{} emergency at ({}, {})", kind_name, pos.x, pos.y),
            NotificationKind::Warning,
            5.0,
        );
    }
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

fn pick_reachable_road_endpoint(
    grid: &MapGrid,
    graph: &RoadGraph,
    pos: TilePos,
    preferred_dir: Option<RoadDir>,
) -> Option<TilePos> {
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

    let mut best_any: Option<TilePos> = None;

    for cpos in candidates {
        let Some(cell) = grid.get(cpos) else { continue };
        if cell.water || !cell.road.is_some() {
            continue;
        }
        best_any = best_any.or(Some(cpos));

        if let Some(dir) = preferred_dir
            && cell.road.dir != dir
        {
            continue;
        }

        // Prefer endpoints that are reachable in the current graph.
        if graph.edges.is_empty() || graph.width == 0 {
            return Some(cpos);
        }
        let idx = grid.idx(cpos)?;
        if graph.edges.get(idx).copied().unwrap_or(0) != 0 {
            return Some(cpos);
        }
    }

    // Fallback: any road tile near position.
    best_any
}

fn find_path_with_fallback(
    ctx: &mut PathfindingCtx<'_>,
    _grid: &MapGrid,
    start: TilePos,
    goal: TilePos,
) -> Vec<TilePos> {
    // No fallback to astar_path - vehicles must follow lane rules.
    find_road_path_cached(ctx, start, goal)
}

fn adjacent_road_any(grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
    if let Some(cell) = grid.get(pos)
        && !cell.water
        && cell.road.is_some()
    {
        return Some(pos);
    }
    for npos in [
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
    ] {
        if let Some(cell) = grid.get(npos)
            && !cell.water
            && cell.road.is_some()
        {
            return Some(npos);
        }
    }
    None
}

#[derive(SystemParam)]
struct DispatchParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    time: Res<'w, Time<Fixed>>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    path_pool: ResMut<'w, PathPool>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, TrafficOccupancy>,
    intersections: Res<'w, IntersectionIndex>,
    q_emergencies: Query<'w, 's, (Entity, &'static mut Emergency)>,
    q_stations: Query<'w, 's, (Entity, &'static mut ServiceStation)>,
    q_vehicles: Query<'w, 's, (Entity, &'static mut ServiceVehicle, &'static mut Vehicle)>,
}

fn dispatch_emergency_vehicles(mut p: DispatchParams) {
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

    for (emergency_entity, mut emergency) in q_emergencies.iter_mut() {
        if emergency.resolved || emergency.failed {
            continue;
        }
        if emergency.assigned_vehicle.is_some() {
            continue;
        }

        let required = emergency.kind.required_service();

        let mut best_station: Option<(Entity, usize, TilePos, TilePos)> = None; // (station, dist, station_road, emergency_road)

        for (station_entity, station) in q_stations.iter() {
            if station.kind != required {
                continue;
            }
            if station.available_vehicles == 0 {
                continue;
            }
            // Prefer lane tiles that match the desired travel direction to avoid picking the wrong carriageway.
            let travel_dir = desired_dir(station.pos, emergency.pos);
            let Some(station_road) =
                pick_reachable_road_endpoint(&grid, &graph, station.pos, Some(travel_dir))
            else {
                continue;
            };
            let Some(emergency_road) =
                pick_reachable_road_endpoint(&grid, &graph, emergency.pos, Some(travel_dir))
            else {
                continue;
            };

            let path = find_path_with_fallback(&mut ctx, &grid, station_road, emergency_road);
            if path.is_empty() {
                continue;
            }

            let dist = path.len();
            match best_station {
                None => best_station = Some((station_entity, dist, station_road, emergency_road)),
                Some((_, best_dist, _, _)) if dist < best_dist => {
                    best_station = Some((station_entity, dist, station_road, emergency_road));
                }
                _ => {}
            }
        }

        let Some((station_entity, _, station_road, emergency_road)) = best_station else {
            continue;
        };

        // Find a free vehicle from this station and assign.
        for (vehicle_entity, mut sv, mut vehicle) in q_vehicles.iter_mut() {
            if sv.home_station != station_entity {
                continue;
            }
            if sv.state != ServiceVehicleState::AtStation {
                continue;
            }

            sv.mission = Some(emergency_entity);
            sv.state = ServiceVehicleState::EnRoute;
            emergency.assigned_vehicle = Some(vehicle_entity);

            // Build route from the vehicle's parked lane tile if possible.
            let from = path_pool
                .get_tile(vehicle.path_handle, vehicle.path_cursor)
                .unwrap_or(sv.home_road);
            let mut route = find_path_with_fallback(&mut ctx, &grid, from, emergency_road);
            if route.is_empty() && from != station_road {
                route = find_path_with_fallback(&mut ctx, &grid, station_road, emergency_road);
            }
            // Release old path if any
            path_pool.release(vehicle.path_handle);
            vehicle.path_handle = path_pool.intern(route);
            vehicle.path_cursor = 0;
            vehicle.speed = sv.kind.vehicle_speed();

            // Remove Parked component - vehicle is now active on the road
            p.commands.entity(vehicle_entity).remove::<Parked>();

            if let Ok((_, mut station)) = p.q_stations.get_mut(station_entity) {
                station.available_vehicles = station.available_vehicles.saturating_sub(1);
            }
            break;
        }
    }
}

fn update_emergency_timers(time: Res<Time<Fixed>>, ui: Res<UiState>, mut q: Query<&mut Emergency>) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed;

    for mut e in q.iter_mut() {
        if e.resolved || e.failed {
            continue;
        }
        if !e.responded {
            e.time_remaining -= dt;
        }
    }
}

fn resolve_emergencies(
    mut commands: Commands,
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    grid: Res<MapGrid>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    intersections: Res<IntersectionIndex>,
    notifications: Option<ResMut<Notifications>>,
    mut q_emergencies: Query<(Entity, &mut Emergency)>,
    mut q_stations: Query<&mut ServiceStation>,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &mut Vehicle)>,
    mut manager: ResMut<EmergencyManager>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed;

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

    for (emergency_entity, mut emergency) in q_emergencies.iter_mut() {
        if emergency.resolved || emergency.failed {
            continue;
        }
        if emergency.assigned_vehicle.is_some() {
            continue;
        }

        // Find nearest available service station
        let mut best_station: Option<(Entity, &mut ServiceStation, TilePos, f32)> = None;
        let mut best_distance = f32::INFINITY;

        for (station_entity, mut station) in q_stations.iter_mut() {
            if station.occupied {
                continue;
            }

            let station_pos = station.pos;
            let emergency_pos = emergency.pos;
            let distance = ((station_pos.x - emergency_pos.x).powi(2) + (station_pos.y - emergency_pos.y).powi(2)) as f32;

            if distance < best_distance {
                best_distance = distance;
                best_station = Some((station_entity, station, station_pos, distance));
            }
        }

        let Some((station_entity, station, station_road, _)) = best_station else {
            continue;
        };

        // Find the best vehicle at this station
        let mut best_vehicle: Option<(Entity, &mut ServiceVehicle, &mut Vehicle)> = None;

        for (vehicle_entity, mut sv, vehicle) in q_vehicles.iter_mut() {
            if sv.home_station != station_entity {
                continue;
            }
            if sv.state != ServiceVehicleState::AtStation {
                continue;
            }

            // Check if vehicle is actually at station
            if vehicle.path_cursor > 0 {
                continue;
            }

            best_vehicle = Some((vehicle_entity, sv, vehicle));
            break; // Take first available
        }

        let Some((vehicle_entity, sv, vehicle)) = best_vehicle else {
            continue;
        };

        // Assign vehicle to emergency
        emergency.assigned_vehicle = Some(vehicle_entity);
        station.occupied = true;
        sv.state = ServiceVehicleState::EnRoute;
        sv.mission = Some(emergency_entity);

        // Build route from the vehicle's parked lane tile if possible.
        let from = path_pool
            .get_tile(vehicle.path_handle, vehicle.path_cursor)
            .unwrap_or(sv.home_road);
        let mut route = find_path_with_fallback(&mut ctx, &grid, from, emergency.pos);
        if route.is_empty() && from != station.pos {
            route = find_path_with_fallback(&mut ctx, &grid, station.pos, emergency.pos);
        }
        // Release old path if any
        path_pool.release(vehicle.path_handle);
        vehicle.path_handle = path_pool.intern(route);
        vehicle.path_cursor = 0;
        vehicle.speed = sv.kind.vehicle_speed();

        // Remove Parked component - vehicle is now active on the road
        commands
            .entity(vehicle_entity)
            .remove::<Parked>()
            .remove::<RightTurnOnRed>();
    }

    // Update vehicle states
    for (vehicle_entity, mut sv, mut vehicle) in q_vehicles.iter_mut() {
        match sv.state {
            ServiceVehicleState::EnRoute => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    sv.state = ServiceVehicleState::OnScene;
                    // Arrived at emergency
                    if let Some(emergency_entity) = sv.mission {
                        if let Ok((_, mut emergency)) = q_emergencies.get_mut(emergency_entity) {
                            emergency.responded = true;
                        }
                    }
                    vehicle.speed = 0.0;
                    // Park on scene - don't block traffic while resolving emergency
                    commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                }
            }
            ServiceVehicleState::OnScene => {
                // Wait for emergency resolution
            }
            ServiceVehicleState::Returning => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    // Back at station.
                    sv.state = ServiceVehicleState::AtStation;
                    sv.mission = None;
                    vehicle.speed = 0.0;
                    // Release old path and create new single-tile path
                    path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = path_pool.intern(vec![sv.home_road]);
                    vehicle.path_cursor = 0;
                    // Add Parked component - vehicle is now parked at station
                    commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                    // Free the station
                    if let Ok(mut station) = q_stations.get_mut(sv.home_station) {
                        station.occupied = false;
                    }
                }
            }
            ServiceVehicleState::AtStation => {
                // Idle at station
            }
        }
    }
}

fn resolve_emergencies(
    mut commands: Commands,
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    grid: Res<MapGrid>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    intersections: Res<IntersectionIndex>,
    notifications: Option<ResMut<Notifications>>,
    mut q_emergencies: Query<(Entity, &mut Emergency)>,
    mut q_stations: Query<&mut ServiceStation>,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &mut Vehicle)>,
    mut manager: ResMut<EmergencyManager>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed;

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

    // Map emergency -> road once.
    let mut emergency_road = HashMap::<Entity, TilePos>::new();
    for (ee, e) in p.q_emergencies.iter() {
        if let Some(r) = adjacent_road_any(&p.grid, e.pos) {
            emergency_road.insert(ee, r);
        }
    }

    for (emergency_entity, mut emergency) in p.q_emergencies.iter_mut() {
        if emergency.resolved || emergency.failed {
            continue;
        }
        let Some(vehicle_entity) = emergency.assigned_vehicle else {
            continue;
        };

        let Ok((_, mut sv, mut vehicle)) = p.q_vehicles.get_mut(vehicle_entity) else {
            // Vehicle despawned unexpectedly; clear assignment.
            emergency.assigned_vehicle = None;
            continue;
        };

        match sv.state {
            ServiceVehicleState::EnRoute => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    sv.state = ServiceVehicleState::OnScene;
                    emergency.responded = true;
                    vehicle.speed = 0.0;
                    // Park on scene - don't block traffic while resolving emergency
                    p.commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });

                    // Emit notification
                    if let Some(ref mut notif) = p.notifications {
                        let kind_name = match emergency.kind {
                            EmergencyKind::Fire => "Fire",
                            EmergencyKind::Crime => "Crime",
                            EmergencyKind::Medical => "Medical",
                        };
                        notif.add(
                            format!("{} emergency responded", kind_name),
                            NotificationKind::Info,
                            3.0,
                        );
                    }
                }
            }
            ServiceVehicleState::OnScene => {
                let rate = 1.0 / emergency.kind.resolution_time();
                emergency.resolution_progress += rate * dt;
                if emergency.resolution_progress >= 1.0 {
                    emergency.resolution_progress = 1.0;
                    emergency.resolved = true;

                    // Send vehicle back to station - remove Parked so it can drive
                    sv.state = ServiceVehicleState::Returning;
                    p.commands.entity(vehicle_entity).remove::<Parked>();
                    let Some(station_pos) = p.q_stations.get(sv.home_station).ok().map(|s| s.pos)
                    else {
                        continue;
                    };

                    let return_dir = desired_dir(emergency.pos, station_pos);
                    let from = pick_reachable_road_endpoint(
                        &p.grid,
                        &p.graph,
                        emergency.pos,
                        Some(return_dir),
                    )
                    .or_else(|| emergency_road.get(&emergency_entity).copied())
                    .unwrap_or(sv.home_road);
                    let to = pick_reachable_road_endpoint(
                        &p.grid,
                        &p.graph,
                        station_pos,
                        Some(return_dir),
                    )
                    .unwrap_or(sv.home_road);
                    // Release old path and set new one
                    path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = path_pool
                        .intern(find_path_with_fallback(&mut ctx, &grid, from, to));

                    if emergency.time_remaining > 0.0 {
                        p.manager.stats.resolved_in_time += 1;

                        // Emit notification
                        if let Some(ref mut notif) = p.notifications {
                            let kind_name = match emergency.kind {
                                EmergencyKind::Fire => "Fire",
                                EmergencyKind::Crime => "Crime",
                                EmergencyKind::Medical => "Medical",
                            };
                            notif.add(
                                format!("{} emergency resolved", kind_name),
                                NotificationKind::Info,
                                3.0,
                            );
                        }
                    } else {
                        // Failed to resolve in time - this is an error
                        if let Some(ref mut notif) = p.notifications {
                            let kind_name = match emergency.kind {
                                EmergencyKind::Fire => "Fire",
                                EmergencyKind::Crime => "Crime",
                                EmergencyKind::Medical => "Medical",
                            };
                            notif.add(
                                format!("{} emergency failed - critical!", kind_name),
                                NotificationKind::Error,
                                7.0,
                            );
                        }
                    }
                }
            }
            ServiceVehicleState::Returning => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    // Back at station.
                    sv.state = ServiceVehicleState::AtStation;
                    sv.mission = None;
                    vehicle.speed = 0.0;
                    // Release old path and create new single-tile path
                    path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = path_pool.intern(vec![sv.home_road]);
                    vehicle.path_cursor = 0;
                    // Add Parked component - vehicle is now parked at station
                    p.commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                    if let Ok(mut station) = p.q_stations.get_mut(sv.home_station) {
                        station.available_vehicles = station.available_vehicles.saturating_add(1);
                    }
                }
            }
            ServiceVehicleState::AtStation => {}
        }
    }
}

pub(super) fn resolve_emergencies(
    mut commands: Commands,
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    grid: Res<MapGrid>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    intersections: Res<IntersectionIndex>,
    notifications: Option<ResMut<Notifications>>,
    mut q_emergencies: Query<(Entity, &mut Emergency)>,
    mut q_stations: Query<&mut ServiceStation>,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &mut Vehicle)>,
    mut manager: ResMut<EmergencyManager>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed;

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

    for (emergency_entity, mut emergency) in q_emergencies.iter_mut() {
        if emergency.resolved || emergency.failed {
            continue;
        }
        if emergency.assigned_vehicle.is_some() {
            continue;
        }

        // Find nearest available service station
        let mut best_station: Option<(Entity, &mut ServiceStation, TilePos, f32)> = None;
        let mut best_distance = f32::INFINITY;

        for (station_entity, mut station) in q_stations.iter_mut() {
            if station.occupied {
                continue;
            }

            let station_pos = station.pos;
            let emergency_pos = emergency.pos;
            let distance = ((station_pos.x - emergency_pos.x).powi(2) + (station_pos.y - emergency_pos.y).powi(2)) as f32;

            if distance < best_distance {
                best_distance = distance;
                best_station = Some((station_entity, station, station_pos, distance));
            }
        }

        let Some((station_entity, station, station_road, _)) = best_station else {
            continue;
        };

        // Find the best vehicle at this station
        let mut best_vehicle: Option<(Entity, &mut ServiceVehicle, &mut Vehicle)> = None;

        for (vehicle_entity, mut sv, vehicle) in q_vehicles.iter_mut() {
            if sv.home_station != station_entity {
                continue;
            }
            if sv.state != ServiceVehicleState::AtStation {
                continue;
            }

            // Check if vehicle is actually at station
            if vehicle.path_cursor > 0 {
                continue;
            }

            best_vehicle = Some((vehicle_entity, sv, vehicle));
            break; // Take first available
        }

        let Some((vehicle_entity, sv, vehicle)) = best_vehicle else {
            continue;
        };

        // Assign vehicle to emergency
        emergency.assigned_vehicle = Some(vehicle_entity);
        station.occupied = true;
        sv.state = ServiceVehicleState::EnRoute;
        sv.mission = Some(emergency_entity);

        // Build route from the vehicle's parked lane tile if possible.
        let from = path_pool
            .get_tile(vehicle.path_handle, vehicle.path_cursor)
            .unwrap_or(sv.home_road);
        let mut route = find_path_with_fallback(&mut ctx, &grid, from, emergency.pos);
        if route.is_empty() && from != station.pos {
            route = find_path_with_fallback(&mut ctx, &grid, station.pos, emergency.pos);
        }
        // Release old path if any
        path_pool.release(vehicle.path_handle);
        vehicle.path_handle = path_pool.intern(route);
        vehicle.path_cursor = 0;
        vehicle.speed = sv.kind.vehicle_speed();

        // Remove Parked component - vehicle is now active on the road
        commands
            .entity(vehicle_entity)
            .remove::<Parked>()
            .remove::<RightTurnOnRed>();
    }

    // Update vehicle states
    for (vehicle_entity, mut sv, mut vehicle) in q_vehicles.iter_mut() {
        match sv.state {
            ServiceVehicleState::EnRoute => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    sv.state = ServiceVehicleState::OnScene;
                    // Arrived at emergency
                    if let Some(emergency_entity) = sv.mission {
                        if let Ok((_, mut emergency)) = q_emergencies.get_mut(emergency_entity) {
                            emergency.responded = true;
                        }
                    }
                    vehicle.speed = 0.0;
                    // Park on scene - don't block traffic while resolving emergency
                    commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                }
            }
            ServiceVehicleState::OnScene => {
                // Wait for emergency resolution
            }
            ServiceVehicleState::Returning => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    // Back at station.
                    sv.state = ServiceVehicleState::AtStation;
                    sv.mission = None;
                    vehicle.speed = 0.0;
                    // Release old path and create new single-tile path
                    path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = path_pool.intern(vec![sv.home_road]);
                    vehicle.path_cursor = 0;
                    // Add Parked component - vehicle is now parked at station
                    commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                    // Free the station
                    if let Ok(mut station) = q_stations.get_mut(sv.home_station) {
                        station.occupied = false;
                    }
                }
            }
            ServiceVehicleState::AtStation => {
                // Idle at station
            }
        }
    }
}

fn apply_emergency_consequences(
    mut city: ResMut<City>,
    mut q_emergencies: Query<&mut Emergency>,
    mut manager: ResMut<EmergencyManager>,
) {
    for mut e in q_emergencies.iter_mut() {
        if e.resolved && !e.consequence_applied {
            e.consequence_applied = true;

            // Apply consequences based on emergency type and response time
            match e.kind {
                EmergencyKind::Fire => {
                    if !e.responded {
                        // Fire spreads if not responded to
                        city.population = city.population.saturating_sub(5);
                        manager.stats.unresponded_fires += 1;
                    }
                }
                EmergencyKind::Medical => {
                    if !e.responded {
                        // Citizen dies if medical emergency not handled
                        city.population = city.population.saturating_sub(1);
                        manager.stats.unresponded_medical += 1;
                    }
                }
                EmergencyKind::Crime => {
                    if !e.responded {
                        // Crime reduces happiness/trust
                        city.money = city.money.saturating_sub(100);
                        manager.stats.unresponded_crime += 1;
                    }
                }
            }

            manager.stats.total_resolved += 1;
        }
    }
}

fn cleanup_resolved_emergencies(
    mut commands: Commands,
    mut q_emergencies: Query<(Entity, &Emergency)>,
) {
    for (entity, emergency) in q_emergencies.iter() {
        if emergency.resolved && emergency.consequence_applied {
            commands.entity(entity).despawn();
        }
    }
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
    mut manager: ResMut<EmergencyManager>,
) {
    for mut e in q_emergencies.iter_mut() {
        if e.resolved || e.failed {
            continue;
        }
        if e.responded || e.time_remaining > 0.0 {
            continue;
        }
        if e.consequence_applied {
            continue;
        }

        e.consequence_applied = true;
        e.failed = true;
        manager.stats.failed_responses += 1;

        match e.kind {
            EmergencyKind::Fire => {
                city.happiness = (city.happiness - 0.05 * e.severity).clamp(0.0, 1.0);
            }
            EmergencyKind::Crime => {
                city.happiness = (city.happiness - 0.03 * e.severity).clamp(0.0, 1.0);
            }
            EmergencyKind::Medical => {
                city.population = city.population.saturating_sub(1);
                city.happiness = (city.happiness - 0.04 * e.severity).clamp(0.0, 1.0);
            }
        }
    }
}

fn cleanup_resolved_emergencies(
    mut commands: Commands,
    q_emergencies: Query<(Entity, &Emergency)>,
) {
    for (e, ev) in q_emergencies.iter() {
        if ev.resolved || ev.failed {
            commands.entity(e).despawn();
        }
    }
}

#[derive(Component)]
struct EmergencyMarker {
    emergency: Entity,
    blink_timer: Timer,
}

fn render_emergency_markers(
    time: Res<Time>,
    cfg: Res<MapConfig>,
    mut commands: Commands,
    q_emergencies: Query<(Entity, &Emergency)>,
    mut q_markers: Query<(Entity, &mut EmergencyMarker, &mut Sprite)>,
) {
    // Build a lookup of active emergencies.
    let mut active = HashMap::<Entity, EmergencyKind>::new();
    for (e, ev) in q_emergencies.iter() {
        if ev.resolved || ev.failed {
            continue;
        }
        active.insert(e, ev.kind);
    }

    // Despawn markers for missing emergencies.
    for (marker_e, marker, _) in q_markers.iter_mut() {
        if !active.contains_key(&marker.emergency) {
            commands.entity(marker_e).despawn();
        }
    }

    // Spawn markers for emergencies without one.
    for (e, ev) in q_emergencies.iter() {
        if ev.resolved || ev.failed {
            continue;
        }
        let has_marker = q_markers.iter().any(|(_, m, _)| m.emergency == e);
        if has_marker {
            continue;
        }

        let world = tile_to_world(&cfg, ev.pos);
        commands.spawn((
            Sprite {
                color: ev.kind.marker_color(),
                custom_size: Some(Vec2::splat(cfg.tile_size * 0.4)),
                ..default()
            },
            Transform::from_xyz(world.x, world.y, 15.0),
            EmergencyMarker {
                emergency: e,
                blink_timer: Timer::from_seconds(0.5, TimerMode::Repeating),
            },
        ));
    }

    // Blink markers.
    for (_, mut marker, mut sprite) in q_markers.iter_mut() {
        marker.blink_timer.tick(time.delta());
        if marker.blink_timer.just_finished() {
            let a = sprite.color.alpha();
            sprite.color.set_alpha(if a > 0.6 { 0.25 } else { 1.0 });
        }
    }
}

pub(super) fn resolve_emergencies(
    mut commands: Commands,
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    grid: Res<MapGrid>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    intersections: Res<IntersectionIndex>,
    notifications: Option<ResMut<Notifications>>,
    mut q_emergencies: Query<(Entity, &mut Emergency)>,
    mut q_stations: Query<&mut ServiceStation>,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &mut Vehicle)>,
    mut manager: ResMut<EmergencyManager>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed;

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

    for (emergency_entity, mut emergency) in q_emergencies.iter_mut() {
        if emergency.resolved || emergency.failed {
            continue;
        }
        if emergency.assigned_vehicle.is_some() {
            continue;
        }

        // Find nearest available service station
        let mut best_station: Option<(Entity, &mut ServiceStation, TilePos, f32)> = None;
        let mut best_distance = f32::INFINITY;

        for (station_entity, mut station) in q_stations.iter_mut() {
            if station.occupied {
                continue;
            }

            let station_pos = station.pos;
            let emergency_pos = emergency.pos;
            let distance = ((station_pos.x - emergency_pos.x).powi(2) + (station_pos.y - emergency_pos.y).powi(2)) as f32;

            if distance < best_distance {
                best_distance = distance;
                best_station = Some((station_entity, station, station_pos, distance));
            }
        }

        let Some((station_entity, station, station_road, _)) = best_station else {
            continue;
        };

        // Find the best vehicle at this station
        let mut best_vehicle: Option<(Entity, &mut ServiceVehicle, &mut Vehicle)> = None;

        for (vehicle_entity, mut sv, vehicle) in q_vehicles.iter_mut() {
            if sv.home_station != station_entity {
                continue;
            }
            if sv.state != ServiceVehicleState::AtStation {
                continue;
            }

            // Check if vehicle is actually at station
            if vehicle.path_cursor > 0 {
                continue;
            }

            best_vehicle = Some((vehicle_entity, sv, vehicle));
            break; // Take first available
        }

        let Some((vehicle_entity, sv, vehicle)) = best_vehicle else {
            continue;
        };

        // Assign vehicle to emergency
        emergency.assigned_vehicle = Some(vehicle_entity);
        station.occupied = true;
        sv.state = ServiceVehicleState::EnRoute;
        sv.mission = Some(emergency_entity);

        // Build route from the vehicle's parked lane tile if possible.
        let from = path_pool
            .get_tile(vehicle.path_handle, vehicle.path_cursor)
            .unwrap_or(sv.home_road);
        let mut route = find_path_with_fallback(&mut ctx, &grid, from, emergency.pos);
        if route.is_empty() && from != station.pos {
            route = find_path_with_fallback(&mut ctx, &grid, station.pos, emergency.pos);
        }
        // Release old path if any
        path_pool.release(vehicle.path_handle);
        vehicle.path_handle = path_pool.intern(route);
        vehicle.path_cursor = 0;
        vehicle.speed = sv.kind.vehicle_speed();

        // Remove Parked component - vehicle is now active on the road
        commands
            .entity(vehicle_entity)
            .remove::<Parked>()
            .remove::<RightTurnOnRed>();
    }

    // Update vehicle states
    for (vehicle_entity, mut sv, mut vehicle) in q_vehicles.iter_mut() {
        match sv.state {
            ServiceVehicleState::EnRoute => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    sv.state = ServiceVehicleState::OnScene;
                    // Arrived at emergency
                    if let Some(emergency_entity) = sv.mission {
                        if let Ok((_, mut emergency)) = q_emergencies.get_mut(emergency_entity) {
                            emergency.responded = true;
                        }
                    }
                    vehicle.speed = 0.0;
                    // Park on scene - don't block traffic while resolving emergency
                    commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                }
            }
            ServiceVehicleState::OnScene => {
                // Wait for emergency resolution
            }
            ServiceVehicleState::Returning => {
                if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                    // Back at station.
                    sv.state = ServiceVehicleState::AtStation;
                    sv.mission = None;
                    vehicle.speed = 0.0;
                    // Release old path and create new single-tile path
                    path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = path_pool.intern(vec![sv.home_road]);
                    vehicle.path_cursor = 0;
                    // Add Parked component - vehicle is now parked at station
                    commands
                        .entity(vehicle_entity)
                        .insert(Parked { offset: 1.0 });
                    // Free the station
                    if let Ok(mut station) = q_stations.get_mut(sv.home_station) {
                        station.occupied = false;
                    }
                }
            }
            ServiceVehicleState::AtStation => {
                // Idle at station
            }
        }
    }
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
