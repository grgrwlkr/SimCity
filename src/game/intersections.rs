//! Intersection detection and traffic light management.
//!
//! Intersections are detected where multiple road directions meet.
//! Players can manually place traffic lights at intersections.

use bevy::prelude::*;
use std::collections::HashSet;

use crate::game::map::{MapConfig, TilePos};
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

/// Light phase for traffic lights
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum LightPhase {
    NorthSouthGreen,
    NorthSouthYellow,
    EastWestGreen,
    EastWestYellow,
}

/// Traffic light component for intersection entities.
#[derive(Component, Debug, Clone)]
pub struct TrafficLight {
    /// Position of the intersection.
    pub pos: TilePos,
    /// Current light phase
    pub phase: LightPhase,
    /// Time remaining in current phase (seconds).
    pub phase_timer: f32,
    /// Duration of green phase (seconds).
    pub green_duration: f32,
    /// Duration of yellow phase (seconds).
    pub yellow_duration: f32,
}

impl Default for TrafficLight {
    fn default() -> Self {
        Self {
            pos: TilePos { x: 0, y: 0 },
            phase: LightPhase::NorthSouthGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
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
}

/// Intersection priority rules
#[derive(Component, Debug, Copy, Clone, Eq, PartialEq)]
pub enum IntersectionPriority {
    /// No priority rules (default: right-of-way)
    None,
    /// Yield sign - must yield to traffic from right
    YieldSign,
    /// Stop sign - must come to complete stop
    StopSign,
    /// Main road - has priority over side roads
    MainRoad,
}

impl Default for IntersectionPriority {
    fn default() -> Self {
        IntersectionPriority::None
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
    /// Set of positions with traffic lights for quick lookup.
    pub traffic_light_positions: HashSet<TilePos>,
}

fn reset_intersections(mut index: ResMut<IntersectionIndex>) {
    index.version = 0;
    index.traffic_light_positions.clear();
}

/// Detect intersections where multiple road directions meet.
/// Currently only tracks version for synchronization; intersection data is not used yet.
fn detect_intersections(gv: Res<GraphVersion>, mut index: ResMut<IntersectionIndex>) {
    if index.version == gv.0 {
        return;
    }

    index.version = gv.0;
    // Keep traffic_light_positions - they persist until explicitly removed.
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
                    light.phase_timer = light.green_duration;
                    LightPhase::EastWestGreen
                }
                LightPhase::EastWestGreen => {
                    light.phase_timer = light.yellow_duration;
                    LightPhase::EastWestYellow
                }
                LightPhase::EastWestYellow => {
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
