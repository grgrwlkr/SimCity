//! 6.3.5 Day/Night cycle (MVP).
//!
//! Implements a simple global tint overlay that darkens the world at "night".

use bevy::prelude::*;
use bevy::time::Fixed;

use crate::game::map::MapConfig;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::ui_state::UiState;

pub struct DayNightPlugin;

impl Plugin for DayNightPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DayNightCycle>()
            .add_systems(
                FixedUpdate,
                tick_day_night
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                Update,
                render_day_night_overlay
                    .in_set(GameSet::RenderSync)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            )
            .add_systems(OnEnter(AppState::MainMenu), cleanup_overlay);
    }
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct DayNightCycle {
    pub time_of_day: f32,     // 0..1
    pub day_length_secs: f32, // simulated seconds per full cycle
    pub max_night_alpha: f32, // 0..1
}

impl Default for DayNightCycle {
    fn default() -> Self {
        Self {
            time_of_day: 0.0,
            day_length_secs: 30.0,
            max_night_alpha: 0.55,
        }
    }
}

#[derive(Component)]
struct DayNightOverlay;

fn tick_day_night(time: Res<Time<Fixed>>, ui: Res<UiState>, mut cycle: ResMut<DayNightCycle>) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed.clamp(0.0, 8.0);
    let len = cycle.day_length_secs.max(1.0);
    cycle.time_of_day = (cycle.time_of_day + dt / len) % 1.0;
}

fn render_day_night_overlay(
    cfg: Res<MapConfig>,
    cycle: Res<DayNightCycle>,
    mut commands: Commands,
    mut q: Query<(&mut Sprite, &mut Transform), With<DayNightOverlay>>,
) {
    let night = 0.5 - 0.5 * (cycle.time_of_day * std::f32::consts::TAU).cos();
    let alpha = (night * cycle.max_night_alpha).clamp(0.0, 0.95);

    let size = Vec2::new(
        cfg.width as f32 * cfg.tile_size,
        cfg.height as f32 * cfg.tile_size,
    );

    if let Ok((mut sprite, mut tf)) = q.single_mut() {
        sprite.color = Color::srgba(0.0, 0.0, 0.0, alpha);
        sprite.custom_size = Some(size);
        tf.translation = Vec3::new(0.0, 0.0, 50.0);
        return;
    }

    commands.spawn((
        DayNightOverlay,
        Sprite {
            color: Color::srgba(0.0, 0.0, 0.0, alpha),
            custom_size: Some(size),
            ..default()
        },
        Transform::from_translation(Vec3::new(0.0, 0.0, 50.0)),
    ));
}

fn cleanup_overlay(mut commands: Commands, q: Query<Entity, With<DayNightOverlay>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}
