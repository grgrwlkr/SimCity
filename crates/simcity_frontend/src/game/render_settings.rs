//! Applies `RenderConfig` (assets/config/render.ron) to the camera and the sun.
//!
//! The config is data; this module is the single place that turns it into Bevy
//! components. It runs on insert and on change, never per frame — mutating
//! camera/light components every frame re-prepares their render state, which the
//! pseudo-3D work already paid for once (60 -> 19 FPS, see the phase 7 notes).

use bevy::anti_alias::fxaa::Fxaa;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::{CascadeShadowConfigBuilder, DirectionalLight};
use bevy::pbr::{ScreenSpaceAmbientOcclusion, ScreenSpaceAmbientOcclusionQualityLevel};
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use bevy::render::view::ColorGrading;

use crate::game::camera::MainCamera;
use crate::game::sets::GameSet;
use simcity_core::game::render_config::{
    AntiAliasing, RenderConfig, SsaoQuality, TonemappingCurve,
};

pub struct RenderSettingsPlugin;

impl Plugin for RenderSettingsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, apply_render_config.in_set(GameSet::RenderSync));
    }
}

/// Bevy's tone mapping curve for a configured one.
pub fn tonemapping_of(curve: TonemappingCurve) -> Tonemapping {
    match curve {
        TonemappingCurve::None => Tonemapping::None,
        TonemappingCurve::AcesFitted => Tonemapping::AcesFitted,
        TonemappingCurve::TonyMcMapface => Tonemapping::TonyMcMapface,
    }
}

/// Bevy's SSAO quality level for a configured one.
pub fn ssao_quality_of(quality: SsaoQuality) -> ScreenSpaceAmbientOcclusionQualityLevel {
    use ScreenSpaceAmbientOcclusionQualityLevel as Q;
    match quality {
        SsaoQuality::Low => Q::Low,
        SsaoQuality::Medium => Q::Medium,
        SsaoQuality::High => Q::High,
        SsaoQuality::Ultra => Q::Ultra,
    }
}

/// Unit vector pointing from the sun toward the world origin.
///
/// The world is Z-up: azimuth sweeps the XY plane clockwise from +Y, elevation
/// lifts toward +Z. A low elevation is what makes shadows long.
pub fn sun_direction(elevation_deg: f32, azimuth_deg: f32) -> Vec3 {
    let elevation = elevation_deg.to_radians();
    let azimuth = azimuth_deg.to_radians();
    let position = Vec3::new(
        elevation.cos() * azimuth.sin(),
        elevation.cos() * azimuth.cos(),
        elevation.sin(),
    );
    (-position).normalize()
}

