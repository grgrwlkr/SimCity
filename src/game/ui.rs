use bevy::ecs::message::MessageWriter;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy_egui::{EguiContexts, EguiPlugin, EguiPrimaryContextPass, egui};

use crate::game::buildings::Building;
use crate::game::camera::MainCamera;
use crate::game::citizens::Citizen;
use crate::game::citizens::CommuteStats;
use crate::game::commands::GameCommand;
use crate::game::day_night::DayNightCycle;
use crate::game::demand::RciDemand;
use crate::game::economy::EconomyConfig;
use crate::game::emergencies::Emergency;
use crate::game::emergencies::EmergencyManager;
use crate::game::employment::EmploymentStats;
use crate::game::map::{
    BuildMode, BuildingKind, HoveredTile, MapConfig, MapGrid, TilePos, ZoneKind,
};
use crate::game::roads::RoadKind;
use crate::game::scenarios::{ScenarioCatalog, ScenarioProgress, ScenarioSelection};
use crate::game::services::{ServiceCoverageIndex, ServiceStation};
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
            .init_resource::<UiHistory>()
            .add_systems(OnEnter(AppState::MainMenu), announce_main_menu)
            .add_systems(OnEnter(AppState::InGame), announce_ingame)
            .add_systems(OnEnter(AppState::Paused), announce_paused)
            .init_resource::<ShowShortcuts>()
            .add_systems(EguiPrimaryContextPass, top_status_bar_ui)
            .add_systems(
                EguiPrimaryContextPass,
                bottom_toolbar_ui.after(top_status_bar_ui),
            )
            .add_systems(
                EguiPrimaryContextPass,
                right_sidebar_ui.after(top_status_bar_ui),
            )
            .add_systems(EguiPrimaryContextPass, shortcuts_ui.after(right_sidebar_ui))
            .add_systems(EguiPrimaryContextPass, inspector_ui.after(right_sidebar_ui))
            .add_systems(Update, toggle_shortcuts.in_set(GameSet::Input))
            .add_systems(
                EguiPrimaryContextPass,
                building_popup_ui.after(inspector_ui),
            )
            .add_systems(EguiPrimaryContextPass, minimap_ui.after(inspector_ui))
            .add_systems(EguiPrimaryContextPass, stats_ui.after(minimap_ui))
            .add_systems(Update, update_ui_metrics.in_set(GameSet::Ui))
            .add_systems(
                Update,
                update_ui_history
                    .after(update_ui_metrics)
                    .in_set(GameSet::Ui),
            )
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

    demand_r: f32,
    demand_c: f32,
    demand_i: f32,

    fire_stations: u32,
    police_stations: u32,
    medical_stations: u32,
    fire_vehicles: (u32, u32),    // available / total
    police_vehicles: (u32, u32),  // available / total
    medical_vehicles: (u32, u32), // available / total

    service_cov_fire: f32,
    service_cov_police: f32,
    service_cov_medical: f32,

    active_emergencies: u32,
    emergencies_resolved: u32,
    emergencies_failed: u32,
}

#[derive(Resource, Debug, Clone)]
struct UiHistory {
    last_day: u32,
    max_len: usize,
    samples: Vec<HistorySample>,
}

#[derive(Debug, Copy, Clone)]
struct HistorySample {
    day: u32,
    population: u32,
    money: i64,
    traffic_avg: f32,
}

impl Default for UiHistory {
    fn default() -> Self {
        Self {
            last_day: 0,
            max_len: 240,
            samples: Vec::new(),
        }
    }
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

        p.metrics.demand_r = 0.0;
        p.metrics.demand_c = 0.0;
        p.metrics.demand_i = 0.0;

        p.metrics.fire_stations = 0;
        p.metrics.police_stations = 0;
        p.metrics.medical_stations = 0;
        p.metrics.fire_vehicles = (0, 0);
        p.metrics.police_vehicles = (0, 0);
        p.metrics.medical_vehicles = (0, 0);
        p.metrics.service_cov_fire = 0.0;
        p.metrics.service_cov_police = 0.0;
        p.metrics.service_cov_medical = 0.0;
        p.metrics.active_emergencies = 0;
        p.metrics.emergencies_resolved = 0;
        p.metrics.emergencies_failed = 0;
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

    if let Some(d) = p.demand.as_deref() {
        p.metrics.demand_r = d.residential;
        p.metrics.demand_c = d.commercial;
        p.metrics.demand_i = d.industrial;
    } else {
        p.metrics.demand_r = 0.0;
        p.metrics.demand_c = 0.0;
        p.metrics.demand_i = 0.0;
    }

