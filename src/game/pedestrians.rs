//! Pedestrians (Traffic v2 - Stage E): sidewalk/intersection walking graph + simple agents.

use std::collections::VecDeque;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::{RoadDir, RoadKind};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficConfig;
use crate::game::transport::GraphVersion;
use crate::game::trips::{TripFinished, TripMode, TripRequested};

pub struct PedestriansPlugin;

impl Plugin for PedestriansPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PedestrianConfig>()
            .init_resource::<PedestrianGraph>()
            .add_systems(OnEnter(AppState::MainMenu), cleanup_pedestrians)
            .add_systems(
                Update,
                rebuild_pedestrian_graph
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                FixedUpdate,
                (spawn_walkers, move_walkers)
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct PedestrianConfig {
    /// Base walking speed (m/s). Doc default: 1.4 m/s.
    pub walk_speed_mps: f32,
    /// Max length for a WalkTour (meters). Doc default: 800 m.
    pub walk_tour_max_m: f32,
}

impl Default for PedestrianConfig {
    fn default() -> Self {
        Self {
            walk_speed_mps: 1.4,
            walk_tour_max_m: 800.0,
        }
    }
}

/// Derived walk graph:
/// - walkable sidewalk tiles (non-road tiles adjacent to non-highway roads),
/// - plus intersection tiles (`RoadDir::None`) to allow crossing at intersections.
#[derive(Resource, Debug, Default, Clone)]
pub struct PedestrianGraph {
    pub version: u64,
    pub width: usize,
    pub height: usize,
    walkable: Vec<bool>,
}

impl PedestrianGraph {
    pub fn is_built_for(&self, version: u64) -> bool {
        self.version == version && !self.walkable.is_empty()
    }

    pub fn is_walkable(&self, pos: TilePos) -> bool {
        self.idx(pos)
            .is_some_and(|i| self.walkable.get(i) == Some(&true))
    }

    pub fn shortest_path_steps(&self, start: TilePos, goal: TilePos) -> Option<u32> {
        let (Some(start_i), Some(goal_i)) = (self.idx(start), self.idx(goal)) else {
            return None;
        };
        if !self.walkable.get(start_i).copied().unwrap_or(false)
            || !self.walkable.get(goal_i).copied().unwrap_or(false)
        {
            return None;
        }

        let len = self.walkable.len();
        let mut dist = vec![u32::MAX; len];
        let mut q = VecDeque::new();

        dist[start_i] = 0;
        q.push_back(start_i);

        while let Some(i) = q.pop_front() {
            if i == goal_i {
                return Some(dist[i]);
            }
            let d = dist[i].saturating_add(1);
            for n in self.neighbors_idx(i) {
                if dist[n] != u32::MAX {
                    continue;
                }
                dist[n] = d;
                q.push_back(n);
            }
        }

        None
    }

    pub fn shortest_path(&self, start: TilePos, goal: TilePos) -> Vec<TilePos> {
        let (Some(start_i), Some(goal_i)) = (self.idx(start), self.idx(goal)) else {
            return Vec::new();
        };
        if !self.walkable.get(start_i).copied().unwrap_or(false)
            || !self.walkable.get(goal_i).copied().unwrap_or(false)
        {
            return Vec::new();
        }

        let len = self.walkable.len();
        let mut prev: Vec<Option<usize>> = vec![None; len];
        let mut q = VecDeque::new();

        prev[start_i] = Some(start_i);
        q.push_back(start_i);

        while let Some(i) = q.pop_front() {
            if i == goal_i {
                break;
            }
            for n in self.neighbors_idx(i) {
                if prev[n].is_some() {
                    continue;
                }
                prev[n] = Some(i);
                q.push_back(n);
            }
        }

        if prev[goal_i].is_none() {
            return Vec::new();
        }

        let mut out = Vec::<TilePos>::new();
        let mut cur = goal_i;
        loop {
            out.push(self.pos(cur));
            if cur == start_i {
                break;
            }
            cur = prev[cur].unwrap_or(start_i);
        }
        out.reverse();
        out
    }

    fn idx(&self, pos: TilePos) -> Option<usize> {
        if pos.x < 0 || pos.y < 0 {
            return None;
        }
        let x = pos.x as usize;
        let y = pos.y as usize;
        if x >= self.width || y >= self.height {
            return None;
        }
        Some(y * self.width + x)
    }

    fn pos(&self, idx: usize) -> TilePos {
        let x = (idx % self.width) as i32;
        let y = (idx / self.width) as i32;
        TilePos { x, y }
    }

    fn neighbors_idx(&self, idx: usize) -> [usize; 4] {
        let x = idx % self.width;
        let y = idx / self.width;

        let mut out = [idx; 4];
        let mut n = 0usize;

        let try_push = |out: &mut [usize; 4], n: &mut usize, i: usize, ok: bool| {
            if ok && *n < 4 {
                out[*n] = i;
                *n += 1;
            }
        };

        if x > 0 {
            let i = idx - 1;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }
        if x + 1 < self.width {
            let i = idx + 1;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }
        if y > 0 {
            let i = idx - self.width;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }
        if y + 1 < self.height {
            let i = idx + self.width;
            try_push(&mut out, &mut n, i, self.walkable.get(i) == Some(&true));
        }

        out
    }
}

fn cleanup_pedestrians(mut commands: Commands, q: Query<Entity, With<Pedestrian>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}

fn rebuild_pedestrian_graph(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut graph: ResMut<PedestrianGraph>,
) {
    if graph.is_built_for(gv.0) && graph.width == grid.width.max(0) as usize {
        return;
    }

    graph.version = gv.0;
    graph.width = grid.width.max(0) as usize;
    graph.height = grid.height.max(0) as usize;

    let len = grid.len();
    graph.walkable.clear();
    graph.walkable.resize(len, false);

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                continue;
            }

            let walk = if cell.road.is_some() {
                cell.road.dir == RoadDir::None
            } else {
                is_sidewalk_tile(&grid, pos)
            };
            if walk && let Some(i) = grid.idx(pos) {
                graph.walkable[i] = true;
            }
        }
    }
}

