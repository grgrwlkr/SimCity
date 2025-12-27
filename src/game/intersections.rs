//! Intersection detection and traffic light management.
//!
//! Intersections are detected where multiple road directions meet.
//! Players can manually place traffic lights at intersections.

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};

use crate::game::commands::GameCommand;
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::GraphVersion;

pub struct IntersectionsPlugin;

impl Plugin for IntersectionsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<IntersectionIndex>()
            .add_systems(OnEnter(AppState::MainMenu), reset_intersections)
            .add_systems(
                Update,
                detect_intersections
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                handle_traffic_light_commands
                    .in_set(GameSet::CommandApply)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                sync_traffic_light_entities
                    .in_set(GameSet::GraphUpdate)
                    .after(detect_intersections)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                assign_intersection_priorities
                    .in_set(GameSet::GraphUpdate)
                    .after(detect_intersections)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                FixedUpdate,
                update_traffic_lights
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                Update,
                render_traffic_lights
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

/// Logical intersection id (stable only within one `GraphVersion` build).
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct IntersectionId(pub u32);

impl IntersectionId {
    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// A stable-ish key for an intersection cluster used to keep user-placed controllers across rebuilds.
///
/// This is not guaranteed collision-free, but is strong enough for MVP:
/// - AABB + tile count + deterministic hash over the (sorted) tile list.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct IntersectionKey {
    pub aabb_min: TilePos,
    pub aabb_max: TilePos,
    pub tile_count: u32,
    pub tiles_hash: u64,
}

#[derive(Debug, Clone)]
pub struct IntersectionCluster {
    pub id: IntersectionId,
    pub key: IntersectionKey,
    #[allow(dead_code)]
    pub tiles: Vec<TilePos>,
    #[allow(dead_code)]
    pub aabb_min: TilePos,
    #[allow(dead_code)]
    pub aabb_max: TilePos,
    /// Representative tile for visuals (not used for driving logic).
    pub centroid_tile: TilePos,
}

/// Light phase for traffic lights
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum LightPhase {
    NorthSouthGreen,
    NorthSouthYellow,
    /// All directions red; clearance interval before switching to East/West green.
    AllRedToEastWest,
    EastWestGreen,
    EastWestYellow,
    /// All directions red; clearance interval before switching to North/South green.
    AllRedToNorthSouth,
}

/// Traffic light component for intersection entities.
#[derive(Component, Debug, Clone)]
pub struct TrafficLight {
    /// Logical intersection id (per current `GraphVersion`).
    pub intersection_id: IntersectionId,
    /// Stable key (used to reconcile entities across graph rebuilds).
    pub intersection_key: IntersectionKey,
    /// Position used for visuals.
    pub pos: TilePos,
    /// Current light phase
    pub phase: LightPhase,
    /// Time remaining in current phase (seconds).
    pub phase_timer: f32,
    /// Duration of green phase (seconds).
    pub green_duration: f32,
    /// Duration of yellow phase (seconds).
    pub yellow_duration: f32,
    /// Duration of all-red clearance phase (seconds).
    pub all_red_duration: f32,
}

impl Default for TrafficLight {
    fn default() -> Self {
        Self {
            intersection_id: IntersectionId(0),
            intersection_key: IntersectionKey {
                aabb_min: TilePos { x: 0, y: 0 },
                aabb_max: TilePos { x: 0, y: 0 },
                tile_count: 0,
                tiles_hash: 0,
            },
            pos: TilePos { x: 0, y: 0 },
            phase: LightPhase::NorthSouthGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        }
    }
}

impl TrafficLight {
    /// Check if the light is green for a given direction
    pub fn is_green(&self, dir: crate::game::roads::RoadDir) -> bool {
        matches!(
            (self.phase, dir),
            (
                LightPhase::NorthSouthGreen,
                crate::game::roads::RoadDir::North | crate::game::roads::RoadDir::South
            ) | (
                LightPhase::EastWestGreen,
                crate::game::roads::RoadDir::East | crate::game::roads::RoadDir::West
            )
        )
    }

    /// Check if the light is yellow for a given direction
    pub fn is_yellow(&self, dir: crate::game::roads::RoadDir) -> bool {
        matches!(
            (self.phase, dir),
            (
                LightPhase::NorthSouthYellow,
                crate::game::roads::RoadDir::North | crate::game::roads::RoadDir::South
            ) | (
                LightPhase::EastWestYellow,
                crate::game::roads::RoadDir::East | crate::game::roads::RoadDir::West
            )
        )
    }

    /// Check if the light is red for a given direction (not green and not yellow)
    pub fn is_red(&self, dir: crate::game::roads::RoadDir) -> bool {
        !self.is_green(dir) && !self.is_yellow(dir)
    }

    pub fn is_all_red(&self) -> bool {
        matches!(
            self.phase,
            LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth
        )
    }
}

/// Intersection priority rules
#[derive(Component, Debug, Copy, Clone, Eq, PartialEq, Default)]
pub enum IntersectionPriority {
    /// No priority rules (default: right-of-way)
    #[default]
    None,
    /// Yield sign - must yield to traffic from right
    YieldSign,
    /// Stop sign - must come to complete stop
    StopSign,
    /// Main road - has priority over side roads
    MainRoad,
}

/// Marker for traffic light visual entities.
#[derive(Component)]
struct TrafficLightVisual;

/// Marker component to store intersection position for priority lookup
#[derive(Component)]
pub struct IntersectionPriorityMarker {
    pub pos: TilePos,
    pub priority: IntersectionPriority,
}

/// Index of all intersections in the map.
#[derive(Resource, Default)]
pub struct IntersectionIndex {
    /// Map version this index was built for.
    pub version: u64,
    /// Flood-filled intersection clusters (`road.dir == None`) for this version.
    pub clusters: Vec<IntersectionCluster>,
    /// For each intersection tile: map to the owning `IntersectionId`.
    pub tile_to_intersection: HashMap<TilePos, IntersectionId>,

    /// User-placed controllers: stored as stable keys so they can survive graph rebuilds.
    pub traffic_light_keys: HashSet<IntersectionKey>,
    /// Derived set for the current version (rebuilt from `traffic_light_keys` on graph rebuild).
    pub traffic_lights: HashSet<IntersectionId>,

    /// Internal dirty flag to reconcile ECS entities after changes.
    lights_dirty: bool,
}

fn reset_intersections(mut index: ResMut<IntersectionIndex>) {
    index.version = 0;
    index.clusters.clear();
    index.tile_to_intersection.clear();
    index.traffic_light_keys.clear();
    index.traffic_lights.clear();
    index.lights_dirty = true;
}

impl IntersectionIndex {
    pub fn intersection_id_at(&self, pos: TilePos) -> Option<IntersectionId> {
        self.tile_to_intersection.get(&pos).copied()
    }

    pub fn cluster_by_id(&self, id: IntersectionId) -> Option<&IntersectionCluster> {
        self.clusters.get(id.as_usize())
    }

    pub fn cluster_key_at(&self, pos: TilePos) -> Option<IntersectionKey> {
        let id = self.intersection_id_at(pos)?;
        Some(self.cluster_by_id(id)?.key)
    }

    pub fn has_traffic_light_at(&self, pos: TilePos) -> bool {
        let Some(id) = self.intersection_id_at(pos) else {
            return false;
        };
        self.traffic_lights.contains(&id)
    }
}

/// Detect intersections as clusters of adjacent `dir == None` tiles (flood fill).
fn detect_intersections(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut index: ResMut<IntersectionIndex>,
) {
    if index.version == gv.0 {
        return;
    }

    index.version = gv.0;

    let (clusters, tile_to_intersection) = build_intersection_clusters(&grid);
    index.clusters = clusters;
    index.tile_to_intersection = tile_to_intersection;

    // Re-map persistent traffic light keys onto the new ids.
    let mut next_keys = HashSet::<IntersectionKey>::new();
    let mut next_ids = HashSet::<IntersectionId>::new();
    for c in index.clusters.iter() {
        if index.traffic_light_keys.contains(&c.key) {
            next_keys.insert(c.key);
            next_ids.insert(c.id);
        }
    }
    index.traffic_light_keys = next_keys;
    index.traffic_lights = next_ids;
    index.lights_dirty = true;
}

pub(crate) fn build_intersection_clusters(
    grid: &MapGrid,
) -> (Vec<IntersectionCluster>, HashMap<TilePos, IntersectionId>) {
    let mut clusters = Vec::<IntersectionCluster>::new();
    let mut tile_to_intersection = HashMap::<TilePos, IntersectionId>::new();

    let len = grid.len();
    let mut visited = vec![false; len];

    let is_intersection_tile = |pos: TilePos, grid: &MapGrid| -> bool {
        let Some(cell) = grid.get(pos) else {
            return false;
        };
        if cell.water || !cell.road.is_some() {
            return false;
        }
        cell.road.dir == RoadDir::None
    };

    for y in 0..grid.height {
        for x in 0..grid.width {
            let start = TilePos { x, y };
            let Some(start_idx) = grid.idx(start) else {
                continue;
            };
            if visited[start_idx] {
                continue;
            }
            if !is_intersection_tile(start, grid) {
                continue;
            }

            // Flood fill the cluster.
            let mut q = VecDeque::<TilePos>::new();
            let mut tiles = Vec::<TilePos>::new();
            q.push_back(start);
            visited[start_idx] = true;

            let mut min_x = start.x;
            let mut min_y = start.y;
            let mut max_x = start.x;
            let mut max_y = start.y;

            let mut sum_x: i64 = 0;
            let mut sum_y: i64 = 0;

            while let Some(p) = q.pop_front() {
                tiles.push(p);
                sum_x += p.x as i64;
                sum_y += p.y as i64;
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);

                for n in [
                    TilePos { x: p.x - 1, y: p.y },
                    TilePos { x: p.x + 1, y: p.y },
                    TilePos { x: p.x, y: p.y - 1 },
                    TilePos { x: p.x, y: p.y + 1 },
                ] {
                    let Some(nidx) = grid.idx(n) else {
                        continue;
                    };
                    if visited[nidx] {
                        continue;
                    }
                    if !is_intersection_tile(n, grid) {
                        continue;
                    }
                    visited[nidx] = true;
                    q.push_back(n);
                }
            }

            // Deterministic ordering for hashing/debug.
            tiles.sort_by_key(|p| (p.y, p.x));

            let tile_count = tiles.len().max(1) as i64;
            let centroid_tile = TilePos {
                x: (sum_x / tile_count) as i32,
                y: (sum_y / tile_count) as i32,
            };

            let aabb_min = TilePos { x: min_x, y: min_y };
            let aabb_max = TilePos { x: max_x, y: max_y };

            let key = compute_intersection_key(aabb_min, aabb_max, &tiles);
            let id = IntersectionId(clusters.len() as u32);

            for &t in tiles.iter() {
                tile_to_intersection.insert(t, id);
            }

            clusters.push(IntersectionCluster {
                id,
                key,
                tiles,
                aabb_min,
                aabb_max,
                centroid_tile,
            });
        }
    }

    (clusters, tile_to_intersection)
}