    // Services stats.
    let mut fire_s = 0u32;
    let mut police_s = 0u32;
    let mut medical_s = 0u32;
    let mut fire_av = 0u32;
    let mut fire_total = 0u32;
    let mut police_av = 0u32;
    let mut police_total = 0u32;
    let mut medical_av = 0u32;
    let mut medical_total = 0u32;
    for s in p.q_stations.iter() {
        match s.kind {
            crate::game::services::ServiceKind::Fire => {
                fire_s += 1;
                fire_av += s.available_vehicles as u32;
                fire_total += s.total_vehicles as u32;
            }
            crate::game::services::ServiceKind::Police => {
                police_s += 1;
                police_av += s.available_vehicles as u32;
                police_total += s.total_vehicles as u32;
            }
            crate::game::services::ServiceKind::Medical => {
                medical_s += 1;
                medical_av += s.available_vehicles as u32;
                medical_total += s.total_vehicles as u32;
            }
        }
    }
    p.metrics.fire_stations = fire_s;
    p.metrics.police_stations = police_s;
    p.metrics.medical_stations = medical_s;
    p.metrics.fire_vehicles = (fire_av, fire_total);
    p.metrics.police_vehicles = (police_av, police_total);
    p.metrics.medical_vehicles = (medical_av, medical_total);

    if let Some(c) = p.service_coverage.as_deref() {
        p.metrics.service_cov_fire = c.fire;
        p.metrics.service_cov_police = c.police;
        p.metrics.service_cov_medical = c.medical;
    } else {
        p.metrics.service_cov_fire = 0.0;
        p.metrics.service_cov_police = 0.0;
        p.metrics.service_cov_medical = 0.0;
    }

    p.metrics.active_emergencies = p.q_emergencies.iter().count() as u32;
    if let Some(m) = p.emergency_manager.as_deref() {
        p.metrics.emergencies_resolved = m.stats.resolved_in_time;
        p.metrics.emergencies_failed = m.stats.failed_responses;
    } else {
        p.metrics.emergencies_resolved = 0;
        p.metrics.emergencies_failed = 0;
    }
}

#[derive(SystemParam)]
struct UiMetricsParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    metrics: ResMut<'w, UiMetrics>,
    employment: Option<Res<'w, EmploymentStats>>,
    traffic: Option<Res<'w, TrafficIndex>>,
    commute: Option<Res<'w, CommuteStats>>,
    demand: Option<Res<'w, RciDemand>>,
    service_coverage: Option<Res<'w, ServiceCoverageIndex>>,
    emergency_manager: Option<Res<'w, EmergencyManager>>,
    q_citizens: Query<'w, 's, Entity, With<Citizen>>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    q_buildings: Query<'w, 's, Entity, With<Building>>,
    q_stations: Query<'w, 's, &'static ServiceStation>,
    q_emergencies: Query<'w, 's, Entity, With<Emergency>>,
}

fn update_ui_history(
    state: Res<State<AppState>>,
    city: Res<City>,
    traffic: Option<Res<TrafficIndex>>,
    mut hist: ResMut<UiHistory>,
) {
    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        hist.samples.clear();
        hist.last_day = 0;
        return;
    }

    if hist.last_day == city.day {
        return;
    }
    hist.last_day = city.day;

    let traffic_avg = traffic.as_deref().map(|t| t.avg_congestion).unwrap_or(0.0);
    hist.samples.push(HistorySample {
        day: city.day,
        population: city.population,
        money: city.money,
        traffic_avg,
    });
    if hist.samples.len() > hist.max_len {
        let excess = hist.samples.len() - hist.max_len;
        hist.samples.drain(0..excess);
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
    info!("  1 Road (cycle 2/4/6 lanes), 2 Residential, 3 Commercial, 4 Industrial, 5 Erase");
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

/// Compact top status bar with key metrics
fn top_status_bar_ui(mut contexts: EguiContexts, mut p: TopBarParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    egui::TopBottomPanel::top("status_bar")
        .exact_height(32.0)
        .show(&*ctx, |ui| {
            ui.horizontal_centered(|ui| {
                // Money (color-coded: green/red)
                let money_color = if p.city.money < 0 {
                    egui::Color32::LIGHT_RED
                } else {
                    egui::Color32::LIGHT_GREEN
                };
                ui.colored_label(money_color, format!("💰 ${}", p.city.money));
                ui.separator();

                // Population
                ui.label(format!("👥 {}", p.city.population));
                ui.separator();

                // Day
                ui.label(format!("📅 Day {}", p.city.day));
                ui.separator();

                // Time of day with icon
                if matches!(p.state.get(), AppState::InGame | AppState::Paused)
                    && let Some(cycle) = p.day_night.as_deref()
                {
                    let t = cycle.time_of_day.rem_euclid(1.0);
                    let hours_f = ((t * 24.0) + 12.0) % 24.0;
                    let mut hh = hours_f.floor() as u32;
                    let mut mm = ((hours_f - (hh as f32)) * 60.0).round() as u32;
                    if mm >= 60 {
                        mm = 0;
                        hh = (hh + 1) % 24;
                    }

                    let (time_icon, phase) = if t < 0.25 {
                        ("🌤", "Day")
                    } else if t < 0.5 {
                        ("🌆", "Dusk")
                    } else if t < 0.75 {
                        ("🌙", "Night")
                    } else {
                        ("🌅", "Dawn")
                    };

                    ui.label(format!("{} {:02}:{:02} ({})", time_icon, hh, mm, phase));
                    ui.separator();
                }

                // Sim speed (compact buttons)
                ui.horizontal(|ui| {
                    let resp =
                        ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::Paused, "⏸");
                    resp.on_hover_text("Pause simulation");
                    let resp = ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X1, "▶");
                    resp.on_hover_text("Normal speed (1x)");
                    let resp = ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X2, "▶▶");
                    resp.on_hover_text("Fast speed (2x)");
                    let resp = ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X4, "▶▶▶");
                    resp.on_hover_text("Very fast speed (4x)");
                });
                ui.separator();

                // Settings and save (right side)
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                        if ui.button("💾").clicked() {
                            p.commands.write(GameCommand::SaveGame { slot: 1 });
                        }
                    }
                });
            });
        });
}

