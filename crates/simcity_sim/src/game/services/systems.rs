use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::buildings::any_footprint_tile;
use crate::game::emergencies::Emergency;
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::traffic::{Parked, Vehicle, VehicleTrafficState};

use super::components::{
    ServiceKind, ServiceStation, ServiceVehicle, ServiceVehicleMarker, ServiceVehicleState,
};

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_service_stations_from_buildings(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    mut path_pool: ResMut<crate::game::transport::PathPool>,
    q_buildings: Query<(Entity, &Building, Option<&ServiceStation>)>,
    mut prims: ResMut<crate::game::render_primitives::RenderPrimitives>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (entity, b, station) in q_buildings.iter() {
        let Some(kind) = ServiceKind::from_building(b.kind) else {
            continue;
        };
        if (station as Option<&ServiceStation>).is_some() {
            continue;
        }

        // GDD 10.5.1: Service buildings must have road access to function
        let has_road_access = any_footprint_tile(
            b.anchor_pos,
            b.footprint_width,
            b.footprint_length,
            |tile| adjacent_road_any(&grid, tile).is_some(),
        );

        // Only create station if building has road access
        if !has_road_access {
            continue;
        }

        // Attach station component.
        let total = b.kind.vehicle_capacity();
        commands.entity(entity).insert(ServiceStation {
            kind,
            pos: b.anchor_pos,
            total_vehicles: total,
            available_vehicles: total,
        });

        // Spawn parked vehicles (idle at station). They must not be despawned by traffic.
        for _ in 0..total {
            if let Some(start_pos) = adjacent_road_any(&grid, b.anchor_pos) {
                spawn_service_vehicle(
                    &mut commands,
                    &cfg,
                    &mut path_pool,
                    kind,
                    entity,
                    start_pos,
                    &mut prims,
                    &mut meshes,
                    &mut materials,
                );
            }
        }
    }
}

