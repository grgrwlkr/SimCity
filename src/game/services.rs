//! 5.3 Emergency services foundations (stations + service vehicles).
//!
//! This module defines ECS components and minimal runtime plumbing:
//! - Service stations are represented as `Building` entities with an attached `ServiceStation`
//!   component.
//! - Service vehicles are `Vehicle` entities with an attached `ServiceVehicle` component.
//!   (Traffic movement system must not despawn them when idle.)

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::emergencies::Emergency;
use crate::game::map::{BuildingKind, MapConfig, MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::Vehicle;

pub struct ServicesPlugin;

impl Plugin for ServicesPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            sync_service_stations_from_buildings
                .in_set(GameSet::Sim)
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        )
        .add_systems(
            FixedUpdate,
            park_returned_service_vehicles
                .in_set(GameSet::Sim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Kind of service (which vehicles & emergencies it handles).
#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum ServiceKind {
    Fire,
    Police,
    Medical,
}

impl ServiceKind {
    pub fn from_building(kind: BuildingKind) -> Option<Self> {
        match kind {
            BuildingKind::FireStation => Some(ServiceKind::Fire),
            BuildingKind::PoliceStation => Some(ServiceKind::Police),
            BuildingKind::Hospital => Some(ServiceKind::Medical),
            _ => None,
        }
    }

    pub fn vehicle_color(self) -> Color {
        match self {
            ServiceKind::Fire => Color::srgb(0.9, 0.2, 0.1),
            ServiceKind::Police => Color::srgb(0.1, 0.3, 0.9),
            ServiceKind::Medical => Color::srgb(0.1, 0.8, 0.2),
        }
    }

    pub fn vehicle_speed(self) -> f32 {
        match self {
            ServiceKind::Fire => 90.0,
            ServiceKind::Police => 100.0,
            ServiceKind::Medical => 85.0,
        }
    }
}

/// Marker component for a service station building.
#[allow(dead_code)]
#[derive(Component, Debug, Copy, Clone)]
pub struct ServiceStation {
    pub kind: ServiceKind,
    pub pos: TilePos,
    pub total_vehicles: u8,
    pub available_vehicles: u8,
}

/// Service vehicle state machine (minimal for now; dispatch logic is 5.4+).
#[allow(dead_code)]
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ServiceVehicleState {
    AtStation,
    EnRoute,
    OnScene,
    Returning,
}

/// Service vehicle component (attached to a `Vehicle` entity).
#[allow(dead_code)]
#[derive(Component, Debug)]
pub struct ServiceVehicle {
    pub kind: ServiceKind,
    pub home_station: Entity,
    pub home_road: TilePos,
    pub mission: Option<Entity>,
    pub state: ServiceVehicleState,
}

/// Visual marker component for the colored inner sprite (child entity).
#[allow(dead_code)]
#[derive(Component)]
pub struct ServiceVehicleMarker {
    pub color: Color,
}

fn sync_service_stations_from_buildings(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    q_buildings: Query<(Entity, &Building, Option<&ServiceStation>)>,
) {
    for (entity, b, station) in q_buildings.iter() {
        let Some(kind) = ServiceKind::from_building(b.kind) else {
            continue;
        };
        if station.is_some() {
            continue;
        }

        // Attach station component.
        let total = b.kind.vehicle_capacity();
        commands.entity(entity).insert(ServiceStation {
            kind,
            pos: b.pos,
            total_vehicles: total,
            available_vehicles: total,
        });

        // Spawn parked vehicles (idle at station). They must not be despawned by traffic.
        for _ in 0..total {
            if let Some(start_pos) = adjacent_road_any(&grid, b.pos) {
                spawn_service_vehicle(&mut commands, &cfg, kind, entity, start_pos);
            }
        }
    }
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

fn spawn_service_vehicle(
    commands: &mut Commands,
    cfg: &MapConfig,
    kind: ServiceKind,
    station: Entity,
    start_pos: TilePos,
) -> Entity {
    let world_pos = tile_to_world(cfg, start_pos);
    let outer_size = cfg.tile_size * 0.6;
    let inner_size = cfg.tile_size * 0.3;

    commands
        .spawn((
            Sprite {
                color: Color::srgb(0.95, 0.95, 0.95),
                custom_size: Some(Vec2::splat(outer_size)),
                ..default()
            },
            Transform::from_xyz(world_pos.x, world_pos.y, 12.0),
            Vehicle {
                // Keep a "parked" tile so dispatch can build a route from the correct lane tile.
                // Speed 0 keeps the vehicle stationary.
                route: vec![start_pos],
                progress: 0.0,
                speed: 0.0,
            },
            ServiceVehicle {
                kind,
                home_station: station,
                home_road: start_pos,
                mission: None,
                state: ServiceVehicleState::AtStation,
            },
        ))
        .with_children(|parent| {
            parent.spawn((
                Sprite {
                    color: kind.vehicle_color(),
                    custom_size: Some(Vec2::splat(inner_size)),
                    ..default()
                },
                Transform::from_xyz(0.0, 0.0, 1.0),
                ServiceVehicleMarker {
                    color: kind.vehicle_color(),
                },
            ));
        })
        .id()
}

fn park_returned_service_vehicles(
    mut q_vehicles: Query<(&mut ServiceVehicle, &mut Vehicle)>,
    mut q_stations: Query<&mut ServiceStation>,
    q_emergencies: Query<Entity, With<Emergency>>,
) {
    for (mut sv, mut vehicle) in q_vehicles.iter_mut() {
        // When a service vehicle finishes its route (either returning or due to missing mission),
        // snap it back to "parked at station" so it becomes dispatchable again.
        if sv.state == ServiceVehicleState::AtStation {
            // Ensure a stable parked representation.
            if vehicle.route.is_empty() {
                vehicle.route = vec![sv.home_road];
            }
            vehicle.speed = 0.0;
            continue;
        }

        // If the mission entity is gone (emergency despawned), allow the vehicle to return/park.
        if let Some(mission) = sv.mission
            && q_emergencies.get(mission).is_err()
        {
            sv.mission = None;
            // If we're not actively heading somewhere, treat as returning.
            if matches!(
                sv.state,
                ServiceVehicleState::EnRoute | ServiceVehicleState::OnScene
            ) {
                sv.state = ServiceVehicleState::Returning;
            }
        }

        if !vehicle.route.is_empty() {
            continue;
        }

        // Only park automatically when the vehicle is *returning*.
        // (When it arrives to an emergency, its route becomes empty and it must stay OnScene
        // until resolution completes.)
        if sv.state != ServiceVehicleState::Returning {
            continue;
        }

        sv.state = ServiceVehicleState::AtStation;
        sv.mission = None;
        vehicle.speed = 0.0;
        vehicle.route = vec![sv.home_road];

        if let Ok(mut station) = q_stations.get_mut(sv.home_station) {
            // Return capacity, but don't exceed total.
            station.available_vehicles = station
                .available_vehicles
                .saturating_add(1)
                .min(station.total_vehicles);
        }
    }
}