/// Bottom toolbar with categorized tools
fn bottom_toolbar_ui(mut contexts: EguiContexts, mut p: TopBarParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    egui::TopBottomPanel::bottom("toolbar")
        .exact_height(48.0)
        .show(&*ctx, |ui| {
            ui.horizontal_centered(|ui| {
                // Roads category
                ui.menu_button("🛣 Roads", |ui| {
                    for (label, kind) in [
                        ("2-lane ($10)", RoadKind::TwoLane),
                        ("4-lane ($30)", RoadKind::FourLane),
                        ("6-lane ($60)", RoadKind::SixLane),
                    ] {
                        let resp = ui
                            .button(label)
                            .on_hover_text(tool_tooltip(ToolMode::Road(kind)));
                        if resp.clicked() {
                            p.ui_state.tool = ToolMode::Road(kind);
                            ui.close();
                        }
                    }
                });

                // Zones category
                ui.menu_button("🏠 Zones", |ui| {
                    let resp = ui
                        .button("Residential")
                        .on_hover_text(tool_tooltip(ToolMode::Residential));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::Residential;
                        ui.close();
                    }
                    let resp = ui
                        .button("Commercial")
                        .on_hover_text(tool_tooltip(ToolMode::Commercial));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::Commercial;
                        ui.close();
                    }
                    let resp = ui
                        .button("Industrial")
                        .on_hover_text(tool_tooltip(ToolMode::Industrial));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::Industrial;
                        ui.close();
                    }
                });

                // Buildings category
                ui.menu_button("🏢 Buildings", |ui| {
                    let resp = ui
                        .button("🚒 Fire Station ($500)")
                        .on_hover_text(tool_tooltip(ToolMode::FireStation));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::FireStation;
                        ui.close();
                    }
                    let resp = ui
                        .button("🚔 Police Station ($400)")
                        .on_hover_text(tool_tooltip(ToolMode::PoliceStation));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::PoliceStation;
                        ui.close();
                    }
                    let resp = ui
                        .button("🏥 Hospital ($800)")
                        .on_hover_text(tool_tooltip(ToolMode::Hospital));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::Hospital;
                        ui.close();
                    }
                });

                // Overlays category
                ui.menu_button("🗺 Overlays", |ui| {
                    for (label, mode) in [
                        ("None", OverlayMode::None),
                        ("Water", OverlayMode::Water),
                        ("Height", OverlayMode::Height),
                        ("Zones", OverlayMode::Zones),
                        ("Roads", OverlayMode::Roads),
                        ("Traffic", OverlayMode::Traffic),
                        ("Path", OverlayMode::Path),
                        ("Service", OverlayMode::ServiceCoverage),
                        ("Land Value", OverlayMode::LandValue),
                        ("Pollution", OverlayMode::Pollution),
                    ] {
                        let resp = ui
                            .selectable_label(p.ui_state.overlay == mode, label)
                            .on_hover_text(overlay_tooltip(mode));
                        if resp.clicked() {
                            p.ui_state.overlay = mode;
                        }
                    }
                });

                ui.separator();

                // Special tools
                let is_erase = matches!(p.ui_state.tool, ToolMode::Erase);
                let resp = ui
                    .selectable_label(is_erase, "🗑 Erase")
                    .on_hover_text(tool_tooltip(ToolMode::Erase));
                if resp.clicked() {
                    p.ui_state.tool = ToolMode::Erase;
                }

                let is_inspect = matches!(p.ui_state.tool, ToolMode::Inspect);
                let resp = ui
                    .selectable_label(is_inspect, "🔍 Inspect")
                    .on_hover_text(tool_tooltip(ToolMode::Inspect));
                if resp.clicked() {
                    p.ui_state.tool = ToolMode::Inspect;
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

                if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                    ui.separator();
                    if ui.button("Spawn cars").clicked() {
                        p.commands
                            .write(GameCommand::SpawnDebugVehicles { count: 25 });
                    }
                    if ui.button("Clear cars").clicked() {
                        p.commands.write(GameCommand::ClearVehicles);
                    }
                    if ui.button("Load").clicked() {
                        p.commands.write(GameCommand::LoadGame { slot: 1 });
                    }
                }

                // State control
                match p.state.get() {
                    AppState::MainMenu => {
                        if !p.scenario_catalog.scenarios.is_empty() {
                            let idx = p
                                .scenario_selection
                                .selected
                                .min(p.scenario_catalog.scenarios.len() - 1);
                            egui::ComboBox::from_label("Scenario")
                                .selected_text(p.scenario_catalog.scenarios[idx].name.clone())
                                .show_ui(ui, |ui| {
                                    for (i, s) in p.scenario_catalog.scenarios.iter().enumerate() {
                                        ui.selectable_value(
                                            &mut p.scenario_selection.selected,
                                            i,
                                            &s.name,
                                        );
                                    }
                                });
                        }
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

                // Current tool indicator (right side)
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let tool_text = match p.ui_state.tool {
                        ToolMode::Road(k) => format!("Road {:?}", k),
                        ToolMode::Residential => "Residential".to_string(),
                        ToolMode::Commercial => "Commercial".to_string(),
                        ToolMode::Industrial => "Industrial".to_string(),
                        ToolMode::FireStation => "Fire Station".to_string(),
                        ToolMode::PoliceStation => "Police Station".to_string(),
                        ToolMode::Hospital => "Hospital".to_string(),
                        ToolMode::Erase => "Erase".to_string(),
                        ToolMode::Inspect => "Inspect".to_string(),
                    };
                    ui.label(format!("Selected: {}", tool_text));
                });
            });
        });
}

