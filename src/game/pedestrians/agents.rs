use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::traffic::{IntersectionReservations, Parked, TrafficConfig, Vehicle};
use crate::game::trips::{TripFinished, TripMode, TripRequested};

use super::config::PedestrianConfig;
use super::graph::PedestrianGraph;
use super::routing::PedestrianRoutingScratch;

#[derive(Component, Debug, Clone)]
pub(crate) struct WalkTripPassenger {
    pub(crate) citizen: crate::game::ids::CitizenId,
    pub(crate) purpose: crate::game::trips::TripPurpose,
}

/// Current pedestrian tile (for other systems to observe pedestrian position without peeking into
/// the internal route state).
#[derive(Component, Debug, Copy, Clone, Eq, PartialEq)]
pub struct PedestrianTile(pub TilePos);

/// While present, indicates the pedestrian is currently crossing an intersection and which
/// *axis* their movement uses. This is used by vehicle admission to yield to pedestrians for
/// conflicting turn maneuvers without blocking the whole intersection.
#[derive(Component, Debug, Copy, Clone, Eq, PartialEq)]
pub struct PedestrianCrossing {
    pub intersection_id: crate::game::intersections::IntersectionId,
    /// True if pedestrian movement is along North/South (crossing the E-W roadway),
    /// false if along East/West (crossing the N-S roadway).
    pub axis_ns: bool,
}

#[derive(Component, Debug, Clone)]
pub struct Pedestrian {
    pub(crate) route: Vec<TilePos>,
    pub(crate) route_idx: usize,
    pub(crate) progress: f32,
    pub(crate) speed_world: f32,
    pub(crate) goal: TilePos,
    pub(crate) wait_blocked_secs: f32,
    pub(crate) reroute_attempts: u8,
}

pub(crate) fn cleanup_pedestrians(mut commands: Commands, q: Query<Entity, With<Pedestrian>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}

#[derive(SystemParam)]
pub(super) struct SpawnWalkersParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    traffic_cfg: Res<'w, TrafficConfig>,
    ped_cfg: Res<'w, PedestrianConfig>,
    graph: Res<'w, PedestrianGraph>,
    routing: ResMut<'w, PedestrianRoutingScratch>,
}

