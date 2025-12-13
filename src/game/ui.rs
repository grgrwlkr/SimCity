use bevy::ecs::message::MessageWriter;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy_egui::{EguiContexts, EguiPlugin, EguiPrimaryContextPass, egui};

use crate::game::commands::GameCommand;
use crate::game::map::BuildMode;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::ui_state::{OverlayMode, SimSpeed, ToolMode, UiState};

pub struct UiPlugin;

impl Plugin for UiPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(EguiPlugin::default())
            .add_systems(OnEnter(AppState::MainMenu), announce_main_menu)
            .add_systems(OnEnter(AppState::InGame), announce_ingame)
            .add_systems(OnEnter(AppState::Paused), announce_paused)
            .add_systems(EguiPrimaryContextPass, top_bar_ui)
            .add_systems(Update, update_window_title);
    }
}

fn announce_main_menu() {
    info!("Main menu");
    info!("Controls:");
    info!("  Enter  - start / continue");
    info!("  Esc    - back to menu");
}

fn announce_ingame() {
    info!("In game");
    info!("Controls:");
    info!("  WASD / Arrows - pan camera");
    info!("  Mouse wheel   - zoom");
    info!("  1 Road, 2 Residential, 3 Commercial, 4 Industrial, 5 Grass");
    info!("  LMB on tile   - build");
    info!("  Space         - pause");
    info!("  Esc           - back to menu");
}

fn announce_paused() {
    info!("Paused (Space to resume)");
}

fn update_window_title(
    state: Res<State<AppState>>,
    q_window: Query<Entity, With<PrimaryWindow>>,
    mut q_windows: Query<&mut Window>,
    city: Res<City>,
    mode: Res<BuildMode>,
) {
    let Ok(window_entity) = q_window.single() else {
        return;
    };
    let Ok(mut window) = q_windows.get_mut(window_entity) else {
        return;
    };

    let title = match state.get() {
        AppState::MainMenu => "SimCity (Bevy) — Enter to start".to_string(),
        AppState::InGame => format!(
            "SimCity (Bevy) — Day {} | $ {} | Pop {} | Build: {:?}",
            city.day, city.money, city.population, mode.selected
        ),
        AppState::Paused => format!(
            "SimCity (Bevy) — PAUSED — Day {} | $ {} | Pop {} | Build: {:?}",
            city.day, city.money, city.population, mode.selected
        ),
    };

    if window.title != title {
        window.title = title;
    }
}

fn top_bar_ui(
    mut contexts: EguiContexts,
    mut ui_state: ResMut<UiState>,
    state: Res<State<AppState>>,
    mut next_state: ResMut<NextState<AppState>>,
    city: Res<City>,
    mode: Res<BuildMode>,
    mut commands: MessageWriter<GameCommand>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    egui::TopBottomPanel::top("top_bar").show(&*ctx, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.label("SimCity");
            ui.separator();

            // Sim speed
            ui.label("Speed:");
            for (label, speed) in [
                ("Pause", SimSpeed::Paused),
                ("1x", SimSpeed::X1),
                ("2x", SimSpeed::X2),
                ("4x", SimSpeed::X4),
            ] {
                ui.selectable_value(&mut ui_state.sim_speed, speed, label);
            }

            ui.separator();

            // Tool selection
            ui.label("Tool:");
            for (label, tool) in [
                ("Road", ToolMode::Road),
                ("R", ToolMode::Residential),
                ("C", ToolMode::Commercial),
                ("I", ToolMode::Industrial),
                ("Erase", ToolMode::Erase),
                ("Inspect", ToolMode::Inspect),
            ] {
                ui.selectable_value(&mut ui_state.tool, tool, label);
            }

            ui.separator();

            // Overlay selection (wired later; saved now)
            ui.label("Overlay:");
            for (label, overlay) in [
                ("None", OverlayMode::None),
                ("Water", OverlayMode::Water),
                ("Height", OverlayMode::Height),
                ("Zones", OverlayMode::Zones),
                ("Roads", OverlayMode::Roads),
                ("Traffic", OverlayMode::Traffic),
                ("Path", OverlayMode::Path),
            ] {
                ui.selectable_value(&mut ui_state.overlay, overlay, label);
            }

            ui.separator();

            // Map seed + generation
            ui.label("Seed:");
            ui.text_edit_singleline(&mut ui_state.seed_text);
            let seed = ui_state.seed_text.trim().parse::<u64>().unwrap_or(1);
            if ui.button("New Map").clicked() {
                commands.write(GameCommand::GenerateMap { seed });
                next_state.set(AppState::InGame);
            }

            ui.separator();

            // Quick status line
            ui.label(format!(
                "Day {} | $ {} | Pop {} | Build {:?}",
                city.day, city.money, city.population, mode.selected
            ));

            // State control hints
            match state.get() {
                AppState::MainMenu => {
                    if ui.button("Start").clicked() {
                        next_state.set(AppState::InGame);
                    }
                }
                AppState::InGame => {
                    if ui.button("Pause").clicked() {
                        next_state.set(AppState::Paused);
                    }
                }
                AppState::Paused => {
                    if ui.button("Resume").clicked() {
                        next_state.set(AppState::InGame);
                    }
                }
            }
        });
    });
}
