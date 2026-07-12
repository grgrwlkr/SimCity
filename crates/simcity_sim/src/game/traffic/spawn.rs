use super::*;
use crate::game::transport::lanelet::pathfinding::find_route;
use crate::game::transport::{LaneCostCtx, LaneGraph, LaneId, LaneletGraph, PathPool};
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

        // Per-trip-instance tie-break seed, drawn fresh from SimRng for every spawned trip.
        // MUST remain per-trip (not keyed to OD pair): if all vehicles sharing the same
        // origin+destination got the same seed, they would pick the identical route and
        // within-OD spread would collapse (Rank-4 regression: one corridor saturates).
        let jitter_seed: u64 = p.sim_rng.rng.random_range(1..=u64::MAX);

        // Lane-level lanelet-aware routing. Returns the Vec<TilePos> route plus a lanelet sidecar;
        // an empty route triggers the road-A* fallback.
        let (lane_tiles, lanelet_plan) = if let (Some(lg), true) = (
            p.lane_graph.as_ref(),
            start_lane != LaneId::INVALID && goal_lane != LaneId::INVALID,
        ) {
            let lane_ctx = LaneCostCtx {
                grid: &p.grid,
                traffic: &p.traffic,
                cfg: &p.path_cfg,
                jitter_seed,
            };
            let empty_llg = LaneletGraph::default();
            let llg = p.lanelet_graph.as_deref().unwrap_or(&empty_llg);
            find_route(lg, llg, &lane_ctx, start_lane, goal_lane)
        } else {
            (Vec::new(), Vec::new())
        };

        let used_road_fallback = lane_tiles.is_empty();
        let route = if lane_tiles.is_empty() {
            // Road-A* fallback when no lane route exists (degenerate maps / missing lane endpoints).
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
            find_road_path_cached(&mut ctx, start, goal)
        } else {
            lane_tiles
        };

        // Direction guard (insurance), same as every other non-lanelet producer: road-A* is
        // structurally dir-correct by graph construction, but the interned fallback must satisfy
        // the same invariant as every hand-built route. A refusal drops this trip request —
        // exactly like the empty-route case below (no route means no vehicle).
        let route = if used_road_fallback && !route_direction_ok(&route, &p.grid) {
            p.producer_stats.guard_refusals += 1;
            Vec::new()
        } else {
            route
        };

        // No fallback to astar_path - vehicles must follow lane rules.
        if route.is_empty() {
            continue;
        }
        if used_road_fallback {
            p.producer_stats.spawn_road_fallback += 1;
        } else {
            p.producer_stats.spawn_lanelet += 1;
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
                && let Ok((_e, _owner, mut v, mut tf, mut mat)) = p.q_parked_cars.get_mut(e)
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
                tf.translation.z = crate::game::render_primitives::layer::VEHICLE;

                // Restore "active vehicle" visuals (parked vehicles are shrunk + translucent).
                tf.scale = Vec3::ONE;
                mat.0 = p
                    .prims
                    .material(&mut p.materials, citizen_car_color(msg.citizen));

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
                        VehicleLaneletPlan {
                            entries: lanelet_plan.clone(),
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

        let body_color = citizen_car_color(msg.citizen);
        let car_size = Vec2::new(
            p.cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES,
            p.cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES,
        );
        let mut e = p.commands.spawn((
            Mesh3d(p.prims.car_mesh(&mut p.meshes, car_size)),
            MeshMaterial3d(p.prims.material(&mut p.materials, body_color)),
            Transform::from_xyz(
                world_pos.x,
                world_pos.y,
                crate::game::render_primitives::layer::VEHICLE,
            ),
            Vehicle {
                is_reversing: false,
                path_handle: p.path_pool.intern(route),
                path_cursor: 0,
                progress: 0.0,
                tile_pos: start,
                speed: 0.0,
                max_speed,
                speed_factor,
                max_accel: idm.a,
                prev_world_pos: world_pos,
                curr_world_pos: world_pos,
            },
            VehicleTrafficState::FreeFlow,
            TripPassenger {
                citizen: msg.citizen,
                purpose: msg.purpose,
            },
            VehicleLaneletPlan {
                entries: lanelet_plan,
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
#[allow(clippy::type_complexity)]
pub(super) struct SpawnTripVehiclesParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    time: Res<'w, Time<bevy::time::Fixed>>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    lane_graph: Option<Res<'w, LaneGraph>>,
    lanelet_graph: Option<Res<'w, LaneletGraph>>,
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
            &'static mut MeshMaterial3d<StandardMaterial>,
        ),
        With<Parked>,
    >,
    traffic_cfg: Res<'w, TrafficConfig>,
    sim_rng: bevy::prelude::ResMut<'w, crate::game::sim::SimRng>,
    producer_stats: ResMut<'w, RouteProducerStats>,
    prims: ResMut<'w, crate::game::render_primitives::RenderPrimitives>,
    materials: ResMut<'w, Assets<StandardMaterial>>,
    meshes: ResMut<'w, Assets<Mesh>>,
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

/// Deterministic body color per citizen (no randomness — determinism pin).
fn citizen_car_color(citizen: crate::game::ids::CitizenId) -> Color {
    const CAR_COLORS: [Color; 5] = [
        Color::srgb(0.93, 0.93, 0.95),
        Color::srgb(0.72, 0.75, 0.80),
        Color::srgb(0.72, 0.22, 0.18),
        Color::srgb(0.28, 0.42, 0.72),
        Color::srgb(0.24, 0.26, 0.31),
    ];
    CAR_COLORS[(citizen.0 % CAR_COLORS.len() as u64) as usize]
}