fn compute_intersection_key(
    aabb_min: TilePos,
    aabb_max: TilePos,
    tiles_sorted: &[TilePos],
) -> IntersectionKey {
    // FNV-1a 64-bit over tile coordinates (deterministic, cheap).
    let mut h: u64 = 14695981039346656037;
    for t in tiles_sorted {
        let x = t.x as u32 as u64;
        let y = t.y as u32 as u64;
        // Mix x,y into the stream deterministically.
        h ^= x.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        h = h.wrapping_mul(1099511628211);
        h ^= y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
        h = h.wrapping_mul(1099511628211);
    }

    IntersectionKey {
        aabb_min,
        aabb_max,
        tile_count: tiles_sorted.len() as u32,
        tiles_hash: h,
    }
}

/// Automatically assign intersection priorities based on road types
fn assign_intersection_priorities(
    grid: Res<crate::game::map::MapGrid>,
    intersections: Res<IntersectionIndex>,
    mut commands: Commands,
    q_priorities: Query<Entity, With<IntersectionPriorityMarker>>,
) {
    // Remove old priority entities that are no longer intersections
    for entity in q_priorities.iter() {
        commands.entity(entity).despawn();
    }

    // For intersections without traffic lights, assign priority based on road types
    // This creates IntersectionPriority entities to use all enum variants
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = crate::game::map::TilePos { x, y };

            // Skip if has traffic light
            if intersections.has_traffic_light_at(pos) {
                continue;
            }

            // Check if this is an intersection (dir == None)
            if let Some(cell) = grid.get(pos)
                && cell.road.dir == crate::game::roads::RoadDir::None
            {
                // Check surrounding roads to determine priority
                let mut max_lanes = 0u8;
                let mut side_road_count = 0u8;

                for neighbor_pos in [
                    crate::game::map::TilePos {
                        x: pos.x - 1,
                        y: pos.y,
                    },
                    crate::game::map::TilePos {
                        x: pos.x + 1,
                        y: pos.y,
                    },
                    crate::game::map::TilePos {
                        x: pos.x,
                        y: pos.y - 1,
                    },
                    crate::game::map::TilePos {
                        x: pos.x,
                        y: pos.y + 1,
                    },
                ] {
                    if let Some(neighbor_cell) = grid.get(neighbor_pos) {
                        let lanes = neighbor_cell.road.kind.lanes();
                        max_lanes = max_lanes.max(lanes);
                        if lanes < 4 {
                            side_road_count += 1;
                        }
                    }
                }

                // Assign priority based on road configuration
                let priority = if max_lanes >= 6 {
                    // Highway intersection - main road
                    IntersectionPriority::MainRoad
                } else if side_road_count >= 2 {
                    // Multiple side roads - use stop sign
                    IntersectionPriority::StopSign
                } else if max_lanes >= 4 {
                    // Main road intersection - yield sign for side roads
                    IntersectionPriority::YieldSign
                } else {
                    // Small intersection - default rules
                    IntersectionPriority::None
                };

                // Spawn entity with IntersectionPriority marker component
                commands.spawn(IntersectionPriorityMarker { pos, priority });
            }
        }
    }
}

