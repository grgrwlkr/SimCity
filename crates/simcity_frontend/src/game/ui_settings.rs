//! UI settings system - stores and loads UI preferences.

use bevy::prelude::*;
use bevy_egui::{EguiContexts, egui};
use serde::{Deserialize, Serialize};

use crate::game::sets::GameSet;
use crate::game::state::AppState;
use simcity_core::game::render_config::RenderConfig;

/// UI theme options
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize, Default)]
pub enum UiTheme {
    Light,
    Dark,
    #[default]
    Auto,
}

/// UI settings resource
#[derive(Resource, Debug, Clone, Serialize, Deserialize)]
pub struct UiSettings {
    pub font_scale: f32,
    pub show_minimap: bool,
    pub show_stats: bool,
    pub theme: UiTheme,
    pub camera_speed: f32,
    pub zoom_speed: f32,
    /// Zoom easing snappiness (per-second exponential rate; higher = snappier).
    #[serde(default = "default_zoom_ease")]
    pub zoom_ease: f32,
    /// Q/E orbit speed, radians per second.
    #[serde(default = "default_rotate_speed")]
    pub rotate_speed: f32,
}

fn default_zoom_ease() -> f32 {
    5.0
}

fn default_rotate_speed() -> f32 {
    1.6
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            font_scale: 1.0,
            show_minimap: true,
            show_stats: true,
            theme: UiTheme::Auto,
            camera_speed: 200.0,
            zoom_speed: 0.1,
            zoom_ease: default_zoom_ease(),
            rotate_speed: default_rotate_speed(),
        }
    }
}

pub struct UiSettingsPlugin;

impl Plugin for UiSettingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<UiSettings>().add_systems(
            Update,
            settings_ui
                .in_set(GameSet::Ui)
                .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
        );
    }
}

/// Settings UI panel
fn settings_ui(
    mut contexts: EguiContexts,
    mut settings: ResMut<UiSettings>,
    render: Option<ResMut<RenderConfig>>,
    mut show_settings: Local<bool>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    // Toggle with F10 key
    let keys = ctx.input(|i| i.key_pressed(egui::Key::F10));
    if keys {
        *show_settings = !*show_settings;
    }

    if !*show_settings {
        return;
    }

    egui::Window::new("Settings")
        .collapsible(false)
        .resizable(true)
        .default_size(egui::vec2(400.0, 500.0))
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .show(&*ctx, |ui| {
            ui.heading("UI Settings");
            ui.separator();

            ui.label("Font Scale:");
            ui.add(egui::Slider::new(&mut settings.font_scale, 0.5..=2.0));

            ui.separator();

            ui.checkbox(&mut settings.show_minimap, "Show Minimap");
            ui.checkbox(&mut settings.show_stats, "Show Statistics");

            ui.separator();

            ui.label("Theme:");
            ui.horizontal(|ui| {
                ui.selectable_value(&mut settings.theme, UiTheme::Light, "Light");
                ui.selectable_value(&mut settings.theme, UiTheme::Dark, "Dark");
                ui.selectable_value(&mut settings.theme, UiTheme::Auto, "Auto");
            });

            ui.separator();
            ui.heading("Camera Settings");

            ui.label("Camera Speed:");
            ui.add(egui::Slider::new(&mut settings.camera_speed, 50.0..=500.0));

            ui.label("Zoom Speed:");
            ui.add(egui::Slider::new(&mut settings.zoom_speed, 0.05..=0.5));
            ui.label("Zoom smoothing (higher = snappier)");
            ui.add(egui::Slider::new(&mut settings.zoom_ease, 1.0..=15.0));
            ui.label("Rotate speed (Q/E)");
            ui.add(egui::Slider::new(&mut settings.rotate_speed, 0.4..=4.0));

            if let Some(mut render) = render {
                ui.separator();
                ui.heading("Look");
                // Touching the resource marks it changed, and `render_settings`
                // re-applies it on the next frame — no restart needed.
                let r = render.bypass_change_detection();
                let before = *r;

                ui.label("Exposure (stops)");
                ui.add(egui::Slider::new(&mut r.color_grading.exposure, -2.0..=2.0));
                ui.label("Contrast");
                ui.add(egui::Slider::new(&mut r.color_grading.contrast, 0.5..=2.0));
                ui.label("Saturation");
                ui.add(egui::Slider::new(
                    &mut r.color_grading.saturation,
                    0.0..=2.0,
                ));

                ui.label("Sun elevation (deg) — lower is longer shadows");
                ui.add(egui::Slider::new(&mut r.sun.noon_elevation_deg, 5.0..=85.0));
                ui.label("Sun azimuth (deg)");
                ui.add(egui::Slider::new(&mut r.sun.azimuth_deg, 0.0..=360.0));

                ui.label("Night floor — ambient");
                ui.add(egui::Slider::new(&mut r.night.ambient_floor, 0.0..=1.0));

                ui.checkbox(&mut r.vignette.enabled, "Vignette");
                ui.add(egui::Slider::new(&mut r.vignette.strength, 0.0..=1.0));

                ui.checkbox(
                    &mut r.bloom.enabled,
                    "Bloom (costs ~5 ms: forces an HDR target)",
                );
                ui.checkbox(&mut r.ssao.enabled, "SSAO (forces MSAA off)");

                let changed = !render_config_eq(&before, render.bypass_change_detection());
                if changed {
                    render.set_changed();
                }
            }

            ui.separator();

            if ui.button("Reset to Defaults").clicked() {
                *settings = UiSettings::default();
            }

            ui.separator();
            ui.label("Press F10 to toggle this panel");
        });
}

/// Field-wise comparison of the two render configs the settings panel can edit.
///
/// `RenderConfig` holds floats and so cannot derive `PartialEq` without inviting
/// clippy's float-cmp lint at every call site; here an exact comparison is the
/// right test — the question is "did a slider move", not "are these close".
fn render_config_eq(a: &RenderConfig, b: &RenderConfig) -> bool {
    a.color_grading.exposure.to_bits() == b.color_grading.exposure.to_bits()
        && a.color_grading.contrast.to_bits() == b.color_grading.contrast.to_bits()
        && a.color_grading.saturation.to_bits() == b.color_grading.saturation.to_bits()
        && a.sun.noon_elevation_deg.to_bits() == b.sun.noon_elevation_deg.to_bits()
        && a.sun.azimuth_deg.to_bits() == b.sun.azimuth_deg.to_bits()
        && a.night.ambient_floor.to_bits() == b.night.ambient_floor.to_bits()
        && a.vignette.enabled == b.vignette.enabled
        && a.vignette.strength.to_bits() == b.vignette.strength.to_bits()
        && a.bloom.enabled == b.bloom.enabled
        && a.ssao.enabled == b.ssao.enabled
}
