//! Emergency system implementations: spawning, dispatch, resolution, and cleanup.

use std::collections::HashMap;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::prelude::*;

use crate::game::buildings::Building;
use crate::game::intersections::IntersectionIndex;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::roads::RoadDir;
use crate::game::services::{ServiceStation, ServiceVehicle, ServiceVehicleState};
use crate::game::sim::City;
use crate::game::sim_events::HourAdvanced;
use crate::game::traffic::{Parked, Vehicle};
use crate::game::transport::{
    PathCache, PathPool, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    find_road_path_cached,
};
use bevy::ecs::message::MessageReader;

use super::components::{Emergency, EmergencyEntityIndex, EmergencyKind, EmergencyManager};

/// GDD: Spawn emergencies every 6 game hours
pub(crate) fn spawn_emergencies(
    mut hour_events: MessageReader<'_, '_, HourAdvanced>,
    city: Res<City>,
    mut manager: ResMut<EmergencyManager>,
    notifications: Option<ResMut<Notifications>>,
    mut commands: Commands,
    q_emergencies: Query<&Emergency>,
    q_buildings: Query<&Building>,
) {
    // Count game hours
    let hours_passed = hour_events.read().count() as u32;
    if hours_passed == 0 {
        return;
    }
    
    manager.hours_since_last_spawn += hours_passed;
    
    // Spawn every 6 game hours (GDD 13.2.1)
    const SPAWN_INTERVAL_HOURS: u32 = 6;
    if manager.hours_since_last_spawn < SPAWN_INTERVAL_HOURS {
        return;
    }
    
    manager.hours_since_last_spawn = manager.hours_since_last_spawn % SPAWN_INTERVAL_HOURS;

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
        .map(|b| b.anchor_pos)
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
        spawned_at: 0.0,
        responded: false,
        response_time_sec: None,
        resolved: false,
        consequence_applied: false,
        failed: false,
        time_remaining: kind.response_deadline(),
        dispatched_vehicles: vec![],
        resolution_progress: 0.0,
        assigned_vehicle: None,
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
        let Some(cell) = grid.get(cpos) else {
            continue;
        };
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
pub(crate) struct DispatchParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    time: Res<'w, Time<bevy::time::Fixed>>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    path_pool: ResMut<'w, PathPool>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, crate::game::traffic::TrafficOccupancy>,
    intersections: Res<'w, IntersectionIndex>,
    q_emergencies: Query<'w, 's, (Entity, &'static mut Emergency)>,
    q_stations: Query<'w, 's, (Entity, &'static mut ServiceStation)>,
    q_vehicles: Query<'w, 's, (Entity, &'static mut ServiceVehicle, &'static mut Vehicle)>,
}

/// Dispatch service vehicles to emergencies.
pub(crate) fn dispatch_emergency_vehicles(mut p: DispatchParams) {
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

    for (emergency_entity, mut emergency) in p.q_emergencies.iter_mut() {
        if emergency.resolved || emergency.failed {
            continue;
        }
        if emergency.assigned_vehicle.is_some() {
            continue;
        }

        let required = emergency.kind.required_service();

        let mut best_station: Option<(Entity, usize, TilePos, TilePos)> = None; // (station, dist, station_road, emergency_road)

        for (station_entity, station) in p.q_stations.iter() {
            if station.kind != required {
                continue;
            }
            if station.available_vehicles == 0 {
                continue;
            }

            // GDD 10.5.1: Service buildings without road access cannot dispatch vehicles
            // Check if station building has road access (station.pos should have adjacent road)
            let station_has_road =
                crate::game::services::adjacent_road_any(&p.grid, station.pos).is_some();
            if !station_has_road {
                continue; // Skip stations without road access
            }
            // Prefer lane tiles that match the desired travel direction to avoid picking the wrong carriageway.
            let travel_dir = desired_dir(station.pos, emergency.pos);
            let Some(station_road) =
                pick_reachable_road_endpoint(&p.grid, &p.graph, station.pos, Some(travel_dir))
            else {
                continue;
            };
            let Some(emergency_road) =
                pick_reachable_road_endpoint(&p.grid, &p.graph, emergency.pos, Some(travel_dir))
            else {
                continue;
            };

            let path = find_path_with_fallback(&mut ctx, &p.grid, station_road, emergency_road);
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
        for (vehicle_entity, mut sv, mut vehicle) in p.q_vehicles.iter_mut() {
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
            let from = p
                .path_pool
                .get_tile(vehicle.path_handle, vehicle.path_cursor)
                .unwrap_or(sv.home_road);
            let mut route = find_path_with_fallback(&mut ctx, &p.grid, from, emergency_road);
            if route.is_empty() && from != station_road {
                route = find_path_with_fallback(&mut ctx, &p.grid, station_road, emergency_road);
            }
            // Release old path if any
            p.path_pool.release(vehicle.path_handle);
            vehicle.path_handle = p.path_pool.intern(route);
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

/// Update emergency timers.
/// GDD: Update emergency timers using game hours (decrease by 1 hour per HourAdvanced event)
pub(crate) fn update_emergency_timers(
    mut hour_events: MessageReader<'_, '_, HourAdvanced>,
    mut q: Query<&mut Emergency>,
) {
    let hours_passed = hour_events.read().count() as f32;
    if hours_passed <= 0.0 {
        return;
    }

    for mut e in q.iter_mut() {
        if e.resolved || e.failed {
            continue;
        }
        // Decrease time remaining by game hours (only if not yet responded)
        if !e.responded {
            e.time_remaining -= hours_passed;
            if e.time_remaining < 0.0 {
                e.time_remaining = 0.0;
            }
        }
    }
}

#[derive(SystemParam)]
pub(crate) struct ResolveParams<'w, 's> {
    hour_events: MessageReader<'w, 's, HourAdvanced>,
    commands: Commands<'w, 's>,
    time: Res<'w, Time<bevy::time::Fixed>>,
    grid: Res<'w, MapGrid>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    path_pool: ResMut<'w, PathPool>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, crate::game::traffic::TrafficOccupancy>,
    intersections: Res<'w, IntersectionIndex>,
    notifications: Option<ResMut<'w, Notifications>>,
    q_emergencies: Query<'w, 's, (Entity, &'static mut Emergency)>,
    q_stations: Query<'w, 's, &'static mut ServiceStation>,
    q_vehicles: Query<'w, 's, (Entity, &'static mut ServiceVehicle, &'static mut Vehicle)>,
    manager: ResMut<'w, EmergencyManager>,
}

/// GDD: Resolve emergencies using game hours (progress incremented per game hour)
pub(crate) fn resolve_emergencies(mut p: ResolveParams) {
    let hours_passed = p.hour_events.read().count() as f32;

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
                if vehicle.path_cursor >= p.path_pool.len(vehicle.path_handle) {
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
                // GDD: Resolution progresses in game hours (resolution_time is in game hours)
                if hours_passed > 0.0 {
                    let progress_per_hour = 1.0 / emergency.kind.resolution_time();
                    emergency.resolution_progress += progress_per_hour * hours_passed;
                }
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
                    let route = find_path_with_fallback(&mut ctx, &p.grid, from, to);
                    // Release old path and set new one
                    p.path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = p.path_pool.intern(route);
                    vehicle.path_cursor = 0;

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
                if vehicle.path_cursor >= p.path_pool.len(vehicle.path_handle) {
                    // Back at station.
                    sv.state = ServiceVehicleState::AtStation;
                    sv.mission = None;
                    vehicle.speed = 0.0;
                    // Release old path and create new single-tile path
                    p.path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = p.path_pool.intern(vec![sv.home_road]);
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

/// Apply consequences for failed emergencies.
pub(crate) fn apply_emergency_consequences(
    mut city: ResMut<City>,
    mut q_emergencies: Query<&mut Emergency>,
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

/// Clean up resolved emergencies.
pub(crate) fn cleanup_resolved_emergencies(
    mut commands: Commands,
    q_emergencies: Query<(Entity, &Emergency)>,
) {
    for (e, ev) in q_emergencies.iter() {
        if ev.resolved || ev.failed {
            commands.entity(e).despawn();
        }
    }
}

/// Track emergency index for UI lookups.
pub(crate) fn track_emergency_index(
    mut idx: ResMut<EmergencyEntityIndex>,
    q_added: Query<(Entity, &Emergency), Added<Emergency>>,
    mut removed: RemovedComponents<Emergency>,
) {
    for (e, em) in q_added.iter() {
        idx.insert(em.pos, e);
    }
    for e in removed.read() {
        idx.remove(e);
    }
}
