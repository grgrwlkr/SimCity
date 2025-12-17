//! M3: Traffic simulation – vehicles moving along roads via A* pathfinding.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::prelude::*;

use crate::game::commands::GameCommand;
use crate::game::ids::CitizenId;
use crate::game::map::{MapConfig, MapGrid, TilePos, astar_path};
use crate::game::roads::RoadDir;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RoadGraph, find_road_path_cached,
};
use crate::game::trips::{TripFinished, TripRequested};
use crate::game::ui_state::{OverlayMode, UiState};

/// Vehicle entity – stores route and visual offset.
#[derive(Component)]
pub struct Vehicle {
    /// A* route as list of tile positions (from current towards goal).
    pub route: Vec<TilePos>,
    /// 0 = at start, 1 = at route[0]; interpolated smoothly.
    pub progress: f32,
    /// World units per second.
    pub speed: f32,
}

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
                (spawn_trip_vehicles, move_vehicles)
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
            .add_systems(Update, render_traffic_overlay.in_set(GameSet::RenderSync));
    }
}

#[derive(Resource, Debug, Clone)]
struct TrafficConfig {
    /// Hard cap on active vehicles (debug + trip-driven).
    max_active_vehicles: usize,
    /// Guardrail: max number of route plans performed per tick.
    max_route_plans_per_tick: usize,
    /// EMA decay for heatmap in [0..1). Higher = slower to change.
    heat_ema_decay: f32,
}

impl Default for TrafficConfig {
    fn default() -> Self {
        Self {
            max_active_vehicles: 1500,
            max_route_plans_per_tick: 64,
            heat_ema_decay: 0.92,
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

            let mut rng = thread_rng();

            let mut spawned = 0u32;
            let mut total = p.q_vehicles.iter().count();

            for _ in 0..*count {
                if total >= p.traffic_cfg.max_active_vehicles {
                    break;
                }
                // Pick random start/goal from road tiles.
                let start_i = rng.gen_range(0..roads.len());
                let mut goal_i = rng.gen_range(0..roads.len());
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
                    traffic: &p.traffic,
                    grid: &p.grid,
                };

                let mut route = find_road_path_cached(&mut ctx, start, goal);
                if route.is_empty() {
                    // Fallback: if graph isn't rebuilt yet this frame, use grid-based A*.
                    route = astar_path(&p.grid, start, goal);
                }
                if route.is_empty() {
                    continue;
                }

                let world_pos = tile_to_world(&p.cfg, start);

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
                        speed: 60.0 + rng.gen_range(0.0..40.0),
                    },
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
    traffic: Res<'w, TrafficOccupancy>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
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
            traffic: &p.traffic,
            grid: &p.grid,
        };

        let mut route = find_road_path_cached(&mut ctx, start, goal);
        if route.is_empty() {
            // Fallback: if graph isn't built (or roads changed mid-frame), use grid-based A*.
            route = astar_path(&p.grid, start, goal);
        }
        if route.is_empty() {
            continue;
        }
        let world_pos = tile_to_world(&p.cfg, start);
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
                speed: 70.0,
            },
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
    traffic: Res<'w, TrafficOccupancy>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
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
fn move_vehicles(
    time: Res<Time>,
    cfg: Res<MapConfig>,
    mut commands: Commands,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut q: Query<(Entity, &mut Vehicle, &mut Transform, Option<&TripPassenger>)>,
) {
    for (entity, mut v, mut tf, passenger) in q.iter_mut() {
        if v.route.is_empty() {
            // Arrived – despawn.
            if let Some(p) = passenger {
                finished.write(TripFinished {
                    citizen: p.citizen,
                    purpose: p.purpose,
                });
            }
            commands.entity(entity).despawn();
            continue;
        }

        // Distance to advance this frame.
        let dist = v.speed * time.delta_secs();
        v.progress += dist / cfg.tile_size;

        while v.progress >= 1.0 && !v.route.is_empty() {
            v.progress -= 1.0;
            v.route.remove(0);
        }

        if v.route.is_empty() {
            if let Some(p) = passenger {
                finished.write(TripFinished {
                    citizen: p.citizen,
                    purpose: p.purpose,
                });
            }
            commands.entity(entity).despawn();
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
