//! The game interface: what a player sees and touches, built on `bevy_ui`.
//!
//! The egui panels in `ui` are developer tools and ship only under `dev`. Everything here is the
//! player's interface, drawn from the tokens in [`theme`] so it reads as one visual language.

use bevy::asset::embedded_asset;
use bevy::picking::PickingSystems;
use bevy::prelude::*;
use simcity_core::game::sets::GameSet;
use simcity_core::game::ui_state::PointerOverGameUi;

pub mod advisor_panel;
pub mod budget_panel;
pub mod data_map_panel;
pub mod glass;
pub mod hud_bar;
pub mod pointer;
pub mod start_screen;
pub mod theme;
pub mod tile_tooltip;
pub mod toasts;
pub mod tool_palette;

/// Registers the game interface: its material, its visual language and its pieces.
pub struct HudPlugin;

impl Plugin for HudPlugin {
    fn build(&self, app: &mut App) {
        // Embedded, not loaded from `assets/`: a shader resolved against the working directory
        // silently goes missing when the game is started from anywhere but the repository root.
        embedded_asset!(app, "glass.wgsl");
        app.init_resource::<theme::Theme>()
            .add_plugins(UiMaterialPlugin::<glass::GlassMaterial>::default())
            .init_resource::<PointerOverGameUi>()
            .add_observer(hud_bar::on_speed_button)
            .add_observer(tool_palette::on_tool_button)
            .add_observer(toasts::on_toast)
            .add_observer(data_map_panel::on_overlay_button)
            .add_observer(start_screen::on_menu_action)
            .init_resource::<budget_panel::BudgetPanelOpen>()
            .add_observer(budget_panel::on_budget_action)
            .init_resource::<advisor_panel::AdvisorPanelOpen>()
            .add_observer(advisor_panel::on_advisor_action)
            .add_systems(Startup, spawn_game_ui)
            // Straight after hover is computed, so every consumer of the frame reads it fresh.
            .add_systems(
                PreUpdate,
                pointer::track_pointer_over_game_ui.after(PickingSystems::Hover),
            )
            .add_systems(
                Update,
                (
                    hud_bar::update_hud_bar,
                    tool_palette::update_tool_palette,
                    toasts::update_toast_feed,
                    tile_tooltip::update_tile_tooltip,
                    tile_tooltip::place_tile_tooltip,
                    (
                        data_map_panel::update_data_map_panel,
                        data_map_panel::update_overlay_reading,
                    )
                        .chain(),
                    start_screen::update_scenario_list,
                    start_screen::show_screens_for_state,
                    budget_panel::update_budget_panel,
                    advisor_panel::update_advisor_panel,
                )
                    .in_set(GameSet::Ui),
            );
    }
}

fn spawn_game_ui(
    mut commands: Commands,
    theme: Res<theme::Theme>,
    mut materials: ResMut<Assets<glass::GlassMaterial>>,
) {
    let glass = materials.add(glass::GlassMaterial::from_theme(&theme));
    let bar = hud_bar::spawn_hud_bar(&mut commands, &theme, glass.clone());
    budget_panel::spawn_budget_toggle(&mut commands, &theme, bar);
    advisor_panel::spawn_advisor_toggle(&mut commands, &theme, bar);
    budget_panel::spawn_budget_panel(&mut commands, &theme, glass.clone());
    advisor_panel::spawn_advisor_panel(&mut commands, &theme, glass.clone());
    data_map_panel::spawn_data_map_panel(&mut commands, &theme, glass.clone());
    start_screen::spawn_start_screen(&mut commands, &theme, glass.clone());
    tool_palette::spawn_tool_palette(&mut commands, &theme, glass);
    toasts::spawn_toast_feed(&mut commands, &theme);
    tile_tooltip::spawn_tile_tooltip(&mut commands, &theme);
}
