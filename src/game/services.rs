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
use crate::game::traffic::{Vehicle, VehicleTrafficState};
use crate::game::ui_state::{OverlayMode, UiState};

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
        )
        .init_resource::<ServiceCoverageIndex>()
        .add_systems(
            FixedUpdate,
            compute_service_coverage_index
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        )
        .add_systems(
            Update,
            render_service_coverage_overlay
                .in_set(GameSet::RenderSync)
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
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

/// Derived read model: how many zoned buildings are covered by services.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct ServiceCoverageIndex {
    pub fire: f32,    // 0..1
    pub police: f32,  // 0..1
    pub medical: f32, // 0..1
    pub buildings_total: u32,
}

impl ServiceCoverageIndex {
    pub fn overall(self) -> f32 {
        if self.buildings_total == 0 {
            return 0.0;
        }
        ((self.fire + self.police + self.medical) / 3.0).clamp(0.0, 1.0)
    }
}

#[derive(Component)]
struct ServiceCoverageOverlayTile;

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

pub(crate) fn adjacent_road_any(grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
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

pub(crate) fn spawn_service_vehicle(
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
                max_speed: kind.vehicle_speed(),
                max_accel: 25.0,
            },
            VehicleTrafficState::FreeFlow,
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

fn compute_service_coverage_index(grid: Res<MapGrid>, mut out: ResMut<ServiceCoverageIndex>) {
    let mut buildings = Vec::<TilePos>::new();
    let mut fire = Vec::<TilePos>::new();
    let mut police = Vec::<TilePos>::new();
    let mut medical = Vec::<TilePos>::new();

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                continue;
            }

            match cell.building {
                Some(
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial,
                ) => {
                    buildings.push(pos);
                }
                Some(BuildingKind::FireStation) => fire.push(pos),
                Some(BuildingKind::PoliceStation) => police.push(pos),
                Some(BuildingKind::Hospital) => medical.push(pos),
                None => {}
            }
        }
    }

    let total = buildings.len() as u32;
    if total == 0 {
        *out = ServiceCoverageIndex::default();
        return;
    }

    let ratio = |stations: &[TilePos], radius: i32| -> f32 {
        if stations.is_empty() || radius <= 0 {
            return 0.0;
        }
        let mut covered = 0u32;
        for bpos in buildings.iter().copied() {
            if stations
                .iter()
                .copied()
                .any(|spos| (bpos.x - spos.x).abs() + (bpos.y - spos.y).abs() <= radius)
            {
                covered += 1;
            }
        }
        (covered as f32) / (total as f32)
    };

    let fire_r = BuildingKind::FireStation.service_radius().unwrap_or(0) as i32;
    let police_r = BuildingKind::PoliceStation.service_radius().unwrap_or(0) as i32;
    let medical_r = BuildingKind::Hospital.service_radius().unwrap_or(0) as i32;

    *out = ServiceCoverageIndex {
        fire: ratio(&fire, fire_r),
        police: ratio(&police, police_r),
        medical: ratio(&medical, medical_r),
        buildings_total: total,
    };
}

fn render_service_coverage_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    q_stations: Query<&ServiceStation>,
    q_buildings: Query<&Building>,
    mut commands: Commands,
    existing: Query<Entity, With<ServiceCoverageOverlayTile>>,
) {
    // Clear old overlay.
    for e in existing.iter() {
        commands.entity(e).despawn();
    }

    if ui.overlay != OverlayMode::ServiceCoverage {
        return;
    }

    // Collect stations with radius.
    let mut stations: Vec<(ServiceKind, TilePos, i32)> = Vec::new();
    for s in q_stations.iter() {
        // Find building kind at station position to get radius.
        let mut radius = None;
        for b in q_buildings.iter() {
            if b.pos == s.pos {
                radius = b.kind.service_radius().map(|r| r as i32);
                break;
            }
        }
        let Some(r) = radius else {
            continue;
        };
        stations.push((s.kind, s.pos, r));
    }

    let origin = map_origin(&cfg);

    // Helper to convert tile -> world.
    let to_world = |pos: TilePos| -> Vec2 {
        origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
    };

    // For each tile, mark uncovered zoned tiles red and render soft coverage tint.
    // (MVP approach; optimized later if needed.)
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else { continue };
            if cell.water {
                continue;
            }

            let mut covered = false;
            let mut cover_color: Option<Color> = None;
            for (kind, spos, radius) in stations.iter().copied() {
                let d = (pos.x - spos.x).abs() + (pos.y - spos.y).abs();
                if d <= radius {
                    covered = true;
                    // tint by last station kind (good enough for MVP)
                    cover_color = Some(match kind {
                        ServiceKind::Fire => Color::srgba(0.9, 0.2, 0.1, 0.06),
                        ServiceKind::Police => Color::srgba(0.1, 0.3, 0.9, 0.06),
                        ServiceKind::Medical => Color::srgba(0.1, 0.8, 0.2, 0.06),
                    });
                }
            }

            // Overlay coverage tint.
            if let Some(c) = cover_color {
                let wpos = to_world(pos);
                commands.spawn((
                    ServiceCoverageOverlayTile,
                    Sprite {
                        color: c,
                        custom_size: Some(Vec2::splat(cfg.tile_size)),
                        ..default()
                    },
                    Transform::from_xyz(wpos.x, wpos.y, 4.0),
                ));
            }

            // Mark zoned tiles without coverage.
            if cell.zone != crate::game::map::ZoneKind::None && !covered {
                let wpos = to_world(pos);
                commands.spawn((
                    ServiceCoverageOverlayTile,
                    Sprite {
                        color: Color::srgba(0.9, 0.1, 0.1, 0.25),
                        custom_size: Some(Vec2::splat(cfg.tile_size)),
                        ..default()
                    },
                    Transform::from_xyz(wpos.x, wpos.y, 4.2),
                ));
            }
        }
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}
