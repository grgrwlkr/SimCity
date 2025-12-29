//! Pedestrians (Traffic v2 - Stage E): sidewalk/intersection walking graph + simple agents.

use std::collections::VecDeque;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::{RoadDir, RoadKind};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::{IntersectionReservations, Parked, TrafficConfig, Vehicle};
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
    /// If a pedestrian is blocked at an uncontrolled crossing for this long, reroute.
    pub wait_reroute_secs: f32,
    /// Max number of reroute attempts for a single pedestrian.
    pub wait_reroute_max_attempts: u8,
    /// Uncontrolled crossing: additional safety margin added to time-to-cross window.
    pub uncontrolled_safety_margin_secs: f32,
    /// Uncontrolled crossing: hard minimum gap to a vehicle entering the intersection (tiles).
    pub uncontrolled_min_gap_tiles: f32,
}

impl Default for PedestrianConfig {
    fn default() -> Self {
        Self {
            walk_speed_mps: 1.4,
            walk_tour_max_m: 800.0,
            wait_reroute_secs: 60.0,
            wait_reroute_max_attempts: 3,
            uncontrolled_safety_margin_secs: 0.5,
            uncontrolled_min_gap_tiles: 0.35,
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

    /// Returns a shortest path, but treats `avoid` as blocked (even if walkable).
    pub fn shortest_path_avoid(
        &self,
        start: TilePos,
        goal: TilePos,
        avoid: TilePos,
    ) -> Option<Vec<TilePos>> {
        self.shortest_path_blocked(start, goal, |p| p == avoid)
    }

    /// Returns a shortest path while treating any `blocked(pos) == true` tile as impassable.
    pub fn shortest_path_blocked(
        &self,
        start: TilePos,
        goal: TilePos,
        mut blocked: impl FnMut(TilePos) -> bool,
    ) -> Option<Vec<TilePos>> {
        if blocked(start) || blocked(goal) {
            return None;
        }

        let (Some(start_i), Some(goal_i)) = (self.idx(start), self.idx(goal)) else {
            return None;
        };

        if !self.walkable.get(start_i).copied().unwrap_or(false)
            || !self.walkable.get(goal_i).copied().unwrap_or(false)
        {
            return None;
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
                let p = self.pos(n);
                if blocked(p) {
                    continue;
                }
                prev[n] = Some(i);
                q.push_back(n);
            }
        }

        prev[goal_i]?;

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
        Some(out)
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
                // "Corner" nodes: allow standing/walking right next to intersection clusters
                // even when the adjacent road is a SixLane highway. This enables crossing highways
                // at intersections while still preventing walking along highway segments.
                is_corner_near_intersection(&grid, pos) || is_sidewalk_tile(&grid, pos)
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

fn is_corner_near_intersection(grid: &MapGrid, pos: TilePos) -> bool {
    // If a non-road tile is directly adjacent to an intersection tile (dir=None),
    // treat it as walkable "corner" space.
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
            && ncell.road.is_some()
            && ncell.road.dir == RoadDir::None
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
    goal: TilePos,
    wait_blocked_secs: f32,
    reroute_attempts: u8,
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
        let goal_tile = *route.last().unwrap_or(&start_tile);

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
fn move_walkers(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    ped_cfg: Res<PedestrianConfig>,
    intersections: Option<Res<crate::game::intersections::IntersectionIndex>>,
    reservations: Option<Res<IntersectionReservations>>,
    q_vehicles: Query<(Entity, &Vehicle), Without<Parked>>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    graph: Res<PedestrianGraph>,
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
                let mut new_route = graph.shortest_path_avoid(a, ped.goal, avoid);
                if prefer_signalized
                    && new_route.is_none()
                    && let Some(intersections) = intersections.as_deref()
                {
                    new_route = graph.shortest_path_blocked(a, ped.goal, |p| {
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
                    });
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
            .insert_resource(PedestrianConfig::default())
            .insert_resource(PedestrianGraph {
                version: 0,
                width: 3,
                height: 3,
                walkable: vec![true; 9],
            })
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
                    goal: c,
                    wait_blocked_secs: 0.0,
                    reroute_attempts: 0,
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

    #[test]
    fn pedestrian_waits_for_safe_gap_on_uncontrolled_intersection() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<TripFinished>()
            .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
            .insert_resource(PedestrianConfig::default())
            .insert_resource(PedestrianGraph {
                version: 0,
                width: 3,
                height: 3,
                walkable: vec![true; 9],
            })
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
            .insert_resource(IntersectionReservations::default())
            .add_systems(Update, move_walkers);

        let a = TilePos { x: 1, y: 0 };
        let intersection_tile = TilePos { x: 1, y: 1 };
        let c = TilePos { x: 1, y: 2 };

        // Vehicle is very close to entering: blocks pedestrian.
        let veh = app
            .world_mut()
            .spawn((
                Vehicle {
                    route: vec![a, intersection_tile, c],
                    progress: 0.9,
                    speed: 5.0,
                    max_speed: 60.0,
                    max_accel: 20.0,
                },
                crate::game::traffic::VehicleTrafficState::FreeFlow,
            ))
            .id();

        let ped = app
            .world_mut()
            .spawn((
                Pedestrian {
                    route: vec![a, intersection_tile, c],
                    route_idx: 0,
                    progress: 0.0,
                    speed_world: 240.0,
                    goal: c,
                    wait_blocked_secs: 0.0,
                    reroute_attempts: 0,
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

        // Remove vehicle: now safe to enter.
        app.world_mut().entity_mut(veh).despawn();

        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();
        assert_eq!(
            app.world().get::<PedestrianTile>(ped).copied(),
            Some(PedestrianTile(intersection_tile))
        );
    }

    #[test]
    fn pedestrian_can_finish_crossing_inside_signalized_intersection_after_phase_changes() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<TripFinished>()
            .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
            .insert_resource(PedestrianConfig::default())
            .insert_resource(PedestrianGraph {
                version: 0,
                width: 3,
                height: 4,
                walkable: vec![true; 12],
            })
            .insert_resource(MapConfig {
                width: 3,
                height: 4,
                tile_size: 16.0,
            })
            .insert_resource({
                let mut grid = MapGrid::new(3, 4);
                // Two-tile intersection cluster at (1,1) and (1,2).
                for p in [TilePos { x: 1, y: 1 }, TilePos { x: 1, y: 2 }] {
                    if let Some(mut cell) = grid.get(p) {
                        cell.road = crate::game::roads::RoadCell {
                            kind: RoadKind::TwoLane,
                            dir: RoadDir::None,
                            lane: 0,
                            flow: crate::game::roads::RoadFlow::TwoWay,
                            lane_type: crate::game::roads::LaneType::Regular,
                        };
                        grid.set(p, cell);
                    }
                }
                grid
            })
            .insert_resource({
                let id = IntersectionId(0);
                let key = IntersectionKey {
                    aabb_min: TilePos { x: 1, y: 1 },
                    aabb_max: TilePos { x: 1, y: 2 },
                    tile_count: 2,
                    tiles_hash: 123,
                };
                let mut idx = IntersectionIndex::default();
                idx.tile_to_intersection.insert(TilePos { x: 1, y: 1 }, id);
                idx.tile_to_intersection.insert(TilePos { x: 1, y: 2 }, id);
                idx.traffic_lights.insert(id);
                idx.clusters
                    .push(crate::game::intersections::IntersectionCluster {
                        id,
                        key,
                        tiles: vec![TilePos { x: 1, y: 1 }, TilePos { x: 1, y: 2 }],
                        aabb_min: TilePos { x: 1, y: 1 },
                        aabb_max: TilePos { x: 1, y: 2 },
                        centroid_tile: TilePos { x: 1, y: 1 },
                    });
                idx
            })
            .insert_resource(IntersectionReservations::default())
            .add_systems(Update, move_walkers);

        let id = app
            .world()
            .resource::<IntersectionIndex>()
            .intersection_id_at(TilePos { x: 1, y: 1 })
            .unwrap();
        let key = app
            .world()
            .resource::<IntersectionIndex>()
            .cluster_key_at(TilePos { x: 1, y: 1 })
            .unwrap();

        let light = app
            .world_mut()
            .spawn(crate::game::intersections::TrafficLight {
                intersection_id: id,
                intersection_key: key,
                pos: TilePos { x: 1, y: 1 },
                phase: LightPhase::NorthSouthGreen,
                phase_timer: 10.0,
                green_duration: 10.0,
                yellow_duration: 3.0,
                all_red_duration: 1.0,
            })
            .id();

        let a = TilePos { x: 1, y: 0 };
        let i1 = TilePos { x: 1, y: 1 };
        let i2 = TilePos { x: 1, y: 2 };
        let c = TilePos { x: 1, y: 3 };

        let ped = app
            .world_mut()
            .spawn((
                Pedestrian {
                    route: vec![a, i1, i2, c],
                    route_idx: 0,
                    progress: 0.0,
                    // Fast enough to enter the first intersection tile in one tick, but not so fast
                    // that we skip through the whole intersection and despawn before assertions.
                    speed_world: 165.0,
                    goal: c,
                    wait_blocked_secs: 0.0,
                    reroute_attempts: 0,
                },
                PedestrianTile(a),
                Transform::default(),
                WalkTripPassenger {
                    citizen: crate::game::ids::CitizenId(1),
                    purpose: crate::game::trips::TripPurpose::Work,
                },
            ))
            .id();

        // Tick: enter first intersection tile.
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();
        assert_eq!(
            app.world().get::<PedestrianTile>(ped).copied(),
            Some(PedestrianTile(i1))
        );

        // Phase changes to blocking (E/W green). Pedestrian must still continue inside intersection.
        app.world_mut()
            .entity_mut(light)
            .get_mut::<crate::game::intersections::TrafficLight>()
            .unwrap()
            .phase = LightPhase::EastWestGreen;

        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f32(0.1));
        app.update();
        assert_eq!(
            app.world().get::<PedestrianTile>(ped).copied(),
            Some(PedestrianTile(i2))
        );
    }

    #[test]
    fn pedestrian_reroutes_after_long_wait_at_uncontrolled_intersection() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<TripFinished>()
            .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
            .insert_resource(PedestrianConfig::default())
            .insert_resource(PedestrianGraph {
                version: 0,
                width: 3,
                height: 2,
                walkable: vec![true; 6],
            })
            .insert_resource(MapConfig {
                width: 3,
                height: 2,
                tile_size: 16.0,
            })
            .insert_resource({
                let mut grid = MapGrid::new(3, 2);
                // Mark (1,0) as the intersection tile we will avoid.
                let intersection_tile = TilePos { x: 1, y: 0 };
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
                let intersection_tile = TilePos { x: 1, y: 0 };
                let id = IntersectionId(0);
                let key = IntersectionKey {
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    tile_count: 1,
                    tiles_hash: 123,
                };
                let mut idx = IntersectionIndex::default();
                idx.tile_to_intersection.insert(intersection_tile, id);
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
            .insert_resource(IntersectionReservations::default())
            .add_systems(Update, move_walkers);

        let start = TilePos { x: 0, y: 0 };
        let avoid = TilePos { x: 1, y: 0 };
        let goal = TilePos { x: 2, y: 0 };

        // Keep the crossing blocked by keeping a vehicle close to entry.
        let _veh = app
            .world_mut()
            .spawn((
                Vehicle {
                    route: vec![start, avoid, goal],
                    progress: 0.9,
                    speed: 5.0,
                    max_speed: 60.0,
                    max_accel: 20.0,
                },
                crate::game::traffic::VehicleTrafficState::FreeFlow,
            ))
            .id();

        let ped = app
            .world_mut()
            .spawn((
                Pedestrian {
                    route: vec![start, avoid, goal],
                    route_idx: 0,
                    progress: 0.0,
                    speed_world: 240.0,
                    goal,
                    wait_blocked_secs: PedestrianConfig::default().wait_reroute_secs,
                    reroute_attempts: 0,
                },
                PedestrianTile(start),
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

        let p = app.world().get::<Pedestrian>(ped).unwrap();
        assert_ne!(p.route.get(1).copied(), Some(avoid));
    }

    #[test]
    fn sixlane_has_no_sidewalks_but_intersection_corners_are_walkable() {
        // Grid:
        // - SixLane eastbound lane tile at (0,0)
        // - Intersection tile (dir=None) at (0,1)
        // - Candidate corner tile at (1,1) adjacent to intersection -> should be walkable
        // - Tile (1,0) adjacent only to SixLane segment -> should NOT be walkable
        let mut grid = MapGrid::new(3, 3);

        let sixlane = TilePos { x: 0, y: 0 };
        if let Some(mut cell) = grid.get(sixlane) {
            cell.road = crate::game::roads::RoadCell {
                kind: RoadKind::SixLane,
                dir: RoadDir::East,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(sixlane, cell);
        }

        let intersection = TilePos { x: 0, y: 1 };
        if let Some(mut cell) = grid.get(intersection) {
            cell.road = crate::game::roads::RoadCell {
                kind: RoadKind::SixLane,
                dir: RoadDir::None,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(intersection, cell);
        }

        // Build pedestrian graph for this grid.
        let mut graph = PedestrianGraph::default();
        let gv = GraphVersion(1);
        // mimic system rebuild (minimal)
        graph.version = gv.0;
        graph.width = 3;
        graph.height = 3;
        graph.walkable = vec![false; grid.len()];
        for y in 0..grid.height {
            for x in 0..grid.width {
                let pos = TilePos { x, y };
                let Some(cell) = grid.get(pos) else { continue };
                if cell.water {
                    continue;
                }
                let walk = if cell.road.is_some() {
                    cell.road.dir == RoadDir::None
                } else {
                    is_corner_near_intersection(&grid, pos) || is_sidewalk_tile(&grid, pos)
                };
                if walk && let Some(i) = grid.idx(pos) {
                    graph.walkable[i] = true;
                }
            }
        }

        let corner = TilePos { x: 1, y: 1 };
        let near_sixlane_only = TilePos { x: 1, y: 0 };

        assert!(graph.is_walkable(intersection));
        assert!(graph.is_walkable(corner));
        assert!(!graph.is_walkable(near_sixlane_only));
    }
}
