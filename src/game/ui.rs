use bevy::ecs::message::MessageWriter;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy_egui::{EguiContexts, EguiPlugin, EguiPrimaryContextPass, egui};

use crate::game::buildings::Building;
use crate::game::citizens::Citizen;
use crate::game::citizens::CommuteStats;
use crate::game::commands::GameCommand;
use crate::game::employment::EmploymentStats;
use crate::game::map::BuildMode;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::{TrafficIndex, Vehicle};
use crate::game::ui_state::{OverlayMode, SimSpeed, ToolMode, UiState};

pub struct UiPlugin;

impl Plugin for UiPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(EguiPlugin::default())
            .init_resource::<UiMetrics>()
            .add_systems(OnEnter(AppState::MainMenu), announce_main_menu)
            .add_systems(OnEnter(AppState::InGame), announce_ingame)
            .add_systems(OnEnter(AppState::Paused), announce_paused)
            .add_systems(EguiPrimaryContextPass, top_bar_ui)
            .add_systems(Update, update_ui_metrics.in_set(GameSet::Ui))
            .add_systems(Update, update_window_title.in_set(GameSet::Ui));
    }
}

#[derive(Resource, Default, Debug, Clone)]
struct UiMetrics {
    citizens: usize,
    vehicles: usize,
    buildings: usize,
    employed: usize,
    unemployed: usize,
    employment_rate: f32,
    avg_commute_secs: f32,
    traffic_avg: f32,
    traffic_max: f32,
}

fn update_ui_metrics(mut p: UiMetricsParams) {
    if !matches!(p.state.get(), AppState::InGame | AppState::Paused) {
        p.metrics.citizens = 0;
        p.metrics.vehicles = 0;
        p.metrics.buildings = 0;
        p.metrics.employed = 0;
        p.metrics.unemployed = 0;
        p.metrics.employment_rate = 0.0;
        p.metrics.avg_commute_secs = 0.0;
        p.metrics.traffic_avg = 0.0;
        p.metrics.traffic_max = 0.0;
        return;
    }
    p.metrics.citizens = p.q_citizens.iter().count();
    p.metrics.vehicles = p.q_vehicles.iter().count();
    p.metrics.buildings = p.q_buildings.iter().count();
    if let Some(e) = p.employment.as_deref() {
        p.metrics.employed = e.employed;
        p.metrics.unemployed = e.unemployed;
        p.metrics.employment_rate = e.employment_rate;
    } else {
        p.metrics.employed = 0;
        p.metrics.unemployed = 0;
        p.metrics.employment_rate = 0.0;
    }

    if let Some(c) = p.commute.as_deref() {
        p.metrics.avg_commute_secs = c.avg_commute_secs;
    } else {
        p.metrics.avg_commute_secs = 0.0;
    }

    if let Some(t) = p.traffic.as_deref() {
        p.metrics.traffic_avg = t.avg_congestion;
        p.metrics.traffic_max = t.max_congestion;
    } else {
        p.metrics.traffic_avg = 0.0;
        p.metrics.traffic_max = 0.0;
    }
}

#[derive(SystemParam)]
struct UiMetricsParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    metrics: ResMut<'w, UiMetrics>,
    employment: Option<Res<'w, EmploymentStats>>,
    traffic: Option<Res<'w, TrafficIndex>>,
    commute: Option<Res<'w, CommuteStats>>,
    q_citizens: Query<'w, 's, Entity, With<Citizen>>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    q_buildings: Query<'w, 's, Entity, With<Building>>,
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

fn top_bar_ui(mut contexts: EguiContexts, mut p: TopBarParams) {
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
                ui.selectable_value(&mut p.ui_state.sim_speed, speed, label);
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
                ui.selectable_value(&mut p.ui_state.tool, tool, label);
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
                ui.selectable_value(&mut p.ui_state.overlay, overlay, label);
            }

            ui.separator();

            // Map seed + generation
            ui.label("Seed:");
            ui.text_edit_singleline(&mut p.ui_state.seed_text);
            let seed = p.ui_state.seed_text.trim().parse::<u64>().unwrap_or(1);
            if ui.button("New Map").clicked() {
                p.commands.write(GameCommand::GenerateMap { seed });
                p.next_state.set(AppState::InGame);
            }

            ui.separator();

            if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                if ui.button("Spawn cars").clicked() {
                    p.commands.write(GameCommand::SpawnDebugVehicles { count: 25 });
                }
                if ui.button("Clear cars").clicked() {
                    p.commands.write(GameCommand::ClearVehicles);
                }
                ui.separator();
            }

            // Quick status line
            ui.label(format!(
                "Day {} | $ {} ( +{} / -{} ) | Pop {} | Emp {}/{} ({:.0}%) | Commute {:.0}s | Traffic {:.0}%/{:.0}% | Citizens {} | Vehicles {} | Buildings {} | Build {:?}",
                p.city.day,
                p.city.money,
                p.city.last_income,
                p.city.last_expense,
                p.city.population,
                p.metrics.employed,
                p.metrics.unemployed,
                (p.metrics.employment_rate * 100.0).clamp(0.0, 999.0),
                p.metrics.avg_commute_secs.clamp(0.0, 9999.0),
                (p.metrics.traffic_avg * 100.0).clamp(0.0, 999.0),
                (p.metrics.traffic_max * 100.0).clamp(0.0, 999.0),
                p.metrics.citizens,
                p.metrics.vehicles,
                p.metrics.buildings,
                p.mode.selected
            ));

            // State control hints
            match p.state.get() {
                AppState::MainMenu => {
                    if ui.button("Start").clicked() {
                        p.next_state.set(AppState::InGame);
                    }
                }
                AppState::InGame => {
                    if ui.button("Pause").clicked() {
                        p.next_state.set(AppState::Paused);
                    }
                }
                AppState::Paused => {
                    if ui.button("Resume").clicked() {
                        p.next_state.set(AppState::InGame);
                    }
                }
            }
        });
    });
}

#[derive(SystemParam)]
struct TopBarParams<'w> {
    ui_state: ResMut<'w, UiState>,
    state: Res<'w, State<AppState>>,
    next_state: ResMut<'w, NextState<AppState>>,
    city: Res<'w, City>,
    mode: Res<'w, BuildMode>,
    metrics: Res<'w, UiMetrics>,
    commands: MessageWriter<'w, GameCommand>,
}