/// Right sidebar with minimap, info panel, and statistics
fn right_sidebar_ui(mut contexts: EguiContexts, p: RightSidebarParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    if !matches!(p.state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    egui::SidePanel::right("sidebar")
        .exact_width(200.0)
        .show(&*ctx, |ui| {
            // Minimap (collapsible)
            egui::CollapsingHeader::new("📍 Minimap")
                .default_open(true)
                .show(ui, |ui| {
                    let Ok(window) = p.q_window.single() else {
                        return;
                    };
                    let Ok((cam_tf, proj)) = p.q_camera.single() else {
                        return;
                    };
                    render_minimap_in_sidebar(ui, &p.grid, &p.cfg, window, cam_tf, proj);
                });

            ui.separator();

            // Info panel (depends on hovered/selected)
            egui::CollapsingHeader::new("📊 Info")
                .default_open(true)
                .show(ui, |ui| {
                    if let Some(tile) = p.hovered.tile {
                        render_tile_info(ui, tile, &p.grid);
                    } else {
                        ui.label("Hover over a tile");
                    }
                });

            ui.separator();

            // City statistics (collapsible)
            egui::CollapsingHeader::new("📈 Statistics")
                .default_open(false)
                .show(ui, |ui| {
                    render_city_stats(ui, &p.metrics, &p.city);
                });

            ui.separator();

            // Services status
            egui::CollapsingHeader::new("🚒 Services")
                .default_open(false)
                .show(ui, |ui| {
                    render_services_status(ui, &p.metrics);
                });

            ui.separator();

            // Demand
            ui.label("Demand (R/C/I):");
            ui.label(format!(
                "  {:+.2} / {:+.2} / {:+.2}",
                p.metrics.demand_r, p.metrics.demand_c, p.metrics.demand_i
            ));
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
    day_night: Option<Res<'w, DayNightCycle>>,
    scenario_catalog: Res<'w, ScenarioCatalog>,
    scenario_selection: ResMut<'w, ScenarioSelection>,
    scenario_progress: Res<'w, ScenarioProgress>,
    commands: MessageWriter<'w, GameCommand>,
}

#[derive(SystemParam)]
struct RightSidebarParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    hovered: Res<'w, HoveredTile>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    city: Res<'w, City>,
    metrics: Res<'w, UiMetrics>,
    q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    q_camera: Query<'w, 's, (&'static Transform, &'static Projection), With<MainCamera>>,
}

fn zone_label(z: ZoneKind) -> &'static str {
    match z {
        ZoneKind::None => "None",
        ZoneKind::Residential => "Residential",
        ZoneKind::Commercial => "Commercial",
        ZoneKind::Industrial => "Industrial",
    }
}

/// Get tooltip text for a tool mode
fn tool_tooltip(tool: ToolMode) -> &'static str {
    match tool {
        ToolMode::Road(RoadKind::None) => "No road selected",
        ToolMode::Road(RoadKind::TwoLane) => "2-lane road ($10/tile)\nLocal street, 40 km/h",
        ToolMode::Road(RoadKind::FourLane) => "4-lane road ($30/tile)\nCity road, 60 km/h",
        ToolMode::Road(RoadKind::SixLane) => "6-lane road ($60/tile)\nHighway, 80 km/h",
        ToolMode::Residential => "Residential zone (free)\nHouses for citizens",
        ToolMode::Commercial => "Commercial zone (free)\nShops and offices",
        ToolMode::Industrial => "Industrial zone (free)\nFactories and warehouses",
        ToolMode::FireStation => "Fire station ($500)\nRadius: 20 tiles, 3 vehicles",
        ToolMode::PoliceStation => "Police station ($400)\nRadius: 25 tiles, 4 vehicles",
        ToolMode::Hospital => "Hospital ($800)\nRadius: 30 tiles, 2 vehicles",
        ToolMode::Erase => "Erase tool\nRemove roads, zones, buildings",
        ToolMode::Inspect => "Inspect tool\nView tile information",
    }
}

