use bevy::ecs::message::MessageWriter;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Real;
use bevy::window::PrimaryWindow;
use bevy_egui::{EguiContexts, EguiPlugin, EguiPrimaryContextPass, egui};
use std::collections::VecDeque;

use crate::game::buildings::Building;
use crate::game::camera::MainCamera;
use crate::game::citizens::Citizen;
use crate::game::citizens::CommuteStats;
use crate::game::commands::GameCommand;
use crate::game::day_night::time_of_day_from_hour;
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
use crate::game::services::ServiceVehicle;
use crate::game::services::{ServiceCoverageIndex, ServiceStation};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::telemetry::{VehicleAgg, VehicleAggSnapshot};
use crate::game::traffic::{Parked, TrafficIndex, TrafficOccupancy, Vehicle, VehicleTrafficState};
use crate::game::traffic::{ParkedVehicleTileIndex, TrafficSpatialIndex};
use crate::game::ui_settings::UiSettings;
use crate::game::ui_state::{OverlayMode, SimSpeed, ToolMode, UiState};

mod metrics;
pub use metrics::{
    DebugDumpCopyInfo, DebugDumpUiState, DebugTelemetry, DebugTelemetrySample, HistorySample,
    UiEntityCounts, UiHistory, UiMetrics, track_ui_entity_counts, update_ui_metrics,
};

mod announcements;
use announcements::{announce_ingame, announce_main_menu, announce_paused};

mod window_title;
use window_title::update_window_title;

mod common;
use common::{overlay_sources, zone_label};

mod top_bar;
use top_bar::top_status_bar_ui;

mod toolbar;
use toolbar::bottom_toolbar_ui;

mod shortcuts;
use shortcuts::{ShowShortcuts, shortcuts_ui, toggle_shortcuts};

mod right_sidebar;
use right_sidebar::right_sidebar_ui;

mod building_popup;
use building_popup::building_popup_ui;

mod stats_window;
use stats_window::{ShowStatsWindow, stats_ui};

pub mod debug_dump;
use debug_dump::debug_dump_ui;

pub struct UiPlugin;

impl Plugin for UiPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(EguiPlugin::default())
            .init_resource::<UiMetrics>()
            .init_resource::<UiHistory>()
            .add_systems(OnEnter(AppState::MainMenu), announce_main_menu)
            .add_systems(OnEnter(AppState::InGame), announce_ingame)
            .add_systems(OnEnter(AppState::InGame), reset_debug_telemetry)
            .add_systems(OnEnter(AppState::Paused), announce_paused)
            .init_resource::<ShowShortcuts>()
            .init_resource::<ShowStatsWindow>()
            .init_resource::<DebugDumpUiState>()
            .init_resource::<DebugTelemetry>()
            .init_resource::<UiEntityCounts>()
            .add_systems(EguiPrimaryContextPass, top_status_bar_ui)
            .add_systems(
                EguiPrimaryContextPass,
                debug_dump_ui.after(top_status_bar_ui),
            )
            .add_systems(
                EguiPrimaryContextPass,
                bottom_toolbar_ui.after(top_status_bar_ui),
            )
            .add_systems(
                EguiPrimaryContextPass,
                right_sidebar_ui.after(top_status_bar_ui),
            )
            .add_systems(EguiPrimaryContextPass, shortcuts_ui.after(right_sidebar_ui))
            .add_systems(Update, toggle_shortcuts.in_set(GameSet::Input))
            .add_systems(EguiPrimaryContextPass, stats_ui.after(shortcuts_ui))
            .add_systems(EguiPrimaryContextPass, building_popup_ui.after(stats_ui))
            .add_systems(
                Update,
                track_ui_entity_counts
                    .before(update_ui_metrics)
                    .in_set(GameSet::Ui),
            )
            .add_systems(Update, update_ui_metrics.in_set(GameSet::Ui))
            .add_systems(
                Update,
                collect_debug_telemetry
                    .after(update_ui_metrics)
                    .in_set(GameSet::Ui),
            )
            .add_systems(
                Update,
                update_ui_history
                    .after(update_ui_metrics)
                    .in_set(GameSet::Ui),
            )
            .add_systems(Update, update_window_title.in_set(GameSet::Ui));
    }
}

// (moved to `ui/metrics.rs`)

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

fn reset_debug_telemetry(mut telemetry: ResMut<DebugTelemetry>, mut ui: ResMut<DebugDumpUiState>) {
    telemetry.samples.clear();
    telemetry.t_real_s = 0.0;
    telemetry.last_sample_t_s = 0.0;
    ui.copy_requested = false;
    ui.save_requested = false;
    ui.clear_requested = false;
    ui.last_copy = None;
}

#[allow(clippy::too_many_arguments)]
fn collect_debug_telemetry(
    time: Res<Time<Real>>,
    state: Res<State<AppState>>,
    ui_state: Res<UiState>,
    city: Res<City>,
    metrics: Res<UiMetrics>,
    cfg: Res<DebugDumpUiState>,
    mut telemetry: ResMut<DebugTelemetry>,
    vehicle_agg: Option<Res<VehicleAggSnapshot>>,
) {
    if !cfg.enabled {
        return;
    }

    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        telemetry.samples.clear();
        telemetry.t_real_s = 0.0;
        telemetry.last_sample_t_s = 0.0;
        return;
    }

    telemetry.t_real_s += time.delta_secs();

    let interval = cfg.interval_secs.clamp(0.1, 10.0);
    let window = cfg.window_secs.clamp(10.0, 10_000.0);
    let max_samples = ((window / interval).ceil() as usize).max(1) + 2;

    let should_sample = telemetry.samples.is_empty()
        || (telemetry.t_real_s - telemetry.last_sample_t_s) >= interval;
    if !should_sample {
        return;
    }
    telemetry.last_sample_t_s = telemetry.t_real_s;

    let app_state = match state.get() {
        AppState::MainMenu => "MainMenu",
        AppState::InGame => "InGame",
        AppState::Paused => "Paused",
    }
    .to_string();
    let sim_speed = match ui_state.sim_speed {
        SimSpeed::Paused => "Paused",
        SimSpeed::X1 => "X1",
        SimSpeed::X2 => "X2",
        SimSpeed::X3 => "X3",
    }
    .to_string();

    let time_of_day = Some(time_of_day_from_hour(city.hour));

    // Vehicle stats: use snapshot built by traffic systems (no full-world scan here).
    let vehicles = vehicle_agg
        .as_deref()
        .map(|s| s.combined())
        .unwrap_or_default();

    let t_real_s = telemetry.t_real_s;
    telemetry.samples.push_back(DebugTelemetrySample {
        t_real_s,
        app_state,
        sim_speed,
        day: city.day,
        time_of_day,
        money: city.money,
        population: city.population,
        traffic_avg: metrics.traffic_avg,
        traffic_max: metrics.traffic_max,
        demand_r: metrics.demand_r,
        demand_c: metrics.demand_c,
        demand_i: metrics.demand_i,
        active_emergencies: metrics.active_emergencies,
        vehicles,
    });

    while telemetry.samples.len() > max_samples {
        telemetry.samples.pop_front();
    }
}

// (moved to `ui/right_sidebar.rs`)

// (moved to `ui/building_popup.rs`)

// (moved to `ui/debug_dump.rs`)

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
