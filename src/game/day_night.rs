//! 6.3.5 Day/Night cycle (MVP).
//!
//! Visual day/night overlay driven by **game time only** (City.day + City.hour).
//! GDD 5.4: single source of time — no separate clock.

use bevy::prelude::*;

use crate::game::map::MapConfig;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

pub struct DayNightPlugin;

impl Plugin for DayNightPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DayNightVisualConfig>()
            .add_systems(
                Update,
                render_day_night_overlay
                    .in_set(GameSet::RenderSync)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            )
            .add_systems(OnEnter(AppState::MainMenu), cleanup_overlay);
    }
}

/// Config for day/night overlay (max darkness, curve). Phase is derived from City.
#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct DayNightVisualConfig {
    pub max_night_alpha: f32,
}

impl Default for DayNightVisualConfig {
    fn default() -> Self {
        Self {
            max_night_alpha: 0.55,
        }
    }
}

/// Compute time-of-day phase 0..1 from game hour (single source of time).
/// Hour 0 = midnight, 6 = dawn, 12 = noon, 18 = dusk.
#[inline]
pub fn time_of_day_from_hour(hour: u8) -> f32 {
    (hour as f32 / 24.0).rem_euclid(1.0)
}

#[derive(Component)]
struct DayNightOverlay;

fn render_day_night_overlay(
    cfg: Res<MapConfig>,
    city: Res<City>,
    visual: Res<DayNightVisualConfig>,
    mut commands: Commands,
    mut q: Query<(&mut Sprite, &mut Transform), With<DayNightOverlay>>,
) {
    let t = time_of_day_from_hour(city.hour);
    // night=0 at noon (t=0.5), night=1 at midnight (t=0).
    // cos(0)=1 → 0.5+0.5=1 (dark), cos(π)=-1 → 0.5-0.5=0 (bright).
    let night = 0.5 + 0.5 * (t * std::f32::consts::TAU).cos();
    let alpha = (night * visual.max_night_alpha).clamp(0.0, 0.95);

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