/// Get tooltip text for an overlay mode
fn overlay_tooltip(overlay: OverlayMode) -> &'static str {
    match overlay {
        OverlayMode::None => "Base map view\nTerrain, roads, zones, water",
        OverlayMode::Water => "Water overlay\nShows water tiles",
        OverlayMode::Height => "Height overlay\nShows terrain elevation",
        OverlayMode::Zones => "Zones overlay\nShows R/C/I zoning",
        OverlayMode::Roads => "Roads overlay\nShows road network",
        OverlayMode::Traffic => "Traffic overlay\nShows congestion heatmap",
        OverlayMode::Path => "Path overlay\nShows route preview",
        OverlayMode::ServiceCoverage => "Service coverage overlay\nShows service station coverage",
        OverlayMode::LandValue => "Land value overlay\nShows land value (red=low, green=high)",
        OverlayMode::Pollution => "Pollution overlay\nShows pollution (green=clean, red=polluted)",
    }
}

fn overlay_sources(o: OverlayMode) -> &'static str {
    match o {
        OverlayMode::None => "Base map: MapGrid (terrain/road/zone/water)",
        OverlayMode::Water => "MapGrid.water",
        OverlayMode::Height => "MapGrid.height",
        OverlayMode::Zones => "MapGrid.zone (+ road)",
        OverlayMode::Roads => "MapGrid.road",
        OverlayMode::Traffic => "TrafficOccupancy.ema_heat + TrafficIndex",
        OverlayMode::Path => "Computed live: MapGrid roads + cursor start/end",
        OverlayMode::ServiceCoverage => "ServiceStation coverage (radius) + uncovered zones",
        OverlayMode::LandValue => "LandValueIndex.values (0.0-1.0)",
        OverlayMode::Pollution => "PollutionIndex.pollution (0.0-1.0)",
    }
}

fn inspector_ui(mut contexts: EguiContexts, p: InspectorParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    if !matches!(p.state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    let Some(tile) = p.hovered.tile else {
        return;
    };

    egui::Window::new("Inspector")
        .default_pos(egui::pos2(10.0, 64.0))
        .resizable(true)
        .show(&*ctx, |ui| {
            ui.label(format!("Tile: ({}, {})", tile.x, tile.y));
            ui.label(format!(
                "Overlay source: {}",
                overlay_sources(p.ui_state.overlay)
            ));
            ui.separator();

            let Some(cell) = p.grid.get(tile) else {
                ui.label("Out of bounds");
                return;
            };

            ui.label(format!("Height: {}", cell.height));
            ui.label(format!("Water: {}", cell.water));
            ui.label(format!("Terrain: {:?}", cell.terrain));
            ui.label(format!("Road: {:?}", cell.road));
            ui.label(format!("Zone: {}", zone_label(cell.zone)));
            ui.label(format!("Building (grid): {:?}", cell.building));

            // Building entity (render)
            let mut b_found = None;
            for b in p.q_buildings.iter() {
                if b.pos == tile {
                    b_found = Some(*b);
                    break;
                }
            }
            if let Some(b) = b_found {
                ui.separator();
                ui.label("Building entity:");
                ui.label(format!("Kind: {:?}", b.kind));
                ui.label(format!(
                    "Capacity: residents {} / jobs {}",
                    b.capacity_residents, b.capacity_jobs
                ));
            }

            // Emergency at tile (if any).
            let mut emergency_found: Option<&Emergency> = None;
            for e in p.q_emergencies.iter() {
                if e.pos == tile {
                    emergency_found = Some(e);
                    break;
                }
            }
            if let Some(e) = emergency_found {
                ui.separator();
                ui.label("Emergency:");
                ui.label(format!("Kind: {:?}", e.kind));
                ui.label(format!("Severity: {:.2}", e.severity));
                ui.label(format!("Responded: {}", e.responded));
                ui.label(format!("Time remaining: {:.1}s", e.time_remaining.max(0.0)));
                ui.label(format!(
                    "Resolution: {:.0}%",
                    (e.resolution_progress.clamp(0.0, 1.0) * 100.0)
                ));
                ui.label(format!("Assigned vehicle: {:?}", e.assigned_vehicle));
            }

            // Vehicles on tile (by current route head).
            let mut vehicles = 0usize;
            let mut sample: Option<(usize, f32)> = None; // (route_len, progress)
            for v in p.q_vehicles.iter() {
                if v.route.first() == Some(&tile) {
                    vehicles += 1;
                    if sample.is_none() {
                        sample = Some((v.route.len(), v.progress));
                    }
                }
            }

            ui.separator();
            ui.label(format!("Vehicles on tile: {}", vehicles));
            if let Some((len, prog)) = sample {
                ui.label(format!(
                    "Sample vehicle: route_len {} progress {:.2}",
                    len, prog
                ));
            }

            // Citizens linked to tile (home or last_place).
            let mut home_c = 0usize;
            let mut place_c = 0usize;
            for c in p.q_citizens.iter() {
                if c.home == tile {
                    home_c += 1;
                }
                if c.last_place == tile {
                    place_c += 1;
                }
            }
            ui.separator();
            ui.label(format!("Citizens home here: {}", home_c));
            ui.label(format!("Citizens last_place here: {}", place_c));
        });
}

#[derive(SystemParam)]
struct InspectorParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    ui_state: Res<'w, UiState>,
    hovered: Res<'w, HoveredTile>,
    grid: Res<'w, MapGrid>,
    q_emergencies: Query<'w, 's, &'static Emergency>,
    q_buildings: Query<'w, 's, &'static Building>,
    q_vehicles: Query<'w, 's, &'static Vehicle>,
    q_citizens: Query<'w, 's, &'static Citizen>,
}

