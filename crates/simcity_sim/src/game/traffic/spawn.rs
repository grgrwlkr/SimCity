use super::*;
use crate::game::transport::{LaneGraph, LaneId, PathPool, VehicleId};
use rand::{Rng, RngExt};

fn sample_non_medium_driver_speed_factor(rng: &mut impl Rng) -> f32 {
    loop {
        let sampled = rng.random_range(DRIVER_PROFILE_FACTOR_MIN..DRIVER_PROFILE_FACTOR_MAX);
        if (sampled - DRIVER_PROFILE_MEDIUM_FACTOR).abs() > f32::EPSILON {
            return sampled;
        }
    }
}

fn sample_driver_speed_factor(rng: &mut impl Rng) -> f32 {
    if rng.random_bool(DRIVER_PROFILE_MEDIUM_SHARE as f64) {
        return DRIVER_PROFILE_MEDIUM_FACTOR;
    }
    sample_non_medium_driver_speed_factor(rng)
}

/// Samples per-driver max speed in world units. Variation (90–130 km/h) ensures visible
/// speed differences even on highways where road limits are high.
fn sample_driver_max_speed_world(
    cfg: &crate::game::map::MapConfig,
    traffic_cfg: &TrafficConfig,
    rng: &mut impl Rng,
) -> f32 {
    let kmh = rng.random_range(DRIVER_MAX_SPEED_KMH_MIN..=DRIVER_MAX_SPEED_KMH_MAX);
    kmh_to_world_speed(cfg, traffic_cfg, kmh)
}

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

        // LANE-BASED PATHFINDING: Find start and goal lanes
        let start_cell = p.grid.get(start).unwrap();
        let travel_dir = start_cell.road.dir;
        let start_lane = p
            .lane_graph
            .as_ref()
            .and_then(|lg| lg.get_rightmost_lane(start, travel_dir))
            .unwrap_or(LaneId::INVALID);

        let goal_cell = p.grid.get(goal).unwrap();
        let goal_lane = p
            .lane_graph
            .as_ref()
            .and_then(|lg| lg.get_rightmost_lane(goal, goal_cell.road.dir))
            .unwrap_or(LaneId::INVALID);

        // Use lane-based pathfinding if LaneGraph is available
        let lane_path = if let (Some(lg), true) = (
            p.lane_graph.as_ref(),
            start_lane != LaneId::INVALID && goal_lane != LaneId::INVALID,
        ) {
            crate::game::transport::find_lane_path(lg, start_lane, goal_lane)
        } else {
            Vec::new()
        };

        // Convert lane path to tile path for backward compatibility
        let route = if lane_path.is_empty() {
            // Fallback to tile-based pathfinding
            let mut ctx = PathfindingCtx {
                time_now_sec: p.time.elapsed_secs_f64(),
                cfg: &p.path_cfg,
                cache: &mut p.path_cache,
                graph: &p.graph,
                regions: Some(&p.regions),
                traffic: &p.traffic,
                grid: &p.grid,
                intersections: &p.intersections,
                max_iterations: None,
            };
            find_road_path_cached(&mut ctx, start, goal)
        } else if let Some(lg) = p.lane_graph.as_ref() {
            crate::game::transport::lane_path_to_tiles(&lane_path, lg)
        } else {
            Vec::new()
        };

        // No fallback to astar_path - vehicles must follow lane rules.
        if route.is_empty() {
            continue;
        }

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
                v.path_handle = p.path_pool.intern(route.clone());
                v.path_cursor = 0;
                v.progress = 0.0;
                v.speed = 0.0;
                v.max_speed =
                    sample_driver_max_speed_world(&p.cfg, &p.traffic_cfg, &mut p.sim_rng.rng);
                // Driver behavior is trip-bound: sample a fresh profile for each new trip.
                v.speed_factor = sample_driver_speed_factor(&mut p.sim_rng.rng);
                v.max_accel = idm.a;

                tf.translation.x = world_pos.x;
                tf.translation.y = world_pos.y;
                tf.translation.z = 10.0;

                // Restore "active vehicle" visuals (parked vehicles are smaller + translucent).
                // Use rectangular sprite: length (along travel direction) x width (perpendicular)
                sprite.custom_size = Some(Vec2::new(
                    p.cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES,
                    p.cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES,
                ));
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
        let speed_factor = sample_driver_speed_factor(&mut p.sim_rng.rng);
        let max_speed = sample_driver_max_speed_world(&p.cfg, &p.traffic_cfg, &mut p.sim_rng.rng);

        // Get the start lane for lane-based navigation
        let start_lane = if start_lane != LaneId::INVALID {
            start_lane
        } else {
            p.lane_graph
                .as_ref()
                .and_then(|lg| lg.get_rightmost_lane(start, travel_dir))
                .unwrap_or(LaneId::INVALID)
        };

        let mut e = p.commands.spawn((
            Sprite {
                color: Color::linear_rgb(0.95, 0.95, 0.95),
                custom_size: Some(Vec2::new(
                    p.cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES,
                    p.cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES,
                )),
                ..default()
            },
            Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
            Vehicle {
                is_reversing: false,
                reverse_distance: 0.0,
                path_handle: p.path_pool.intern(route),
                path_cursor: 0,
                progress: 0.0,
                lane_id: start_lane, // ← LANE-BASED: Set correct lane!
                lane_s: 0.0,
                vehicle_id: VehicleId::INVALID,
                tile_pos: start,
                speed: 0.0,
                max_speed,
                speed_factor,
                max_accel: idm.a,
                prev_world_pos: world_pos,
                curr_world_pos: world_pos,
                last_update_time: 0.0, // Will be set by first update
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
    lane_graph: Option<Res<'w, LaneGraph>>,
    traffic: Res<'w, TrafficOccupancy>,
    traffic_idx: Res<'w, TrafficIndex>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    path_pool: ResMut<'w, PathPool>,
    intersections: Res<'w, IntersectionIndex>,
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
    sim_rng: bevy::prelude::ResMut<'w, crate::game::sim::SimRng>,
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