/// Update traffic light phases.
fn update_traffic_lights(time: Res<Time>, mut q_lights: Query<&mut TrafficLight>) {
    let dt = time.delta_secs();

    for mut light in &mut q_lights {
        light.phase_timer -= dt;

        if light.phase_timer <= 0.0 {
            // Transition to next phase
            light.phase = match light.phase {
                LightPhase::NorthSouthGreen => {
                    light.phase_timer = light.yellow_duration;
                    LightPhase::NorthSouthYellow
                }
                LightPhase::NorthSouthYellow => {
                    light.phase_timer = light.all_red_duration;
                    LightPhase::AllRedToEastWest
                }
                LightPhase::AllRedToEastWest => {
                    light.phase_timer = light.green_duration;
                    LightPhase::EastWestGreen
                }
                LightPhase::EastWestGreen => {
                    light.phase_timer = light.yellow_duration;
                    LightPhase::EastWestYellow
                }
                LightPhase::EastWestYellow => {
                    light.phase_timer = light.all_red_duration;
                    LightPhase::AllRedToNorthSouth
                }
                LightPhase::AllRedToNorthSouth => {
                    light.phase_timer = light.green_duration;
                    LightPhase::NorthSouthGreen
                }
            };
        }
    }
}

/// Render traffic light visuals.
fn render_traffic_lights(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    q_lights: Query<&TrafficLight>,
    q_visuals: Query<Entity, With<TrafficLightVisual>>,
) {
    // Clear old visuals.
    for e in &q_visuals {
        commands.entity(e).despawn();
    }

    let origin = map_origin(&cfg);

    for light in &q_lights {
        let world = origin
            + Vec2::new(
                light.pos.x as f32 * cfg.tile_size,
                light.pos.y as f32 * cfg.tile_size,
            );

        // Color based on phase
        let color = match light.phase {
            LightPhase::NorthSouthGreen | LightPhase::EastWestGreen => {
                Color::srgba(0.2, 0.9, 0.2, 0.8) // Green
            }
            LightPhase::NorthSouthYellow | LightPhase::EastWestYellow => {
                Color::srgba(0.9, 0.9, 0.2, 0.8) // Yellow
            }
            LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth => {
                Color::srgba(0.9, 0.2, 0.2, 0.8) // Red
            }
        };

        commands.spawn((
            Sprite::from_color(color, Vec2::splat(cfg.tile_size * 0.3)),
            Transform::from_translation(Vec3::new(world.x, world.y, 12.0)),
            TrafficLightVisual,
        ));
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

/// Handle traffic light placement/removal commands.
fn handle_traffic_light_commands(
    mut reader: MessageReader<GameCommand>,
    mut index: ResMut<IntersectionIndex>,
    grid: Res<MapGrid>,
) {
    for cmd in reader.read() {
        match cmd {
            GameCommand::PlaceTrafficLight { pos } => {
                // Check if this is an intersection (dir == None)
                let Some(cell) = grid.get(*pos) else {
                    continue;
                };
                if cell.road.dir != RoadDir::None {
                    continue; // Not an intersection
                }
                let Some(id) = index.intersection_id_at(*pos) else {
                    continue;
                };
                let Some(cluster) = index.cluster_by_id(id) else {
                    continue;
                };
                let key = cluster.key;
                let cid = cluster.id;

                // Spec v2: PlaceTrafficLight toggles the controller for the whole logical intersection.
                if index.traffic_light_keys.contains(&key) {
                    index.traffic_light_keys.remove(&key);
                    index.traffic_lights.remove(&cid);
                } else {
                    index.traffic_light_keys.insert(key);
                    index.traffic_lights.insert(cid);
                }
                index.lights_dirty = true;
            }
            GameCommand::RemoveTrafficLight { pos } => {
                let Some(id) = index.intersection_id_at(*pos) else {
                    continue;
                };
                let Some(cluster) = index.cluster_by_id(id) else {
                    continue;
                };
                let key = cluster.key;
                let cid = cluster.id;

                if index.traffic_light_keys.remove(&key) {
                    index.traffic_lights.remove(&cid);
                    index.lights_dirty = true;
                }
            }
            _ => {}
        }
    }
}

/// Keep ECS `TrafficLight` entities in sync with the logical intersection controllers.
fn sync_traffic_light_entities(
    mut commands: Commands,
    mut index: ResMut<IntersectionIndex>,
    mut q_lights: Query<(Entity, &mut TrafficLight)>,
) {
    if !index.lights_dirty {
        return;
    }
    index.lights_dirty = false;

    // Collect existing entities by key and despawn stale ones.
    let mut existing = HashMap::<IntersectionKey, Entity>::new();
    let mut to_despawn = Vec::<Entity>::new();

    for (e, light) in q_lights.iter_mut() {
        if index.traffic_light_keys.contains(&light.intersection_key) {
            existing.insert(light.intersection_key, e);
        } else {
            to_despawn.push(e);
        }
    }

    for e in to_despawn {
        commands.entity(e).despawn();
    }

    // Spawn missing, update existing.
    for cluster in index.clusters.iter() {
        if !index.traffic_light_keys.contains(&cluster.key) {
            continue;
        }

        if let Some(&e) = existing.get(&cluster.key) {
            if let Ok((_e, mut light)) = q_lights.get_mut(e) {
                light.intersection_id = cluster.id;
                light.intersection_key = cluster.key;
                light.pos = cluster.centroid_tile;
            }
        } else {
            commands.spawn(TrafficLight {
                intersection_id: cluster.id,
                intersection_key: cluster.key,
                pos: cluster.centroid_tile,
                ..default()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use bevy::app::App;
    use bevy::prelude::{MinimalPlugins, Update};

    fn set_intersection_tile(grid: &mut MapGrid, pos: TilePos) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
        cell.water = false;
        cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::None,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    #[test]
    fn clusters_flood_fill_groups_adjacent_none_tiles() {
        let mut grid = MapGrid::new(4, 4);

        // Single-tile cluster at (0,0)
        set_intersection_tile(&mut grid, TilePos { x: 0, y: 0 });

        // 2x2 cluster at (1,1)-(2,2)
        for y in 1..=2 {
            for x in 1..=2 {
                set_intersection_tile(&mut grid, TilePos { x, y });
            }
        }

        let (clusters, tile_map) = build_intersection_clusters(&grid);
        assert_eq!(clusters.len(), 2);

        // First discovered is (0,0) due to y/x scan order.
        assert_eq!(clusters[0].tiles.len(), 1);
        assert_eq!(clusters[1].tiles.len(), 4);

        let id00 = tile_map.get(&TilePos { x: 0, y: 0 }).copied();
        assert_eq!(id00, Some(IntersectionId(0)));

        let id11 = tile_map.get(&TilePos { x: 1, y: 1 }).copied().unwrap();
        let id12 = tile_map.get(&TilePos { x: 1, y: 2 }).copied().unwrap();
        let id21 = tile_map.get(&TilePos { x: 2, y: 1 }).copied().unwrap();
        let id22 = tile_map.get(&TilePos { x: 2, y: 2 }).copied().unwrap();
        assert_eq!(id11, id12);
        assert_eq!(id11, id21);
        assert_eq!(id11, id22);
        assert_eq!(id11, IntersectionId(1));
    }

    #[test]
    fn has_traffic_light_is_cluster_wide() {
        let mut grid = MapGrid::new(3, 3);
        set_intersection_tile(&mut grid, TilePos { x: 1, y: 1 });
        set_intersection_tile(&mut grid, TilePos { x: 1, y: 2 }); // adjacent => same cluster

        let (clusters, tile_map) = build_intersection_clusters(&grid);
        assert_eq!(clusters.len(), 1);

        let mut idx = IntersectionIndex::default();
        idx.version = 1;
        idx.clusters = clusters;
        idx.tile_to_intersection = tile_map;

        let id = idx.intersection_id_at(TilePos { x: 1, y: 1 }).unwrap();
        idx.traffic_lights.insert(id);

        assert!(idx.has_traffic_light_at(TilePos { x: 1, y: 1 }));
        assert!(idx.has_traffic_light_at(TilePos { x: 1, y: 2 }));
        assert!(!idx.has_traffic_light_at(TilePos { x: 0, y: 0 }));
    }

    #[test]
    fn traffic_light_includes_all_red_clearance() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_systems(Update, update_traffic_lights);

        let e = app
            .world_mut()
            .spawn(TrafficLight {
                phase: LightPhase::NorthSouthGreen,
                phase_timer: 0.0, // force transition
                green_duration: 10.0,
                yellow_duration: 3.0,
                all_red_duration: 1.0,
                ..default()
            })
            .id();

        // NS Green -> NS Yellow
        app.update();
        {
            let light = app.world().get::<TrafficLight>(e).unwrap();
            assert_eq!(light.phase, LightPhase::NorthSouthYellow);
            assert_eq!(light.phase_timer, 3.0);
        }

        // NS Yellow -> All red
        app.world_mut()
            .get_mut::<TrafficLight>(e)
            .unwrap()
            .phase_timer = 0.0;
        app.update();
        {
            let light = app.world().get::<TrafficLight>(e).unwrap();
            assert_eq!(light.phase, LightPhase::AllRedToEastWest);
            assert_eq!(light.phase_timer, 1.0);
        }

        // All red -> EW Green
        app.world_mut()
            .get_mut::<TrafficLight>(e)
            .unwrap()
            .phase_timer = 0.0;
        app.update();
        {
            let light = app.world().get::<TrafficLight>(e).unwrap();
            assert_eq!(light.phase, LightPhase::EastWestGreen);
            assert_eq!(light.phase_timer, 10.0);
        }
    }
}