pub(super) fn spawn_walkers(
    mut reader: bevy::ecs::message::MessageReader<TripRequested>,
    mut p: SpawnWalkersParams,
) {
    for msg in reader.read() {
        if msg.mode != TripMode::Walk {
            continue;
        }

        let Some(start) = nearest_walkable(&p.graph, &p.grid, msg.from) else {
            continue;
        };
        let Some(goal) = nearest_walkable(&p.graph, &p.grid, msg.to) else {
            continue;
        };

        let tile_meters = p.traffic_cfg.tile_meters().max(0.1);
        let max_m = p.ped_cfg.walk_tour_max_m.max(0.0);
        let max_steps = ((max_m / tile_meters).ceil().min(4096.0)) as u32;
        let Some(route) = p
            .routing
            .shortest_path_bounded(&p.graph, start, goal, max_steps)
        else {
            continue;
        };
        let start_tile = route[0];
        let goal_tile = *route.last().unwrap_or(&start_tile);

        let speed_world = (p.ped_cfg.walk_speed_mps.max(0.1) * p.cfg.tile_size) / tile_meters;

        let world = tile_to_world(&p.cfg, start_tile);
        p.commands.spawn((
            Sprite::from_color(
                Color::srgb(0.95, 0.55, 0.10),
                Vec2::splat(p.cfg.tile_size * 0.20),
            ),
            Transform::from_xyz(world.x, world.y, 12.0),
            Pedestrian {
                route,
                route_idx: 0,
                progress: 0.0,
                speed_world,
                goal: goal_tile,
                wait_blocked_secs: 0.0,
                reroute_attempts: 0,
            },
            PedestrianTile(start_tile),
            WalkTripPassenger {
                citizen: msg.citizen,
                purpose: msg.purpose,
            },
        ));
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn move_walkers(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    ped_cfg: Res<PedestrianConfig>,
    traffic_cfg: Res<TrafficConfig>,
    intersections: Option<Res<crate::game::intersections::IntersectionIndex>>,
    reservations: Option<Res<IntersectionReservations>>,
    q_vehicles: Query<(Entity, &Vehicle), Without<Parked>>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    graph: Res<PedestrianGraph>,
    mut routing: ResMut<PedestrianRoutingScratch>,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut commands: Commands,
    mut q: Query<(
        Entity,
        &mut Pedestrian,
        &mut PedestrianTile,
        &mut Transform,
        &WalkTripPassenger,
    )>,
) {
    let dt = time.delta_secs();
    if dt <= 0.0 {
        return;
    }

    let tile_meters = traffic_cfg.tile_meters().max(0.1);
    let max_m = ped_cfg.walk_tour_max_m.max(0.0);
    let max_steps = ((max_m / tile_meters).ceil().min(4096.0)) as u32;

    // Build a small lookup of controllers by intersection id.
    let mut lights_by_id = std::collections::HashMap::<
        crate::game::intersections::IntersectionId,
        crate::game::intersections::TrafficLight,
    >::new();
    for l in q_lights.iter() {
        lights_by_id.insert(l.intersection_id, l.clone());
    }

    for (e, mut ped, mut ped_tile, mut tf, passenger) in q.iter_mut() {
        if ped.route_idx + 1 >= ped.route.len() {
            finished.write(TripFinished {
                citizen: passenger.citizen,
                purpose: passenger.purpose,
            });
            commands.entity(e).despawn();
            continue;
        }

        let a = ped.route[ped.route_idx];
        *ped_tile = PedestrianTile(a);
        // Remove crossing marker when outside intersection.
        if !is_intersection_tile(&grid, a) {
            commands.entity(e).remove::<PedestrianCrossing>();
        }

        let seg_len = cfg.tile_size.max(0.001);
        let b = ped.route[ped.route_idx + 1];

        let mut blocked = false;
        let mut reroute_avoid: Option<TilePos> = None;

        // If we're about to ENTER an intersection tile controlled by a traffic light,
        // only start crossing when the current phase allows this pedestrian direction.
        //
        // If we're already inside the intersection cluster (`a` is an intersection tile),
        // always allow continuing so we never strand a pedestrian mid-crossing.
        if is_intersection_tile(&grid, b)
            && !is_intersection_tile(&grid, a)
            && let Some(intersections) = intersections.as_deref()
            && let Some(id) = intersections.intersection_id_at(b)
            && intersections.traffic_lights.contains(&id)
            && let Some(light) = lights_by_id.get(&id)
        {
            let dir = dir_between_adjacent(a, b);
            if !ped_can_enter_intersection(dir, light) {
                blocked = true;
            }
        } else if is_intersection_tile(&grid, b) && !is_intersection_tile(&grid, a) {
            // Uncontrolled intersection: wait for a safe window.
            if let Some(intersections) = intersections.as_deref()
                && let Some(id) = intersections.intersection_id_at(b)
                && !intersections.traffic_lights.contains(&id)
                && !ped_can_enter_uncontrolled(
                    id,
                    b,
                    reservations.as_deref(),
                    ped.speed_world,
                    &cfg,
                    &ped_cfg,
                    &q_vehicles,
                )
            {
                blocked = true;
                reroute_avoid = Some(b);
            }
        }

        if blocked {
            // Wait at the curb.
            ped.progress = 0.0;
            ped.wait_blocked_secs = (ped.wait_blocked_secs + dt).min(10_000.0);

            // Reroute if stuck too long at an uncontrolled crossing.
            if let Some(avoid) = reroute_avoid
                && ped.wait_blocked_secs >= ped_cfg.wait_reroute_secs.max(0.0)
                && ped.reroute_attempts < ped_cfg.wait_reroute_max_attempts
            {
                ped.wait_blocked_secs = 0.0;
                ped.reroute_attempts = ped.reroute_attempts.saturating_add(1);

                // Attempt 1: avoid the blocked intersection tile only.
                // Attempt 2+: avoid all uncontrolled intersections to prefer signalized crossings.
                let prefer_signalized = ped.reroute_attempts >= 2;
                let mut new_route =
                    routing.shortest_path_avoid_bounded(&graph, a, ped.goal, avoid, max_steps);
                if prefer_signalized
                    && new_route.is_none()
                    && let Some(intersections) = intersections.as_deref()
                {
                    new_route = routing.shortest_path_blocked_bounded(
                        &graph,
                        a,
                        ped.goal,
                        max_steps,
                        |p| {
                            if p == avoid {
                                return true;
                            }
                            if !is_intersection_tile(&grid, p) {
                                return false;
                            }
                            let Some(id) = intersections.intersection_id_at(p) else {
                                return false;
                            };
                            !intersections.traffic_lights.contains(&id)
                        },
                    );
                }

                if let Some(new_route) = new_route {
                    ped.route = new_route;
                    ped.route_idx = 0;
                    ped.progress = 0.0;
                    *ped_tile = PedestrianTile(a);
                }
            }

            let world = tile_to_world(&cfg, a);
            tf.translation.x = world.x;
            tf.translation.y = world.y;
            continue;
        }

        // If we are about to enter an intersection tile, mark the crossing axis for other systems.
        if is_intersection_tile(&grid, b)
            && !is_intersection_tile(&grid, a)
            && let Some(intersections) = intersections.as_deref()
            && let Some(id) = intersections.intersection_id_at(b)
        {
            let dir = dir_between_adjacent(a, b);
            let axis_ns = matches!(dir, RoadDir::North | RoadDir::South);
            commands.entity(e).insert(PedestrianCrossing {
                intersection_id: id,
                axis_ns,
            });
        }

        // Reset wait timer once we're moving.
        ped.wait_blocked_secs = 0.0;

        ped.progress += (ped.speed_world * dt) / seg_len;

        while ped.progress >= 1.0 && ped.route_idx + 1 < ped.route.len() {
            ped.progress -= 1.0;
            ped.route_idx += 1;
        }

        if ped.route_idx + 1 >= ped.route.len() {
            let world = tile_to_world(&cfg, *ped.route.last().unwrap_or(&a));
            tf.translation.x = world.x;
            tf.translation.y = world.y;
            finished.write(TripFinished {
                citizen: passenger.citizen,
                purpose: passenger.purpose,
            });
            commands.entity(e).despawn();
            continue;
        }

        let a = ped.route[ped.route_idx];
        let b = ped.route[ped.route_idx + 1];
        *ped_tile = PedestrianTile(a);
        let aw = tile_to_world(&cfg, a);
        let bw = tile_to_world(&cfg, b);
        let world = aw.lerp(bw, ped.progress.clamp(0.0, 1.0));
        tf.translation.x = world.x;
        tf.translation.y = world.y;
    }
}

fn is_intersection_tile(grid: &MapGrid, pos: TilePos) -> bool {
    if let Some(c) = grid.get(pos)
        && c.road.is_some()
    {
        c.road.dir == RoadDir::None
    } else {
        false
    }
}

fn dir_between_adjacent(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    match (dx, dy) {
        (1, 0) => RoadDir::East,
        (-1, 0) => RoadDir::West,
        (0, 1) => RoadDir::North,
        (0, -1) => RoadDir::South,
        _ => RoadDir::None,
    }
}

fn ped_can_enter_intersection(
    dir: RoadDir,
    light: &crate::game::intersections::TrafficLight,
) -> bool {
    match dir {
        // Walking north/south means crossing the E-W roadway, which is safe when N-S traffic has green.
        RoadDir::North | RoadDir::South => {
            light.phase == crate::game::intersections::LightPhase::NorthSouthGreen
        }
        // Walking east/west means crossing the N-S roadway, which is safe when E-W traffic has green.
        RoadDir::East | RoadDir::West => {
            light.phase == crate::game::intersections::LightPhase::EastWestGreen
        }
        RoadDir::None => false,
    }
}

fn ped_can_enter_uncontrolled(
    id: crate::game::intersections::IntersectionId,
    intersection_tile: TilePos,
    reservations: Option<&IntersectionReservations>,
    ped_speed_world: f32,
    cfg: &MapConfig,
    ped_cfg: &PedestrianConfig,
    q_vehicles: &Query<(Entity, &Vehicle), Without<Parked>>,
) -> bool {
    // If any vehicle holds a reservation for this intersection, do not enter.
    if let Some(res) = reservations
        && res.is_reserved(id)
    {
        return false;
    }

    // If a vehicle is about to enter this intersection, do not enter unless there's enough time.
    for (_e, v) in q_vehicles.iter() {
        if v.route.len() < 2 {
            continue;
        }
        if v.route[1] != intersection_tile {
            continue;
        }
        let dist_to_entry_tiles = (1.0 - v.progress).clamp(0.0, 1.0);

        // Fallback guardrail: extremely close -> don't step in.
        if dist_to_entry_tiles <= ped_cfg.uncontrolled_min_gap_tiles.max(0.0) {
            return false;
        }

        // Time-to-entry vs time-to-cross check (doc: wait for a safe window).
        let v_speed = v.speed.max(0.0);
        if v_speed > 0.1 {
            let tile_size = cfg.tile_size.max(0.001);
            let dist_world = dist_to_entry_tiles * tile_size;
            let t_entry = dist_world / v_speed;

            let t_cross = tile_size / ped_speed_world.max(0.1);
            let safety_margin = ped_cfg.uncontrolled_safety_margin_secs.max(0.0);
            if t_entry <= t_cross + safety_margin {
                return false;
            }
        }
    }

    true
}

fn nearest_walkable(graph: &PedestrianGraph, grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
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
            && graph.is_walkable(cpos)
        {
            return Some(cpos);
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
