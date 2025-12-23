//! UI settings system - stores and loads UI preferences.

use bevy::prelude::*;
use bevy_egui::{EguiContexts, egui};
use serde::{Deserialize, Serialize};

use crate::game::sets::GameSet;
use crate::game::state::AppState;

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
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        );
    }
}

/// Settings UI panel
fn settings_ui(
    mut contexts: EguiContexts,
    mut settings: ResMut<UiSettings>,
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

            ui.separator();

            if ui.button("Reset to Defaults").clicked() {
                *settings = UiSettings::default();
            }

            ui.separator();
            ui.label("Press F10 to toggle this panel");
        });
}
