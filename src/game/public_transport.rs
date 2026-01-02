//! 6.2.4 Public transport (MVP).
//!
//! Minimal implementation goals:
//! - Derive a set of "bus stops" from the current city (road tiles adjacent to zoned buildings).
//! - Allow trips to be satisfied by public transport (no per-citizen car spawned).
//! - Spawn a single visual bus that shuttles between two stops.

use std::collections::HashSet;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;

use crate::game::intersections::IntersectionIndex;
use crate::game::map::{BuildingKind, MapConfig, MapGrid, TilePos};
use crate::game::transport::{LaneId, VehicleId};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::{TrafficOccupancy, Vehicle, VehicleTrafficState};
use crate::game::transport::{
    PathCache, PathPool, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    find_road_path_cached,
};
use crate::game::trips::TripFinished;
use crate::game::ui_state::UiState;

pub struct PublicTransportPlugin;

impl Plugin for PublicTransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PublicTransportConfig>()
            .init_resource::<PublicTransportIndex>()
            .init_resource::<PendingTransitTrips>()
            .add_systems(
                FixedUpdate,
                (
                    compute_public_transport_index,
                    tick_pending_transit_trips,
                    sync_bus_vehicle,
                )
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct PublicTransportConfig {
    /// Probability a trip uses transit when possible.
    pub adoption_rate: f32,
    /// Simulated wait time (seconds) added to each transit trip.
    pub wait_secs: f32,
    /// Visual bus speed (world units per second).
    pub bus_speed: f32,
    /// If true, spawn a single visual bus vehicle (MVP/debug). Disabled by default to avoid
    /// confusing it with regular traffic.
    #[serde(default = "default_show_bus")]
    pub show_bus: bool,
}

fn default_show_bus() -> bool {
    false
}

impl Default for PublicTransportConfig {
    fn default() -> Self {
        Self {
            adoption_rate: 0.6,
            wait_secs: 2.0,
            // Calibrated for traffic v2 scale (RoadKind speed limits treated as km/h).
            bus_speed: 24.0,
            show_bus: default_show_bus(),
        }
    }
}

#[derive(Resource, Debug, Default)]
pub struct PublicTransportIndex {
    /// Road tiles that are considered bus stops.
    pub stops: HashSet<TilePos>,
    /// Two endpoints for the MVP shuttle bus.
    pub shuttle_a: Option<TilePos>,
    pub shuttle_b: Option<TilePos>,
}

#[derive(Resource, Debug, Default)]
pub struct PendingTransitTrips {
    pub trips: Vec<PendingTrip>,
}

#[derive(Debug, Copy, Clone)]
pub struct PendingTrip {
    pub citizen: crate::game::ids::CitizenId,
    pub purpose: crate::game::trips::TripPurpose,
    pub remaining_secs: f32,
}

/// Marker for the single MVP bus vehicle.
#[derive(Component, Debug, Copy, Clone)]
pub struct BusVehicle {
    pub a: TilePos,
    pub b: TilePos,
    pub to_b: bool,
}

fn compute_public_transport_index(grid: Res<MapGrid>, mut idx: ResMut<PublicTransportIndex>) {
    // Derive stops from zoned buildings: any adjacent road tile becomes a stop.
    let mut stops = HashSet::<TilePos>::new();
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                continue;
            }
            let Some(kind) = cell.building else {
                continue;
            };
            if !matches!(
                kind,
                BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
            ) {
                continue;
            }
            for stop in adjacent_roads(&grid, pos) {
                stops.insert(stop);
            }
        }
    }

    // Pick two endpoints for a simple shuttle (first stop + farthest).
    let (a, b) = if stops.len() >= 2 {
        let mut it = stops.iter().copied();
        let a = it.next();
        let a = a.unwrap();
        let mut best = None;
        let mut best_d = -1i32;
        for p in stops.iter().copied() {
            let d = (p.x - a.x).abs() + (p.y - a.y).abs();
            if d > best_d {
                best_d = d;
                best = Some(p);
            }
        }
        (Some(a), best)
    } else {
        (None, None)
    };

    idx.stops = stops;
    idx.shuttle_a = a;
    idx.shuttle_b = b;
}

fn tick_pending_transit_trips(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    mut pending: ResMut<PendingTransitTrips>,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed.clamp(0.0, 8.0);

    let mut i = 0usize;
    while i < pending.trips.len() {
        let mut t = pending.trips[i];
        t.remaining_secs -= dt;
        if t.remaining_secs <= 0.0 {
            finished.write(TripFinished {
                citizen: t.citizen,
                purpose: t.purpose,
            });
            pending.trips.swap_remove(i);
            continue;
        }
        pending.trips[i] = t;
        i += 1;
    }
}

