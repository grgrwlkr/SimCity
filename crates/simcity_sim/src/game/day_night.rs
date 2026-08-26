//! 6.3.5 Day/Night cycle.
//!
//! Visual day/night driven by **game time only** (City.day + City.hour).
//! GDD 5.4: single source of time — no separate clock.
//!
//! Purely visual, no simulation effects. Since the pseudo-3D migration this is
//! a real LIGHTING cycle instead of a fullscreen darkening quad: the sun
//! (DirectionalLight) and the camera's AmbientLight dim and cool toward night,
//! building windows turn warm-emissive, road markings faintly glow and traffic
//! lights grow light pools on the asphalt — all via the shared `NightGlow`
//! material handles (a handful of asset writes per frame, city-wide effect).

use bevy::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::render_primitives::{
    MARKING_CENTER_COLOR, MARKING_WHITE_COLOR, NightGlow, WINDOW_GLASS_DAY,
};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

pub struct DayNightPlugin;

impl Plugin for DayNightPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DayNightVisualConfig>().add_systems(
            Update,
            drive_day_night_lighting
                .in_set(GameSet::RenderSync)
                .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
        );
    }
}

/// Tunables for the day/night lighting cycle (`assets/config/day_night.ron`).
/// Defaults reproduce the original hardcoded look bit-for-bit; the glow
/// multipliers are plain 1.0 scales on the night emissive strengths.
#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct DayNightVisualConfig {
    /// How dark the deepest night gets, 0..1 (1.0 = full-black night curve).
    #[serde(default = "default_night_darkness")]
    pub night_darkness: f32,
    /// Sun illuminance (lux) at full day.
    #[serde(default = "default_sun_day_illuminance")]
    pub sun_day_illuminance: f32,
    /// Camera ambient brightness at full day.
    #[serde(default = "default_ambient_day_brightness")]
    pub ambient_day_brightness: f32,
    /// Multiplier on building-window night emissive.
    #[serde(default = "default_glow")]
    pub window_glow: f32,
    /// Multiplier on road-marking night emissive.
    #[serde(default = "default_glow")]
    pub marking_glow: f32,
    /// Multiplier on traffic-light pool night emissive.
    #[serde(default = "default_glow")]
    pub light_pool_glow: f32,
}

fn default_night_darkness() -> f32 {
    0.55
}
fn default_sun_day_illuminance() -> f32 {
    12_000.0
}
fn default_ambient_day_brightness() -> f32 {
    700.0
}
fn default_glow() -> f32 {
    1.0
}

impl Default for DayNightVisualConfig {
    fn default() -> Self {
        Self {
            night_darkness: default_night_darkness(),
            sun_day_illuminance: default_sun_day_illuminance(),
            ambient_day_brightness: default_ambient_day_brightness(),
            window_glow: default_glow(),
            marking_glow: default_glow(),
            light_pool_glow: default_glow(),
        }
    }
}

/// Compute time-of-day phase 0..1 from game hour (single source of time).
/// Hour 0 = midnight, 6 = dawn, 12 = noon, 18 = dusk.
#[inline]
pub fn time_of_day_from_hour(hour: u8) -> f32 {
    (hour as f32 / 24.0).rem_euclid(1.0)
}

/// Night factor 0 (noon) .. 1 (midnight) — the same cosine the old overlay used.
#[inline]
pub fn night_factor(hour: u8) -> f32 {
    let t = time_of_day_from_hour(hour);
    0.5 + 0.5 * (t * std::f32::consts::TAU).cos()
}