fn building_popup_ui(
    mut contexts: EguiContexts,
    state: Res<State<AppState>>,
    hovered: Res<HoveredTile>,
    grid: Res<MapGrid>,
    econ: Res<EconomyConfig>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };
    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    let Some(tile) = hovered.tile else {
        return;
    };
    let Some(cell) = grid.get(tile) else {
        return;
    };
    let Some(kind) = cell.building else {
        return;
    };

    let pointer = ctx.input(|i| i.pointer.hover_pos());
    let Some(pointer) = pointer else {
        return;
    };

    let road_access = has_adjacent_road(&grid, tile);
    let tax = if kind == BuildingKind::Residential {
        (kind.capacity_residents() as i64) * econ.tax_per_citizen
    } else {
        0
    };

    egui::Area::new("building_popup".into())
        .fixed_pos(pointer + egui::vec2(12.0, 12.0))
        .show(&*ctx, |ui| {
            egui::Frame::popup(ui.style()).show(ui, |ui| {
                ui.label("Building");
                ui.separator();
                ui.label(format!("Kind: {:?}", kind));
                ui.label(format!(
                    "Capacity: residents {} / jobs {}",
                    kind.capacity_residents(),
                    kind.capacity_jobs()
                ));
                ui.label(format!("Road access: {}", road_access));
                if kind == BuildingKind::Residential {
                    ui.label(format!("Tax contribution: ${}/day", tax));
                }
            });
        });
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    for npos in [
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ] {
        if let Some(cell) = grid.get(npos)
            && !cell.water
            && cell.road.is_some()
        {
            return true;
        }
    }
    false
}

fn stats_ui(mut contexts: EguiContexts, state: Res<State<AppState>>, hist: Res<UiHistory>) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };
    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    egui::Window::new("Statistics")
        .default_pos(egui::pos2(10.0, 420.0))
        .resizable(true)
        .show(&*ctx, |ui| {
            if hist.samples.is_empty() {
                ui.label("No history yet (advance a day).");
                return;
            }

            let pop: Vec<f32> = hist.samples.iter().map(|s| s.population as f32).collect();
            let money: Vec<f32> = hist.samples.iter().map(|s| s.money as f32).collect();
            let traffic: Vec<f32> = hist
                .samples
                .iter()
                .map(|s| (s.traffic_avg * 100.0).clamp(0.0, 200.0))
                .collect();

            ui.label(format!(
                "Samples: {} (days {}..{})",
                hist.samples.len(),
                hist.samples.first().map(|s| s.day).unwrap_or(0),
                hist.samples.last().map(|s| s.day).unwrap_or(0)
            ));

            ui.separator();

            draw_history_plot(ui, "Population", &pop, egui::Color32::LIGHT_GREEN);
            draw_history_plot(ui, "Money", &money, egui::Color32::LIGHT_YELLOW);
            draw_history_plot(ui, "Traffic avg (%)", &traffic, egui::Color32::LIGHT_RED);
        });
}

fn draw_history_plot(ui: &mut egui::Ui, label: &str, values: &[f32], color: egui::Color32) {
    ui.label(label);

    let size = egui::vec2(260.0, 70.0);
    let (rect, _resp) = ui.allocate_exact_size(size, egui::Sense::hover());
    let painter = ui.painter_at(rect);

    painter.rect_filled(
        rect,
        2.0,
        egui::Color32::from_rgba_unmultiplied(0, 0, 0, 40),
    );

    if values.len() < 2 {
        return;
    }

    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    for &v in values {
        min_v = min_v.min(v);
        max_v = max_v.max(v);
    }
    let range = (max_v - min_v).max(1e-3);
    let len = values.len() as f32;

    let mut points = Vec::with_capacity(values.len());
    for (i, &v) in values.iter().enumerate() {
        let x = rect.min.x + (i as f32 / (len - 1.0)) * rect.width();
        let y = rect.max.y - ((v - min_v) / range) * rect.height();
        points.push(egui::pos2(x, y));
    }

    painter.add(egui::Shape::line(points, egui::Stroke::new(1.5, color)));

    // Last value label.
    if let Some(&last) = values.last() {
        ui.label(format!("{:.0}", last));
    }
}