#[allow(clippy::type_complexity)]
fn apply_render_config(
    cfg: Option<Res<RenderConfig>>,
    mut applied: Local<bool>,
    mut commands: Commands,
    mut q_camera: Query<(Entity, &mut Tonemapping, &mut ColorGrading), With<MainCamera>>,
    mut q_sun: Query<
        (Entity, &mut Transform, &mut DirectionalLight),
        (With<DirectionalLight>, Without<MainCamera>),
    >,
) {
    let Some(cfg) = cfg else {
        return;
    };
    if *applied && !cfg.is_changed() {
        return;
    }

    let Ok((camera, mut tonemapping, mut grading)) = q_camera.single_mut() else {
        // The camera spawns in Startup; if it is not here yet, try again next frame
        // rather than marking the config applied.
        return;
    };

    *tonemapping = tonemapping_of(cfg.tonemapping);

    grading.global.exposure = cfg.color_grading.exposure;
    // Same curve in shadows, midtones and highlights: the config exposes one
    // global grade, not a per-section one.
    let section = bevy::render::view::ColorGradingSection {
        contrast: cfg.color_grading.contrast,
        saturation: cfg.color_grading.saturation,
        gamma: cfg.color_grading.gamma,
        ..default()
    };
    grading.shadows = section;
    grading.midtones = section;
    grading.highlights = section;

    let mut camera_cmd = commands.entity(camera);
    if cfg.bloom.enabled {
        camera_cmd.insert(Bloom {
            intensity: cfg.bloom.intensity,
            low_frequency_boost: cfg.bloom.low_frequency_boost,
            max_mip_dimension: cfg.bloom.max_mip_dimension,
            ..Bloom::NATURAL
        });
    } else {
        camera_cmd.remove::<Bloom>();
    }
    if cfg.ssao.enabled {
        camera_cmd.insert(ScreenSpaceAmbientOcclusion {
            quality_level: ssao_quality_of(cfg.ssao.quality),
            ..default()
        });
    } else {
        camera_cmd.remove::<ScreenSpaceAmbientOcclusion>();
    }

    // Bevy rejects SSAO on a multisampled target, so SSAO decides this and the
    // configured method only gets a say when SSAO is off.
    let anti_aliasing = if cfg.ssao.enabled && cfg.anti_aliasing == AntiAliasing::Msaa4 {
        AntiAliasing::Fxaa
    } else {
        cfg.anti_aliasing
    };
    match anti_aliasing {
        AntiAliasing::Msaa4 => {
            camera_cmd.insert(Msaa::Sample4).remove::<Fxaa>();
        }
        AntiAliasing::Fxaa => {
            camera_cmd.insert((Msaa::Off, Fxaa::default()));
        }
        AntiAliasing::None => {
            camera_cmd.insert(Msaa::Off).remove::<Fxaa>();
        }
    }

    for (sun, mut transform, mut light) in q_sun.iter_mut() {
        // Zero means hard edges; Bevy reads `None` that way and a `Some(0.0)`
        // would still pay for the percentage-closer soft-shadow path.
        light.soft_shadow_size = (cfg.shadows.soft_size > 0.0).then_some(cfg.shadows.soft_size);

        let direction = sun_direction(cfg.sun.noon_elevation_deg, cfg.sun.azimuth_deg);
        // Keep the light well outside the map so its cascades cover the city.
        *transform = Transform::from_translation(-direction * 400.0).looking_to(direction, Vec3::Z);
        commands.entity(sun).insert(
            CascadeShadowConfigBuilder {
                num_cascades: cfg.shadows.cascades,
                minimum_distance: 0.1,
                maximum_distance: cfg.shadows.maximum_distance,
                first_cascade_far_bound: cfg.shadows.first_slice_depth,
                overlap_proportion: cfg.shadows.overlap_proportion,
            }
            .build(),
        );
    }

    *applied = true;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tonemapping_maps_every_configured_curve() {
        assert_eq!(tonemapping_of(TonemappingCurve::None), Tonemapping::None);
        assert_eq!(
            tonemapping_of(TonemappingCurve::AcesFitted),
            Tonemapping::AcesFitted
        );
        assert_eq!(
            tonemapping_of(TonemappingCurve::TonyMcMapface),
            Tonemapping::TonyMcMapface
        );
    }

    #[test]
    fn ssao_quality_maps_every_configured_level() {
        use ScreenSpaceAmbientOcclusionQualityLevel as Q;
        assert_eq!(ssao_quality_of(SsaoQuality::Low), Q::Low);
        assert_eq!(ssao_quality_of(SsaoQuality::Medium), Q::Medium);
        assert_eq!(ssao_quality_of(SsaoQuality::High), Q::High);
        assert_eq!(ssao_quality_of(SsaoQuality::Ultra), Q::Ultra);
    }

    fn app_with(cfg: RenderConfig) -> (App, Entity, Entity) {
        let mut app = App::new();
        let camera = app
            .world_mut()
            .spawn((
                MainCamera,
                Tonemapping::None,
                ColorGrading::default(),
                Transform::default(),
            ))
            .id();
        let sun = app
            .world_mut()
            .spawn((DirectionalLight::default(), Transform::default()))
            .id();
        app.insert_resource(cfg);
        app.add_systems(Update, apply_render_config);
        app.update();
        (app, camera, sun)
    }

    #[test]
    fn config_reaches_the_camera_and_the_sun() {
        let cfg = RenderConfig::default();
        let (app, camera, sun) = app_with(cfg);
        let world = app.world();

        assert_eq!(
            *world.get::<Tonemapping>(camera).unwrap(),
            Tonemapping::AcesFitted,
            "the flat Tonemapping::None must be replaced"
        );

        let bloom = world.get::<Bloom>(camera).expect("bloom should be enabled");
        assert!((bloom.intensity - cfg.bloom.intensity).abs() < 1e-6);
        assert_eq!(bloom.max_mip_dimension, cfg.bloom.max_mip_dimension);

        let ssao = world
            .get::<ScreenSpaceAmbientOcclusion>(camera)
            .expect("ssao should be enabled");
        assert_eq!(
            ssao.quality_level,
            ScreenSpaceAmbientOcclusionQualityLevel::Medium
        );

        let grading = world.get::<ColorGrading>(camera).unwrap();
        assert!((grading.global.exposure - cfg.color_grading.exposure).abs() < 1e-6);
        assert!((grading.midtones.contrast - cfg.color_grading.contrast).abs() < 1e-6);
        assert!((grading.shadows.saturation - cfg.color_grading.saturation).abs() < 1e-6);

        let expected = sun_direction(cfg.sun.noon_elevation_deg, cfg.sun.azimuth_deg);
        let actual = world.get::<Transform>(sun).unwrap().forward().as_vec3();
        assert!(
            actual.abs_diff_eq(expected, 1e-4),
            "sun should face {expected:?}, faces {actual:?}"
        );
        assert!(
            world.get::<bevy::light::CascadeShadowConfig>(sun).is_some(),
            "cascades must be rebuilt from the config"
        );
    }

    #[test]
    fn soft_shadow_size_reaches_the_sun_and_zero_means_hard_edges() {
        let mut cfg = RenderConfig::default();
        cfg.shadows.soft_size = 2.5;
        let (app, _, sun) = app_with(cfg);
        let light = app.world().get::<DirectionalLight>(sun).unwrap();
        assert_eq!(light.soft_shadow_size, Some(2.5));

        let mut off = RenderConfig::default();
        off.shadows.soft_size = 0.0;
        let (app, _, sun) = app_with(off);
        let light = app.world().get::<DirectionalLight>(sun).unwrap();
        assert_eq!(
            light.soft_shadow_size, None,
            "zero must mean hard shadows, not a zero-width penumbra"
        );
    }

    #[test]
    fn ssao_forces_msaa_off_and_falls_back_to_fxaa() {
        // Bevy refuses to run SSAO with MSAA on, so a file asking for both must
        // resolve to SSAO + FXAA rather than to a log full of errors.
        let mut cfg = RenderConfig::default();
        cfg.ssao.enabled = true;
        cfg.anti_aliasing = AntiAliasing::Msaa4;
        let (app, camera, _) = app_with(cfg);
        let world = app.world();

        assert_eq!(*world.get::<Msaa>(camera).unwrap(), Msaa::Off);
        assert!(
            world.get::<Fxaa>(camera).is_some(),
            "edges still need anti-aliasing once MSAA is gone"
        );
    }

    #[test]
    fn msaa_survives_when_ssao_is_off() {
        let mut cfg = RenderConfig::default();
        cfg.ssao.enabled = false;
        cfg.anti_aliasing = AntiAliasing::Msaa4;
        let (app, camera, _) = app_with(cfg);
        let world = app.world();

        assert_eq!(*world.get::<Msaa>(camera).unwrap(), Msaa::Sample4);
        assert!(world.get::<Fxaa>(camera).is_none());
    }

    #[test]
    fn disabled_effects_are_removed_not_merely_ignored() {
        let mut cfg = RenderConfig::default();
        cfg.bloom.enabled = false;
        cfg.ssao.enabled = false;
        let (app, camera, _) = app_with(cfg);
        let world = app.world();

        assert!(world.get::<Bloom>(camera).is_none());
        assert!(world.get::<ScreenSpaceAmbientOcclusion>(camera).is_none());
    }

    #[test]
    fn sun_direction_points_down_from_overhead_and_sideways_from_the_horizon() {
        // Straight overhead: the light travels straight down.
        let overhead = sun_direction(90.0, 0.0);
        assert!(
            overhead.abs_diff_eq(Vec3::new(0.0, 0.0, -1.0), 1e-5),
            "overhead sun should point down, got {overhead:?}"
        );

        // On the horizon due north (+Y): the light travels toward -Y, flat.
        let horizon = sun_direction(0.0, 0.0);
        assert!(
            horizon.abs_diff_eq(Vec3::new(0.0, -1.0, 0.0), 1e-5),
            "horizon sun should point sideways, got {horizon:?}"
        );

        // A low sun stays mostly horizontal — that is what makes shadows long.
        let low = sun_direction(15.0, 135.0);
        assert!(low.is_normalized(), "direction must be a unit vector");
        assert!(
            low.z < -0.2 && low.z > -0.3,
            "15 degrees of elevation should tilt the light only slightly, got z={}",
            low.z
        );
    }
}