#[derive(SystemParam)]
struct BusParams<'w, 's> {
    cfg: Res<'w, MapConfig>,
    grid: Res<'w, MapGrid>,
    time: Res<'w, Time<Fixed>>,
    traffic: Res<'w, TrafficOccupancy>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    path_pool: ResMut<'w, PathPool>,
    intersections: Res<'w, IntersectionIndex>,
    pt_cfg: Res<'w, PublicTransportConfig>,
    pt: Res<'w, PublicTransportIndex>,
    commands: Commands<'w, 's>,
    q_bus: Query<'w, 's, (Entity, &'static mut Vehicle, &'static mut BusVehicle)>,
}

fn sync_bus_vehicle(mut p: BusParams) {
    // Visual bus is optional (MVP/debug). If disabled, ensure no bus entity exists.
    if !p.pt_cfg.show_bus {
        for (e, _, _) in p.q_bus.iter() {
            p.commands.entity(e).despawn();
        }
        return;
    }

    let (Some(a), Some(b)) = (p.pt.shuttle_a, p.pt.shuttle_b) else {
        // No network: despawn bus if it exists.
        for (e, _, _) in p.q_bus.iter() {
            p.commands.entity(e).despawn();
        }
        return;
    };

    // Ensure there is exactly one bus.
    let mut bus_entity: Option<Entity> = None;
    for (e, _, _) in p.q_bus.iter() {
        if bus_entity.is_none() {
            bus_entity = Some(e);
        } else {
            p.commands.entity(e).despawn();
        }
    }

    let mut plan_route = |from: TilePos, to: TilePos| -> Vec<TilePos> {
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
        find_road_path_cached(&mut ctx, from, to)
    };

    match bus_entity {
        None => {
            let route = plan_route(a, b);
            if route.is_empty() {
                return;
            }
            let world = tile_to_world(&p.cfg, a);
            p.commands.spawn((
                Sprite::from_color(
                    Color::srgb(0.95, 0.85, 0.10),
                    Vec2::splat(p.cfg.tile_size * 0.75),
                ),
                Transform::from_xyz(world.x, world.y, 11.0),
                Vehicle {
                    path_handle: p.path_pool.intern(route),
                    path_cursor: 0,
                    progress: 0.0,
                    lane_id: LaneId::INVALID,
                    lane_s: 0.0,
                    vehicle_id: VehicleId::INVALID,
                    tile_pos: TilePos { x: 0, y: 0 },
                    speed: p.pt_cfg.bus_speed,
                    max_speed: p.pt_cfg.bus_speed,
                    max_accel: 20.0,
                    prev_world_pos: Vec2::ZERO,
                    curr_world_pos: Vec2::ZERO,
                    last_update_time: 0.0,
                },
                VehicleTrafficState::FreeFlow,
                BusVehicle { a, b, to_b: true },
            ));
        }
        Some(e) => {
            let Ok((_, mut v, mut bv)) = p.q_bus.get_mut(e) else {
                return;
            };
            if bv.a != a || bv.b != b {
                bv.a = a;
                bv.b = b;
                bv.to_b = true;
                // Release old path and set new one
                p.path_pool.release(v.path_handle);
                v.path_handle = p.path_pool.intern(plan_route(a, b));
                v.path_cursor = 0;
                v.progress = 0.0;
                v.speed = p.pt_cfg.bus_speed;
                return;
            }

            // When the route is finished, we arrived to an endpoint; plan the return leg.
            if p.path_pool.len(v.path_handle) == 0
                || v.path_cursor >= p.path_pool.len(v.path_handle)
            {
                if bv.to_b {
                    bv.to_b = false;
                    // Release old path and set new one
                    p.path_pool.release(v.path_handle);
                    v.path_handle = p.path_pool.intern(plan_route(b, a));
                } else {
                    bv.to_b = true;
                    // Release old path and set new one
                    p.path_pool.release(v.path_handle);
                    v.path_handle = p.path_pool.intern(plan_route(a, b));
                }
                v.path_cursor = 0;
                v.progress = 0.0;
                v.speed = p.pt_cfg.bus_speed;
            }
        }
    }
}

/// Find any adjacent road tile (4-neighborhood).
fn adjacent_roads(grid: &MapGrid, pos: TilePos) -> impl Iterator<Item = TilePos> + '_ {
    [
        TilePos { x: pos.x, y: pos.y },
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
    ]
    .into_iter()
    .filter(|&npos| {
        grid.get(npos)
            .is_some_and(|cell| !cell.water && cell.road.is_some())
    })
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