fn is_sidewalk_tile(grid: &MapGrid, pos: TilePos) -> bool {
    // Sidewalk tiles exist next to roads that "provide sidewalk" (i.e. not SixLane lane tiles).
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
        if let Some(ncell) = grid.get(npos)
            && !ncell.water
            && road_provides_sidewalk(ncell.road)
        {
            return true;
        }
    }
    false
}

fn road_provides_sidewalk(road: crate::game::roads::RoadCell) -> bool {
    if !road.is_some() {
        return false;
    }
    if road.dir == RoadDir::None {
        return true;
    }
    // Highways: no sidewalks along segments (but intersections are still walkable via dir=None tiles).
    road.kind != RoadKind::SixLane
}

#[derive(Component, Debug, Clone)]
struct WalkTripPassenger {
    citizen: crate::game::ids::CitizenId,
    purpose: crate::game::trips::TripPurpose,
}

/// Current pedestrian tile (for other systems to observe pedestrian position without peeking into
/// the internal route state).
#[derive(Component, Debug, Copy, Clone, Eq, PartialEq)]
pub struct PedestrianTile(pub TilePos);

#[derive(Component, Debug, Clone)]
pub struct Pedestrian {
    route: Vec<TilePos>,
    route_idx: usize,
    progress: f32,
    speed_world: f32,
}

#[derive(SystemParam)]
struct SpawnWalkersParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    traffic_cfg: Res<'w, TrafficConfig>,
    ped_cfg: Res<'w, PedestrianConfig>,
    graph: Res<'w, PedestrianGraph>,
}

