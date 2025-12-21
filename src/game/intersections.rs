//! Intersection detection and traffic light management.
//!
//! Intersections are detected where multiple road directions meet.
//! Players can manually place traffic lights at intersections.

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;
use std::collections::HashSet;

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

/// Data about an intersection.
#[derive(Debug, Clone)]
pub struct Intersection {
    /// Center tile of the intersection.
    pub pos: TilePos,
    /// Road directions meeting at this intersection.
    #[allow(dead_code)]
    pub directions: HashSet<RoadDir>,
    /// Whether a traffic light is installed here.
    pub has_traffic_light: bool,
}

/// Traffic light component for intersection entities.
#[derive(Component, Debug, Clone)]
pub struct TrafficLight {
    /// Position of the intersection.
    pub pos: TilePos,
    /// Current phase (0 = N-S green, 1 = E-W green, etc.)
    pub phase: u8,
    /// Total number of phases.
    pub num_phases: u8,
    /// Time remaining in current phase (seconds).
    pub phase_timer: f32,
    /// Duration of each phase (seconds).
    pub phase_duration: f32,
}

impl Default for TrafficLight {
    fn default() -> Self {
        Self {
            pos: TilePos { x: 0, y: 0 },
            phase: 0,
            num_phases: 2,
            phase_timer: 10.0,
            phase_duration: 10.0,
        }
    }
}

impl TrafficLight {
    /// Check if a given direction is currently green.
    #[allow(dead_code)]
    pub fn is_green(&self, dir: RoadDir) -> bool {
        match self.phase {
            0 => matches!(dir, RoadDir::North | RoadDir::South),
            1 => matches!(dir, RoadDir::East | RoadDir::West),
            _ => true,
        }
    }
}

/// Marker for traffic light visual entities.
#[derive(Component)]
struct TrafficLightVisual;

/// Index of all intersections in the map.
#[derive(Resource, Default)]
pub struct IntersectionIndex {
    /// Map version this index was built for.
    pub version: u64,
    /// All detected intersections by position.
    pub intersections: Vec<Intersection>,
    /// Set of positions with traffic lights for quick lookup.
    pub traffic_light_positions: HashSet<TilePos>,
}

impl IntersectionIndex {
    #[allow(dead_code)]
    pub fn get(&self, pos: TilePos) -> Option<&Intersection> {
        self.intersections.iter().find(|i| i.pos == pos)
    }

    #[allow(dead_code)]
    pub fn has_traffic_light(&self, pos: TilePos) -> bool {
        self.traffic_light_positions.contains(&pos)
    }
}

fn reset_intersections(mut index: ResMut<IntersectionIndex>) {
    index.version = 0;
    index.intersections.clear();
    index.traffic_light_positions.clear();
}

/// Detect intersections where multiple road directions meet.
fn detect_intersections(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut index: ResMut<IntersectionIndex>,
) {
    if index.version == gv.0 {
        return;
    }

    index.version = gv.0;
    index.intersections.clear();
    // Keep traffic_light_positions - they persist until explicitly removed.

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if !cell.road.is_some() {
                continue;
            }

            // Check all 4 neighbors for road tiles with different directions.
            // Intersection nodes are represented as `RoadDir::None` (see road build logic).
            let mut directions = HashSet::new();
            if cell.road.dir != RoadDir::None {
                directions.insert(cell.road.dir);
            }

            let neighbors = [
                TilePos { x: x - 1, y },
                TilePos { x: x + 1, y },
                TilePos { x, y: y - 1 },
                TilePos { x, y: y + 1 },
            ];

            for npos in neighbors {
                if let Some(ncell) = grid.get(npos)
                    && ncell.road.is_some()
                    && ncell.road.dir != RoadDir::None
                {
                    directions.insert(ncell.road.dir);
                }
            }

            // An intersection is either:
            // - explicitly marked (`dir: None`) by the road builder, or
            // - a tile where 3+ distinct directions meet.
            if cell.road.dir == RoadDir::None || directions.len() >= 3 {
                let has_light = index.traffic_light_positions.contains(&pos);
                index.intersections.push(Intersection {
                    pos,
                    directions,
                    has_traffic_light: has_light,
                });
            }
        }
    }
}

/// Handle commands to place/remove traffic lights.
fn handle_traffic_light_commands(
    mut reader: MessageReader<GameCommand>,
    mut index: ResMut<IntersectionIndex>,
    mut commands: Commands,
    q_lights: Query<(Entity, &TrafficLight)>,
) {
    for cmd in reader.read() {
        match cmd {
            GameCommand::PlaceTrafficLight { pos } => {
                // Only allow placing at intersections.
                let is_intersection = index.intersections.iter().any(|i| i.pos == *pos);
                if !is_intersection {
                    continue;
                }

                if index.traffic_light_positions.contains(pos) {
                    continue;
                }

                index.traffic_light_positions.insert(*pos);

                // Update intersection data.
                if let Some(intersection) = index.intersections.iter_mut().find(|i| i.pos == *pos) {
                    intersection.has_traffic_light = true;
                }

                // Spawn traffic light entity.
                commands.spawn(TrafficLight {
                    pos: *pos,
                    ..default()
                });
            }
            GameCommand::RemoveTrafficLight { pos } => {
                if !index.traffic_light_positions.contains(pos) {
                    continue;
                }

                index.traffic_light_positions.remove(pos);

                // Update intersection data.
                if let Some(intersection) = index.intersections.iter_mut().find(|i| i.pos == *pos) {
                    intersection.has_traffic_light = false;
                }

                // Despawn traffic light entity.
                for (entity, light) in &q_lights {
                    if light.pos == *pos {
                        commands.entity(entity).despawn();
                    }
                }
            }
            _ => {}
        }
    }
}

/// Update traffic light phases.
fn update_traffic_lights(time: Res<Time>, mut q_lights: Query<&mut TrafficLight>) {
    let dt = time.delta_secs();

    for mut light in &mut q_lights {
        light.phase_timer -= dt;

        if light.phase_timer <= 0.0 {
            light.phase = (light.phase + 1) % light.num_phases;
            light.phase_timer = light.phase_duration;
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

        // Color based on phase (simplified: green for active direction).
        let color = match light.phase {
            0 => Color::srgba(0.2, 0.9, 0.2, 0.8), // N-S green.
            _ => Color::srgba(0.9, 0.2, 0.2, 0.8), // E-W red (from N-S perspective).
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
