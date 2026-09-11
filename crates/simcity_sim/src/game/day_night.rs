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

use crate::game::ui_state::UiState;
use bevy::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::render_primitives::{
    MARKING_CENTER_COLOR, MARKING_WHITE_COLOR, NightGlow, SIGN_DAY_COLOR, WINDOW_GLASS_DAY,
};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use simcity_core::game::props_config::PropsConfig;
use simcity_core::game::render_config::{NightConfig, RenderConfig, SunConfig};

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

/// Tunables for the night look (`assets/config/day_night.ron`). Sun and ambient
/// levels live in `render.ron` (`SunConfig`/`NightConfig`), not here. Defaults
/// reproduce the original hardcoded look bit-for-bit; the glow multipliers are
/// plain 1.0 scales on the night emissive strengths.
#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct DayNightVisualConfig {
    /// How dark the deepest night gets, 0..1 (1.0 = full-black night curve).
    #[serde(default = "default_night_darkness")]
    pub night_darkness: f32,
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
fn default_glow() -> f32 {
    1.0
}

impl Default for DayNightVisualConfig {
    fn default() -> Self {
        Self {
            night_darkness: default_night_darkness(),
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

/// Sun illuminance and ambient brightness for a given daylight fraction.
///
/// `day` runs 0 (deepest night) to 1 (noon). The night floors come from
/// `render.ron` because they have to be re-tuned whenever the tone mapping
/// curve changes — a filmic curve crushes exactly the range they live in.
/// `sun.illuminance_scale` multiplies the sun alone: the ambient is the sky, not
/// the sun, and dimming both would only repeat what the floors already do.
pub fn lighting_levels(day: f32, night: NightConfig, sun: &SunConfig) -> (f32, f32) {
    let day = day.clamp(0.0, 1.0);
    let illuminance = sun.day_illuminance
        * (night.sun_floor + (1.0 - night.sun_floor) * day)
        * sun.illuminance_scale.max(0.0);
    let ambient = sun.day_ambient * (night.ambient_floor + (1.0 - night.ambient_floor) * day);
    (illuminance, ambient)
}

#[allow(clippy::too_many_arguments)] // more Res than clippy's default limit
fn drive_day_night_lighting(
    city: Res<City>,
    visual: Res<DayNightVisualConfig>,
    render_cfg: Option<Res<RenderConfig>>,
    props_cfg: Option<Res<PropsConfig>>,
    glow: Res<NightGlow>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut q_sun: Query<&mut DirectionalLight>,
    mut q_ambient: Query<&mut AmbientLight, With<MainCamera>>,
    ui: Option<Res<UiState>>,
    mut last_hour: Local<Option<u8>>,
) {
    // A data map is read in daylight: night would darken exactly what the player is reading.
    let hour = if ui.is_some_and(|ui| ui.overlay.is_data_map()) {
        12
    } else {
        city.hour
    };
    // Mutating shared materials re-prepares every entity that uses them
    // (thousands of markings/windows) — only touch them when the hour flips.
    if *last_hour == Some(hour) {
        return;
    }
    *last_hour = Some(hour);

    // 0 at noon, up to ~1 at midnight, scaled by the configured darkness.
    let darkness = (night_factor(hour) * (visual.night_darkness / 0.55)).clamp(0.0, 1.0);
    let day = 1.0 - darkness;

    let render_cfg = render_cfg.map(|c| *c).unwrap_or_default();
    let (sun_lux, ambient_brightness) = lighting_levels(day, render_cfg.night, &render_cfg.sun);

    // Sun: bright warm white by day -> dim cool "moon" at night.
    for mut sun in q_sun.iter_mut() {
        sun.illuminance = sun_lux;
        sun.color = Color::srgb(0.60 + 0.40 * day, 0.68 + 0.30 * day, 1.0 - 0.08 * day);
    }
    for mut ambient in q_ambient.iter_mut() {
        ambient.brightness = ambient_brightness;
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
    // Shop signs: a painted board by day, lit after dark. Strength is a knob
    // because a sign is the brightest thing in a night frame and overshooting
    // it blooms the whole street.
    let sign_cfg = props_cfg.map(|c| c.sign).unwrap_or_default();
    if let Some(mut m) = materials.get_mut(&glow.signs) {
        let k = sign_cfg.night_emissive * night;
        m.base_color = SIGN_DAY_COLOR;
        m.emissive = LinearRgba::rgb(k, 0.62 * k, 0.30 * k);
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
                illuminance: SunConfig::default().day_illuminance,
                ..Default::default()
            })
            .id();
        app.world_mut().spawn((
            MainCamera,
            AmbientLight {
                brightness: SunConfig::default().day_ambient,
                ..Default::default()
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
        // Floor is config-driven now (default 0.10) and was raised for ACES;
        // the pin still checks "much dimmer than noon", at the new level.
        assert!(
            sun_lux(&app) < SunConfig::default().day_illuminance * 0.15,
            "sun nearly off at midnight"
        );

        app.world_mut().resource_mut::<City>().hour = 12;
        app.update();
        assert!(windows_emissive(&app) < 0.01, "windows dark glass at noon");
        assert!(
            sun_lux(&app) > SunConfig::default().day_illuminance * 0.9,
            "full sun at noon"
        );
    }

    /// Shop signs are the one prop meant to be seen after dark, and they ride
    /// the same shared material as the windows: one asset write lights the
    /// whole city rather than a per-entity pass.
    #[test]
    fn shop_signs_light_up_after_dark_and_go_out_at_noon() {
        let mut app = App::new();
        render_primitives::init_for_test(&mut app);
        app.init_resource::<DayNightVisualConfig>();
        app.insert_resource(City {
            hour: 0,
            ..Default::default()
        });
        app.world_mut().spawn(DirectionalLight::default());
        app.world_mut().spawn((MainCamera, AmbientLight::default()));
        app.add_systems(Update, drive_day_night_lighting);

        app.update();
        let glow = app.world().resource::<NightGlow>().clone();
        let sign_emissive = |app: &App| {
            app.world()
                .resource::<Assets<StandardMaterial>>()
                .get(&glow.signs)
                .unwrap()
                .emissive
                .red
        };
        assert!(sign_emissive(&app) > 1.0, "signs glow at midnight");

        app.world_mut().resource_mut::<City>().hour = 12;
        app.update();
        assert!(sign_emissive(&app) < 0.01, "signs are unlit at noon");
    }

    #[test]
    fn daytime_anchors_come_from_the_config() {
        let night = NightConfig::default();
        let dim = SunConfig {
            day_illuminance: 6_000.0,
            day_ambient: 350.0,
            ..SunConfig::default()
        };
        let (sun, ambient) = lighting_levels(1.0, night, &dim);
        assert!(
            (sun - 6_000.0).abs() < 1e-3,
            "noon sun follows the config, got {sun}"
        );
        assert!(
            (ambient - 350.0).abs() < 1e-3,
            "noon ambient follows the config, got {ambient}"
        );

        // The floors stay fractions of whatever the config says day is.
        let (night_sun, night_ambient) = lighting_levels(0.0, night, &dim);
        assert!((night_sun - 6_000.0 * night.sun_floor).abs() < 1e-3);
        assert!((night_ambient - 350.0 * night.ambient_floor).abs() < 1e-3);
    }

    #[test]
    fn illuminance_scale_multiplies_the_sun_at_every_hour() {
        let night = NightConfig::default();
        let (plain_noon, ambient_noon) = lighting_levels(1.0, night, &SunConfig::default());
        let (dim_noon, dim_ambient) = lighting_levels(
            1.0,
            night,
            &SunConfig {
                illuminance_scale: 0.5,
                ..SunConfig::default()
            },
        );
        assert!(
            (dim_noon - plain_noon * 0.5).abs() < 1e-3,
            "scale must reach the sun: {dim_noon} against {plain_noon}"
        );
        assert!(
            (dim_ambient - ambient_noon).abs() < 1e-3,
            "the scale is the sun's, not the ambient's"
        );

        let (plain_night, _) = lighting_levels(0.0, night, &SunConfig::default());
        let (bright_night, _) = lighting_levels(
            0.0,
            night,
            &SunConfig {
                illuminance_scale: 2.0,
                ..SunConfig::default()
            },
        );
        assert!((bright_night - plain_night * 2.0).abs() < 1e-3);
    }

    #[test]
    fn lighting_levels_interpolate_between_the_configured_night_floor_and_full_day() {
        let night = NightConfig {
            sun_floor: 0.10,
            ambient_floor: 0.45,
        };
        let sun_cfg = SunConfig::default();

        let (sun_midnight, ambient_midnight) = lighting_levels(0.0, night, &sun_cfg);
        assert!((sun_midnight - SunConfig::default().day_illuminance * 0.10).abs() < 1e-3);
        assert!((ambient_midnight - SunConfig::default().day_ambient * 0.45).abs() < 1e-3);

        let (sun_noon, ambient_noon) = lighting_levels(1.0, night, &sun_cfg);
        assert!((sun_noon - SunConfig::default().day_illuminance).abs() < 1e-3);
        assert!((ambient_noon - SunConfig::default().day_ambient).abs() < 1e-3);

        // Halfway is halfway between floor and full, not half of full.
        let (sun_half, _) = lighting_levels(0.5, night, &sun_cfg);
        assert!(
            (sun_half - SunConfig::default().day_illuminance * 0.55).abs() < 1e-3,
            "got {sun_half}"
        );

        // A darker configuration really is darker — the floors are live knobs.
        let darker = NightConfig {
            sun_floor: 0.02,
            ambient_floor: 0.10,
        };
        assert!(lighting_levels(0.0, darker, &sun_cfg).0 < sun_midnight);
        assert!(lighting_levels(0.0, darker, &sun_cfg).1 < ambient_midnight);

        // Out-of-range input is clamped rather than extrapolated.
        assert!(
            (lighting_levels(2.0, night, &sun_cfg).0 - SunConfig::default().day_illuminance).abs()
                < 1e-3
        );
        assert!(
            (lighting_levels(-1.0, night, &sun_cfg).0
                - SunConfig::default().day_illuminance * 0.10)
                .abs()
                < 1e-3
        );
    }

    /// Night darkens the whole map, and a data map read in the dark is not read: while one is
    /// on the lighting is noon's, and it goes back to the clock's hour when the map is off.
    #[test]
    fn a_data_map_is_read_in_daylight_whatever_the_hour() {
        use crate::game::ui_state::{OverlayMode, UiState};

        let mut app = App::new();
        render_primitives::init_for_test(&mut app);
        app.init_resource::<DayNightVisualConfig>();
        app.insert_resource(City {
            hour: 0,
            ..Default::default()
        });
        app.insert_resource(UiState {
            overlay: OverlayMode::LandValue,
            ..Default::default()
        });
        let sun = app.world_mut().spawn(DirectionalLight::default()).id();
        app.world_mut().spawn((MainCamera, AmbientLight::default()));
        app.add_systems(Update, drive_day_night_lighting);
        let sun_lux = |app: &App| {
            app.world()
                .get::<DirectionalLight>(sun)
                .unwrap()
                .illuminance
        };

        app.update();
        assert!(
            sun_lux(&app) > SunConfig::default().day_illuminance * 0.9,
            "midnight, but the land value map is on: full sun"
        );

        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::None;
        app.update();
        assert!(
            sun_lux(&app) < SunConfig::default().day_illuminance * 0.15,
            "the map is off: back to midnight"
        );
    }
}
