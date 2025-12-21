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