fn minimap_ui(mut contexts: EguiContexts, p: MinimapParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };
    if !matches!(p.state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    let Ok(window) = p.q_window.single() else {
        return;
    };
    let Ok((cam_tf, proj)) = p.q_camera.single() else {
        return;
    };

    egui::Window::new("Mini-map")
        .default_pos(egui::pos2(window.width() - 220.0, 64.0))
        .resizable(false)
        .collapsible(true)
        .show(&*ctx, |ui| {
            render_minimap_in_sidebar(ui, &p.grid, &p.cfg, window, cam_tf, proj);
        });
}

fn render_minimap_in_sidebar(
    ui: &mut egui::Ui,
    grid: &MapGrid,
    cfg: &MapConfig,
    window: &Window,
    cam_tf: &Transform,
    proj: &Projection,
) {
    let map_w = grid.width.max(1) as f32;
    let map_h = grid.height.max(1) as f32;
    let size = 180.0;
    let (rect, _resp) = ui.allocate_exact_size(egui::vec2(size, size), egui::Sense::hover());

    let painter = ui.painter_at(rect);

    // Downsample for performance.
    let samples_x = (grid.width as usize).clamp(1, 64);
    let samples_y = (grid.height as usize).clamp(1, 64);
    let step_x = (grid.width as f32 / samples_x as f32).max(1.0);
    let step_y = (grid.height as f32 / samples_y as f32).max(1.0);
    let px_w = size / samples_x as f32;
    let px_h = size / samples_y as f32;

    for sy in 0..samples_y {
        for sx in 0..samples_x {
            let x = (sx as f32 * step_x).floor() as i32;
            let y = (sy as f32 * step_y).floor() as i32;
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };

            let color = if cell.water {
                Color::srgb(0.10, 0.30, 0.80)
            } else if let Some(b) = cell.building {
                b.color()
            } else if cell.road.is_some() {
                cell.road.kind.color()
            } else if let Some(k) = cell.zone.as_tile_kind() {
                k.color()
            } else {
                cell.terrain.color()
            };

            let min = egui::pos2(rect.min.x + sx as f32 * px_w, rect.min.y + sy as f32 * px_h);
            let max = egui::pos2(min.x + px_w + 0.5, min.y + px_h + 0.5);
            painter.rect_filled(
                egui::Rect::from_min_max(min, max),
                0.0,
                to_egui_color(color),
            );
        }
    }

    // Camera viewport (2D ortho).
    let (half_w, half_h) = match proj {
        Projection::Orthographic(o) => {
            let w = (o.area.max.x - o.area.min.x).abs().max(1.0);
            let h = (o.area.max.y - o.area.min.y).abs().max(1.0);
            (w * 0.5, h * 0.5)
        }
        _ => (window.width() * 0.5, window.height() * 0.5),
    };

    let origin = map_origin(cfg);
    let cam = cam_tf.translation.truncate();
    let min_world = cam - Vec2::new(half_w, half_h);
    let max_world = cam + Vec2::new(half_w, half_h);

    let world_to_tile_f = |w: Vec2| -> Vec2 {
        let local = w - origin;
        Vec2::new(local.x / cfg.tile_size, local.y / cfg.tile_size)
    };

    let t0 = world_to_tile_f(min_world);
    let t1 = world_to_tile_f(max_world);
    let min_tx = t0.x.clamp(0.0, map_w);
    let min_ty = t0.y.clamp(0.0, map_h);
    let max_tx = t1.x.clamp(0.0, map_w);
    let max_ty = t1.y.clamp(0.0, map_h);

    let to_px = |tx: f32, ty: f32| -> egui::Pos2 {
        egui::pos2(
            rect.min.x + (tx / map_w) * size,
            rect.min.y + (ty / map_h) * size,
        )
    };

    let rmin = to_px(min_tx, min_ty);
    let rmax = to_px(max_tx, max_ty);
    painter.rect_stroke(
        egui::Rect::from_min_max(rmin, rmax),
        0.0,
        egui::Stroke::new(1.5, egui::Color32::WHITE),
        egui::StrokeKind::Inside,
    );

    // Camera marker.
    let cam_tile = world_to_tile_f(cam);
    let cpos = to_px(cam_tile.x.clamp(0.0, map_w), cam_tile.y.clamp(0.0, map_h));
    painter.circle_filled(cpos, 2.5, egui::Color32::YELLOW);
}

fn render_tile_info(ui: &mut egui::Ui, tile: TilePos, grid: &MapGrid) {
    ui.label(format!("Tile: ({}, {})", tile.x, tile.y));

    let Some(cell) = grid.get(tile) else {
        ui.label("Out of bounds");
        return;
    };

    ui.separator();
    ui.label(format!("Height: {}", cell.height));
    ui.label(format!("Water: {}", cell.water));
    ui.label(format!("Terrain: {:?}", cell.terrain));
    ui.label(format!("Road: {:?}", cell.road));
    ui.label(format!("Zone: {}", zone_label(cell.zone)));
    ui.label(format!("Building: {:?}", cell.building));
}

