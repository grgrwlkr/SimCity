use super::*;
use crate::game::transport::PathPool;

pub(super) fn spawn_trip_vehicles(
    mut reader: bevy::ecs::message::MessageReader<TripRequested>,
    mut p: SpawnTripVehiclesParams,
) {
    let mut planned = 0usize;
    let mut total = p
        .vehicle_counts
        .as_deref()
        .map(|c| c.active as usize)
        .unwrap_or_else(|| p.q_vehicles.iter().count());
    let idm = idm_params_world(&p.cfg, &p.traffic_cfg);
    // Driver maximum (km/h). Actual speed is capped by per-road speed limits in `move_vehicles`.
    let driver_max_speed_world = kmh_to_world_speed(&p.cfg, &p.traffic_cfg, 130.0);
    // If the network is already gridlocked, stop spawning new cars until it clears.
    let congested = p.traffic_idx.max_congestion >= SPAWN_THROTTLE_MAX_CONG
        || p.traffic_idx.avg_congestion >= SPAWN_THROTTLE_AVG_CONG;
    for msg in reader.read() {
        // Walk trips are handled by `PedestriansPlugin`.
        if msg.mode == TripMode::Walk {
            continue;
        }
        if planned >= p.traffic_cfg.max_route_plans_per_tick {
            break;
        }
        if msg.mode == TripMode::Car && congested {
            break;
        }
        if msg.mode == TripMode::Car && total >= p.traffic_cfg.max_active_vehicles {
            break;
        }
        // CarTour "no car from pocket": if this is a car trip, spawn the vehicle near the
        // citizen's currently parked car location (building tile), not necessarily `from`.
        let mut spawn_from = msg.from;
        if msg.mode == TripMode::Car
            && let Some(at) = msg.car_parked_at
        {
            spawn_from = at;
        }

        let Some(start) = adjacent_road_towards(&p.grid, spawn_from, msg.to) else {
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

        // Public transport (MVP): mode is chosen by citizens (tour-based).
        if msg.mode == TripMode::Transit
            && let (Some(pt), Some(pt_cfg), Some(pending)) =
                (p.pt.as_deref(), p.pt_cfg.as_deref(), p.pt_pending.as_mut())
            && pt.stops.contains(&start)
            && pt.stops.contains(&goal)
        {
            let dist_world = (route.len() as f32) * p.cfg.tile_size;
            let travel_secs = (dist_world / pt_cfg.bus_speed.max(1.0)) + pt_cfg.wait_secs.max(0.0);
            pending.trips.push(PendingTrip {
                citizen: msg.citizen,
                purpose: msg.purpose,
                remaining_secs: travel_secs,
            });
            planned += 1;
            continue;
        }
        // If `mode == Transit` but transit isn't possible, fall through and spawn a car so the trip
        // can still complete.

        // CarTour Variant B: if the citizen already has a parked car entity, re-use it.
        if msg.mode == TripMode::Car {
            let mut reused = false;

            // Fast path: O(1) lookup by citizen id (when index is present).
            let mut reuse_e = p
                .car_owner_index
                .as_deref()
                .and_then(|idx| idx.by_citizen.get(&msg.citizen).copied());

            // Fallback: linear scan (mostly for minimal tests where the index isn't present).
            if reuse_e.is_none() {
                for (e, owner, ..) in p.q_parked_cars.iter_mut() {
                    if owner.citizen == msg.citizen {
                        reuse_e = Some(e);
                        break;
                    }
                }
            }

            if let Some(e) = reuse_e
                && let Ok((_e, _owner, mut v, mut tf, mut sprite)) = p.q_parked_cars.get_mut(e)
            {
                let world_pos = tile_to_world(&p.cfg, start);
                // Release old path if any
                p.path_pool.release(v.path_handle);
                v.path_handle = p.path_pool.intern(route);
                v.path_cursor = 0;
                v.progress = 0.0;
                v.speed = 0.0;
                v.max_speed = driver_max_speed_world;
                v.max_accel = idm.a;

                tf.translation.x = world_pos.x;
                tf.translation.y = world_pos.y;
                tf.translation.z = 10.0;

                // Restore "active vehicle" visuals (parked vehicles are smaller + translucent).
                sprite.custom_size = Some(Vec2::splat(p.cfg.tile_size * VEHICLE_VISUAL_SIZE_TILES));
                sprite.color = Color::linear_rgb(0.95, 0.95, 0.95);

                p.commands
                    .entity(e)
                    .remove::<Parked>()
                    .remove::<RightTurnOnRed>()
                    .insert((
                        VehicleTrafficState::FreeFlow,
                        TripPassenger {
                            citizen: msg.citizen,
                            purpose: msg.purpose,
                        },
                    ));
                planned += 1;
                total += 1;
                reused = true;
            }
            if reused {
                continue;
            }
        }

        let world_pos = tile_to_world(&p.cfg, start);
        let mut e = p.commands.spawn((
            Sprite {
                color: Color::linear_rgb(0.95, 0.95, 0.95),
                custom_size: Some(Vec2::splat(p.cfg.tile_size * VEHICLE_VISUAL_SIZE_TILES)),
                ..default()
            },
            Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
            Vehicle {
                path_handle: p.path_pool.intern(route),
                path_cursor: 0,
                progress: 0.0,
                speed: 0.0,
                max_speed: driver_max_speed_world,
                max_accel: idm.a,
            },
            VehicleTrafficState::FreeFlow,
            TripPassenger {
                citizen: msg.citizen,
                purpose: msg.purpose,
            },
        ));
        if msg.mode == TripMode::Car {
            e.insert(CarOwner {
                citizen: msg.citizen,
            });
        }
        planned += 1;
        total += 1;
    }
}

#[derive(SystemParam)]
pub(super) struct SpawnTripVehiclesParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    time: Res<'w, Time<bevy::time::Fixed>>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, TrafficOccupancy>,
    traffic_idx: Res<'w, TrafficIndex>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    path_pool: ResMut<'w, PathPool>,
    intersections: Res<'w, IntersectionIndex>,
    pt_cfg: Option<Res<'w, PublicTransportConfig>>,
    pt: Option<Res<'w, PublicTransportIndex>>,
    pt_pending: Option<ResMut<'w, PendingTransitTrips>>,
    car_owner_index: Option<Res<'w, CarOwnerIndex>>,
    vehicle_counts: Option<Res<'w, TrafficVehicleCounts>>,
    q_vehicles: Query<'w, 's, Entity, (With<Vehicle>, Without<Parked>)>,
    q_parked_cars: Query<
        'w,
        's,
        (
            Entity,
            &'static CarOwner,
            &'static mut Vehicle,
            &'static mut Transform,
            &'static mut Sprite,
        ),
        With<Parked>,
    >,
    traffic_cfg: Res<'w, TrafficConfig>,
}

/// Despawn all vehicles when GameCommand::GenerateMap is received.
#[allow(clippy::too_many_arguments)]
pub(super) fn clear_vehicles(
    mut reader: bevy::ecs::message::MessageReader<GameCommand>,
    mut commands: Commands,
    q_vehicles: Query<Entity, With<Vehicle>>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
    mut reservations: ResMut<IntersectionReservations>,
    mut car_owner_index: ResMut<CarOwnerIndex>,
    mut counts: ResMut<TrafficVehicleCounts>,
) {
    for msg in reader.read() {
        if matches!(msg, GameCommand::GenerateMap { .. }) {
            for entity in q_vehicles.iter() {
                commands.entity(entity).despawn();
            }
            // C) Traffic: reset derived aggregates when regenerating map.
            occ.per_tick_vehicles.clear();
            occ.touched.clear();
            occ.ema_scaled.clear();
            occ.ema_global = 1.0;
            occ.max_scaled = 0.0;
            *idx = TrafficIndex::default();
            reservations.by_intersection.clear();
            car_owner_index.clear();
            *counts = TrafficVehicleCounts::default();
        }
    }
}