pub fn adjacent_road_any(grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
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

use crate::game::map::tile_to_world;

#[allow(clippy::too_many_arguments)]
pub fn spawn_service_vehicle(
    commands: &mut Commands,
    cfg: &MapConfig,
    path_pool: &mut ResMut<crate::game::transport::PathPool>,
    kind: ServiceKind,
    station: Entity,
    start_pos: TilePos,
    prims: &mut crate::game::render_primitives::RenderPrimitives,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
) -> Entity {
    let world_pos = tile_to_world(cfg, start_pos);
    let glyph_quad = prims.quad.clone();
    let glyph_mat = prims.material(materials, super::glyphs::GLYPH_COLOR);

    commands
        .spawn((
            // Car-shaped body in the kind's color (was a white 0.5 square + colored dot).
            crate::game::public_transport::car_body_quad(
                prims,
                meshes,
                materials,
                cfg,
                kind.vehicle_color(),
            ),
            Transform::from_xyz(
                world_pos.x,
                world_pos.y,
                crate::game::render_primitives::layer::SERVICE_VEHICLE,
            ),
            Vehicle {
                is_reversing: false,
                // Keep a "parked" tile so dispatch can build a route from the correct lane tile.
                // Speed 0 keeps the vehicle stationary.
                path_handle: path_pool.intern(vec![start_pos]),
                path_cursor: 0,
                progress: 0.0,
                tile_pos: start_pos,
                speed: 0.0,
                max_speed: kind.vehicle_speed(),
                // Actual overspeed behavior is applied in traffic movement for ServiceVehicle.
                speed_factor: 1.0,
                max_accel: 25.0,
                prev_world_pos: Vec2::ZERO,
                curr_world_pos: Vec2::ZERO,
            },
            VehicleTrafficState::FreeFlow,
            crate::game::traffic::VehicleLaneletPlan {
                entries: Vec::new(),
            },
            ServiceVehicle {
                kind,
                home_station: station,
                home_road: start_pos,
                mission: None,
                state: ServiceVehicleState::AtStation,
            },
            // Start parked - offset to the side of the road
            Parked { offset: 1.0 },
        ))
        .with_children(|parent| {
            // Kind-specific roof glyph (cross / badge / ladder) — reads as "official vehicle" AND
            // tells the service apart at a glance. The first glyph child carries
            // VehicleRoofMarker + ServiceVehicleMarker (exactly one per vehicle — the soak
            // harness counts ServiceVehicleMarker as the service-vehicle count).
            super::glyphs::spawn_service_glyph(
                parent,
                kind,
                cfg.tile_size * 0.35,
                crate::game::render_primitives::layer::CAR_ROOF,
                glyph_quad,
                glyph_mat,
                |first| {
                    first.insert((
                        crate::game::public_transport::VehicleRoofMarker,
                        ServiceVehicleMarker,
                    ));
                },
            );
        })
        .id()
}

pub(crate) fn park_returned_service_vehicles(
    mut commands: Commands,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &mut Vehicle, Option<&Parked>)>,
    mut q_stations: Query<&mut ServiceStation>,
    q_emergencies: Query<Entity, With<Emergency>>,
    mut path_pool: ResMut<crate::game::transport::PathPool>,
) {
    for (entity, mut sv, mut vehicle, parked) in q_vehicles.iter_mut() {
        // When a service vehicle finishes its route (either returning or due to missing mission),
        // snap it back to "parked at station" so it becomes dispatchable again.
        if sv.state == ServiceVehicleState::AtStation {
            // Ensure a stable parked representation.
            if path_pool.len(vehicle.path_handle) == 0
                || vehicle.path_cursor >= path_pool.len(vehicle.path_handle)
            {
                let route = vec![sv.home_road];
                path_pool.release(vehicle.path_handle);
                vehicle.path_handle = path_pool.intern(route);
                vehicle.path_cursor = 0;
            }
            vehicle.speed = 0.0;
            // Ensure parked component is present
            if parked.is_none() {
                commands.entity(entity).insert(Parked { offset: 1.0 });
            }
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

        if vehicle.path_cursor < path_pool.len(vehicle.path_handle) {
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
        let route = vec![sv.home_road];
        path_pool.release(vehicle.path_handle);
        vehicle.path_handle = path_pool.intern(route);
        vehicle.path_cursor = 0;

        // Add parked component - vehicle is now parked at station
        commands.entity(entity).insert(Parked { offset: 1.0 });

        if let Ok(mut station) = q_stations.get_mut(sv.home_station) {
            // Return capacity, but don't exceed total.
            station.available_vehicles = station
                .available_vehicles
                .saturating_add(1)
                .min(station.total_vehicles);
        }
    }
}

#[cfg(test)]
mod visual_tests {
    use super::*;
    use crate::game::map::{MapConfig, TilePos};
    use crate::game::render_primitives::RenderPrimitives;
    use crate::game::traffic::{VEHICLE_VISUAL_LENGTH_TILES, VEHICLE_VISUAL_WIDTH_TILES};

    fn setup(
        mut commands: Commands,
        cfg: Res<MapConfig>,
        mut pool: ResMut<crate::game::transport::PathPool>,
        mut prims: ResMut<RenderPrimitives>,
        mut meshes: ResMut<Assets<Mesh>>,
        mut materials: ResMut<Assets<StandardMaterial>>,
    ) {
        let station = commands.spawn_empty().id();
        spawn_service_vehicle(
            &mut commands,
            &cfg,
            &mut pool,
            ServiceKind::Fire,
            station,
            TilePos { x: 2, y: 2 },
            &mut prims,
            &mut meshes,
            &mut materials,
        );
    }

    #[test]
    fn service_vehicle_renders_as_colored_car_not_dot() {
        let mut app = App::new();
        app.insert_resource(MapConfig {
            width: 8,
            height: 8,
            tile_size: 16.0,
        })
        .insert_resource(crate::game::transport::PathPool::default())
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>();
        let quad = app
            .world_mut()
            .resource_mut::<Assets<Mesh>>()
            .add(Rectangle::new(1.0, 1.0));
        app.insert_resource(RenderPrimitives::for_test(quad));
        app.add_systems(Startup, setup);
        app.update();

        // The parent (the ServiceVehicle entity) carries the car-shaped body quad:
        // a SIZED mesh (scale = 1) so child glyphs don't inherit a squash.
        let mut q = app
            .world_mut()
            .query_filtered::<(&Mesh3d, &MeshMaterial3d<StandardMaterial>, &Transform), With<ServiceVehicle>>();
        let (mesh, mat, tf) = q
            .iter(app.world())
            .next()
            .expect("a service vehicle spawned");
        let (mesh, mat, scale) = (mesh.0.clone(), mat.0.clone(), tf.scale);
        let expect = Vec2::new(
            16.0 * VEHICLE_VISUAL_LENGTH_TILES,
            16.0 * VEHICLE_VISUAL_WIDTH_TILES,
        );
        // Contract: the body is the shared volumetric car mesh for the car
        // dimensions (scale stays 1 so glyph children don't inherit a squash).
        let expected_mesh =
            app.world_mut()
                .resource_scope(|world, mut prims: Mut<RenderPrimitives>| {
                    let mut meshes = world.resource_mut::<Assets<Mesh>>();
                    prims.car_mesh(&mut meshes, expect)
                });
        assert_eq!(
            mesh, expected_mesh,
            "service body must be the shared volumetric car mesh"
        );
        assert_eq!(
            scale,
            Vec3::ONE,
            "car body uses a sized mesh, scale must stay 1 for the glyph children"
        );
        let material = app
            .world()
            .resource::<Assets<StandardMaterial>>()
            .get(&mat)
            .expect("body material exists");
        // Cache quantizes to 8-bit RGBA — compare within one quantum.
        let (a, b) = (
            material.base_color.to_srgba(),
            ServiceKind::Fire.vehicle_color().to_srgba(),
        );
        assert!(
            (a.red - b.red).abs() < 1.5 / 255.0
                && (a.green - b.green).abs() < 1.5 / 255.0
                && (a.blue - b.blue).abs() < 1.5 / 255.0,
            "service body keeps its kind color (got {a:?}, want {b:?})"
        );
    }
}