fn spawn_walkers(
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

        let route = p.graph.shortest_path(start, goal);
        if route.is_empty() {
            continue;
        }
        let start_tile = route[0];

        let tile_meters = p.traffic_cfg.tile_meters().max(0.1);
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
fn move_walkers(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    intersections: Option<Res<crate::game::intersections::IntersectionIndex>>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
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

        let seg_len = cfg.tile_size.max(0.001);
        let b = ped.route[ped.route_idx + 1];

        // If we're about to enter an intersection tile controlled by a traffic light,
        // only start crossing when the current phase allows this pedestrian direction.
        if is_intersection_tile(&grid, b)
            && let Some(intersections) = intersections.as_deref()
            && let Some(id) = intersections.intersection_id_at(b)
            && intersections.traffic_lights.contains(&id)
            && let Some(light) = lights_by_id.get(&id)
        {
            let dir = dir_between_adjacent(a, b);
            if !ped_can_enter_intersection(dir, light) {
                // Wait at the curb.
                ped.progress = 0.0;
                let world = tile_to_world(&cfg, a);
                tf.translation.x = world.x;
                tf.translation.y = world.y;
                continue;
            }
        }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::intersections::{
        IntersectionId, IntersectionIndex, IntersectionKey, LightPhase,
    };
    use std::time::Duration;

    #[test]
    fn pedestrian_waits_for_allowed_phase_before_entering_intersection() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<TripFinished>()
            .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
            .insert_resource(MapConfig {
                width: 3,
                height: 3,
                tile_size: 16.0,
            })
            .insert_resource({
                let mut grid = MapGrid::new(3, 3);
                let intersection_tile = TilePos { x: 1, y: 1 };
                if let Some(mut cell) = grid.get(intersection_tile) {
                    cell.road = crate::game::roads::RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::None,
                        lane: 0,
                        flow: crate::game::roads::RoadFlow::TwoWay,
                        lane_type: crate::game::roads::LaneType::Regular,
                    };
                    grid.set(intersection_tile, cell);
                }
                grid
            })
            .insert_resource({
                let intersection_tile = TilePos { x: 1, y: 1 };
                let id = IntersectionId(0);
                let key = IntersectionKey {
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    tile_count: 1,
                    tiles_hash: 123,
                };
                let mut idx = IntersectionIndex::default();
                idx.tile_to_intersection.insert(intersection_tile, id);
                idx.traffic_lights.insert(id);
                idx.clusters
                    .push(crate::game::intersections::IntersectionCluster {
                        id,
                        key,
                        tiles: vec![intersection_tile],
                        aabb_min: intersection_tile,
                        aabb_max: intersection_tile,
                        centroid_tile: intersection_tile,
                    });
                idx
            })
            .add_systems(Update, move_walkers);

        let intersection_tile = TilePos { x: 1, y: 1 };
        let id = app
            .world()
            .resource::<IntersectionIndex>()
            .intersection_id_at(intersection_tile)
            .unwrap();
        let key = app
            .world()
            .resource::<IntersectionIndex>()
            .cluster_key_at(intersection_tile)
            .unwrap();

        // Phase blocks N/S walking.
        let light_entity = app
            .world_mut()
            .spawn(crate::game::intersections::TrafficLight {
                intersection_id: id,
                intersection_key: key,
                pos: intersection_tile,
                phase: LightPhase::EastWestGreen,
                phase_timer: 10.0,
                green_duration: 10.0,
                yellow_duration: 3.0,
                all_red_duration: 1.0,
            })
            .id();

        let a = TilePos { x: 1, y: 0 };
        let b = intersection_tile;
        let c = TilePos { x: 1, y: 2 };

        let ped = app
            .world_mut()
            .spawn((
                Pedestrian {
                    route: vec![a, b, c],
                    route_idx: 0,
                    progress: 0.0,
                    // Ensure it would enter the intersection in a single tick if allowed, but not
                    // finish the whole route and despawn.
                    speed_world: 240.0,
                },
                PedestrianTile(a),
                Transform::default(),
                WalkTripPassenger {
                    citizen: crate::game::ids::CitizenId(1),
                    purpose: crate::game::trips::TripPurpose::Work,
                },
            ))
            .id();

        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();

        assert_eq!(
            app.world().get::<PedestrianTile>(ped).copied(),
            Some(PedestrianTile(a))
        );

        // Switch to NS green: walking north is allowed now.
        app.world_mut()
            .entity_mut(light_entity)
            .get_mut::<crate::game::intersections::TrafficLight>()
            .unwrap()
            .phase = LightPhase::NorthSouthGreen;

        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();

        assert_eq!(
            app.world().get::<PedestrianTile>(ped).copied(),
            Some(PedestrianTile(intersection_tile))
        );
    }
}