fn render_city_stats(ui: &mut egui::Ui, metrics: &UiMetrics, city: &City) {
    ui.label(format!("Population: {}", city.population));
    ui.label(format!("Money: ${}", city.money));
    ui.label(format!("Income: +${}", city.last_income));
    ui.label(format!("Expense: -${}", city.last_expense));
    ui.separator();
    ui.label(format!("Employed: {}", metrics.employed));
    ui.label(format!("Unemployed: {}", metrics.unemployed));
    ui.label(format!(
        "Employment: {:.0}%",
        metrics.employment_rate * 100.0
    ));
    ui.label(format!("Avg Commute: {:.0}s", metrics.avg_commute_secs));
    ui.separator();
    ui.label(format!("Traffic Avg: {:.0}%", metrics.traffic_avg * 100.0));
    ui.label(format!("Traffic Max: {:.0}%", metrics.traffic_max * 100.0));
    ui.separator();
    ui.label(format!("Citizens: {}", metrics.citizens));
    ui.label(format!("Vehicles: {}", metrics.vehicles));
    ui.label(format!("Buildings: {}", metrics.buildings));
}

fn render_services_status(ui: &mut egui::Ui, metrics: &UiMetrics) {
    ui.label(format!(
        "🔴 Fire: {} stations, {}/{} vehicles",
        metrics.fire_stations, metrics.fire_vehicles.0, metrics.fire_vehicles.1
    ));
    ui.label(format!(
        "🔵 Police: {} stations, {}/{} vehicles",
        metrics.police_stations, metrics.police_vehicles.0, metrics.police_vehicles.1
    ));
    ui.label(format!(
        "🟢 Medical: {} stations, {}/{} vehicles",
        metrics.medical_stations, metrics.medical_vehicles.0, metrics.medical_vehicles.1
    ));
    ui.separator();
    ui.label(format!(
        "Coverage: F {:.0}% / P {:.0}% / M {:.0}%",
        metrics.service_cov_fire * 100.0,
        metrics.service_cov_police * 100.0,
        metrics.service_cov_medical * 100.0
    ));
    ui.separator();
    ui.label(format!(
        "Active emergencies: {}",
        metrics.active_emergencies
    ));
    ui.label(format!("Resolved: {}", metrics.emergencies_resolved));
    ui.label(format!("Failed: {}", metrics.emergencies_failed));
}

#[derive(SystemParam)]
struct MinimapParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    cfg: Res<'w, MapConfig>,
    grid: Res<'w, MapGrid>,
    q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    q_camera: Query<'w, 's, (&'static Transform, &'static Projection), With<MainCamera>>,
}

fn to_egui_color(c: Color) -> egui::Color32 {
    let s = c.to_srgba();
    let rgba = s.to_f32_array();
    egui::Color32::from_rgba_unmultiplied(
        (rgba[0] * 255.0) as u8,
        (rgba[1] * 255.0) as u8,
        (rgba[2] * 255.0) as u8,
        (rgba[3] * 255.0) as u8,
    )
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

/// Resource to control visibility of shortcuts panel
#[derive(Resource, Default)]
struct ShowShortcuts(bool);

/// Toggle shortcuts panel with ? key
fn toggle_shortcuts(keys: Res<ButtonInput<KeyCode>>, mut show: ResMut<ShowShortcuts>) {
    // Toggle with ? key (Shift+/ on US keyboard)
    if keys.just_pressed(KeyCode::Slash)
        && (keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight))
    {
        show.0 = !show.0;
    }
}

/// Keyboard shortcuts panel
fn shortcuts_ui(mut contexts: EguiContexts, show: Res<ShowShortcuts>) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    if !show.0 {
        return;
    }

    egui::Window::new("Keyboard Shortcuts")
        .collapsible(false)
        .resizable(true)
        .default_size(egui::vec2(400.0, 500.0))
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .show(&*ctx, |ui| {
            ui.heading("Navigation");
            ui.label("WASD / Arrow keys — Pan camera");
            ui.label("Mouse wheel — Zoom");

            ui.separator();
            ui.heading("Tools");
            ui.label("1 — Road tool (cycle 2/4/6 lanes)");
            ui.label("2 — Residential zone");
            ui.label("3 — Commercial zone");
            ui.label("4 — Industrial zone");
            ui.label("5 — Erase tool");

            ui.separator();
            ui.heading("Game");
            ui.label("Space — Pause/Resume");
            ui.label("Ctrl+S — Save game");
            ui.label("Ctrl+L — Load game");
            ui.label("Ctrl+Z — Undo");
            ui.label("Ctrl+Y — Redo");
            ui.label("Esc — Back to menu");

            ui.separator();
            ui.label("Press ? to toggle this panel");
        });
}