fn drive_day_night_lighting(
    city: Res<City>,
    visual: Res<DayNightVisualConfig>,
    glow: Res<NightGlow>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut q_sun: Query<&mut DirectionalLight>,
    mut q_ambient: Query<&mut AmbientLight, With<MainCamera>>,
    mut last_hour: Local<Option<u8>>,
) {
    // Mutating shared materials re-prepares every entity that uses them
    // (thousands of markings/windows) — only touch them when the hour flips.
    if *last_hour == Some(city.hour) {
        return;
    }
    *last_hour = Some(city.hour);

    // 0 at noon, up to ~1 at midnight, scaled by the configured darkness.
    let darkness = (night_factor(city.hour) * (visual.night_darkness / 0.55)).clamp(0.0, 1.0);
    let day = 1.0 - darkness;

    // Sun: bright warm white by day -> dim cool "moon" at night.
    for mut sun in q_sun.iter_mut() {
        sun.illuminance = visual.sun_day_illuminance * (0.04 + 0.96 * day);
        sun.color = Color::srgb(0.60 + 0.40 * day, 0.68 + 0.30 * day, 1.0 - 0.08 * day);
    }
    for mut ambient in q_ambient.iter_mut() {
        ambient.brightness = visual.ambient_day_brightness * (0.22 + 0.78 * day);
        ambient.color = Color::srgb(0.55 + 0.30 * day, 0.62 + 0.28 * day, 1.0);
    }

    // Windows: dark glass by day, warm interior light at night.
    let night = darkness;
    if let Some(mut m) = materials.get_mut(&glow.windows) {
        let glow_scale = visual.window_glow;
        let glass = WINDOW_GLASS_DAY.to_srgba();
        m.base_color = Color::srgb(
            glass.red + 0.55 * night * glow_scale,
            glass.green + 0.40 * night * glow_scale,
            glass.blue + 0.13 * night * glow_scale,
        );
        m.emissive = LinearRgba::rgb(2.6 * night, 1.7 * night, 0.55 * night) * glow_scale;
    }
    // Markings keep the road readable in the dark.
    if let Some(mut m) = materials.get_mut(&glow.marking_center) {
        m.emissive =
            LinearRgba::rgb(0.55 * night, 0.45 * night, 0.05 * night) * visual.marking_glow;
        m.base_color = MARKING_CENTER_COLOR;
    }
    if let Some(mut m) = materials.get_mut(&glow.marking_white) {
        m.emissive =
            LinearRgba::rgb(0.35 * night, 0.35 * night, 0.38 * night) * visual.marking_glow;
        m.base_color = MARKING_WHITE_COLOR;
    }
    // Warm pools under traffic lights fade in after dusk.
    if let Some(mut m) = materials.get_mut(&glow.light_pool) {
        let pool = visual.light_pool_glow;
        m.base_color = Color::srgba(1.0, 0.85, 0.5, (0.35 * night * pool).clamp(0.0, 1.0));
        m.emissive = LinearRgba::rgb(0.9 * night, 0.65 * night, 0.25 * night) * pool;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::render_primitives;

    #[test]
    fn night_factor_extremes() {
        assert!(night_factor(0) > 0.99, "midnight is full night");
        assert!(night_factor(12) < 0.01, "noon is full day");
        let dusk = night_factor(18);
        assert!((0.3..0.7).contains(&dusk), "dusk is in between, got {dusk}");
    }

    /// Midnight: windows emissive, sun dim. Noon: windows dark, sun bright.
    #[test]
    fn lighting_follows_game_hour() {
        let cfg = DayNightVisualConfig::default();
        let mut app = App::new();
        render_primitives::init_for_test(&mut app);
        app.init_resource::<DayNightVisualConfig>();
        app.insert_resource(City {
            hour: 0,
            ..Default::default()
        });
        let sun = app
            .world_mut()
            .spawn(DirectionalLight {
                illuminance: cfg.sun_day_illuminance,
                ..default()
            })
            .id();
        app.world_mut().spawn((
            MainCamera,
            AmbientLight {
                brightness: cfg.ambient_day_brightness,
                ..default()
            },
        ));
        app.add_systems(Update, drive_day_night_lighting);

        app.update();
        let glow = app.world().resource::<NightGlow>().clone();
        let windows_emissive = |app: &App| {
            app.world()
                .resource::<Assets<StandardMaterial>>()
                .get(&glow.windows)
                .unwrap()
                .emissive
                .red
        };
        let sun_lux = |app: &App| {
            app.world()
                .get::<DirectionalLight>(sun)
                .unwrap()
                .illuminance
        };
        assert!(windows_emissive(&app) > 1.0, "windows glow at midnight");
        assert!(
            sun_lux(&app) < cfg.sun_day_illuminance * 0.1,
            "sun nearly off at midnight"
        );

        app.world_mut().resource_mut::<City>().hour = 12;
        app.update();
        assert!(windows_emissive(&app) < 0.01, "windows dark glass at noon");
        assert!(
            sun_lux(&app) > cfg.sun_day_illuminance * 0.9,
            "full sun at noon"
        );
    }
}
