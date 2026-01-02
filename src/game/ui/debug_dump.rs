use super::*;
use bevy_egui::{EguiContexts, egui};
use std::time::{SystemTime, UNIX_EPOCH};

mod build;

#[allow(clippy::too_many_arguments)]
pub(super) fn debug_dump_ui(
    mut contexts: EguiContexts,
    state: Res<State<AppState>>,
    ui_state: Res<UiState>,
    city: Res<City>,
    metrics: Res<UiMetrics>,
    hist: Res<UiHistory>,
    map_cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    hovered: Res<HoveredTile>,
    day_night: Option<Res<DayNightCycle>>,
    q_camera: Query<(&Transform, &Projection), With<MainCamera>>,
    mut dump_ui: ResMut<DebugDumpUiState>,
    mut telemetry: ResMut<DebugTelemetry>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    // Hotkeys: F9 copies dump; F8 toggles the debug window.
    if ctx.input(|i| i.key_pressed(egui::Key::F9)) {
        dump_ui.copy_requested = true;
    }
    if ctx.input(|i| i.key_pressed(egui::Key::F8)) {
        dump_ui.open = !dump_ui.open;
    }

    if dump_ui.open {
        egui::Window::new("Debug Dump")
            .default_pos(egui::pos2(60.0, 64.0))
            .default_size(egui::vec2(420.0, 260.0))
            .resizable(true)
            .show(&*ctx, |ui| {
                ui.label("Copy a structured game-state dump for debugging.");
                ui.label("Hotkeys: F9 = copy dump, F8 = toggle this window.");
                ui.separator();

                ui.checkbox(&mut dump_ui.enabled, "Enable telemetry recording");

                ui.add(
                    egui::Slider::new(&mut dump_ui.window_secs, 10.0..=600.0)
                        .text("Window (seconds)"),
                );
                ui.add(
                    egui::Slider::new(&mut dump_ui.interval_secs, 0.25..=5.0)
                        .text("Sample interval (seconds)"),
                );
                ui.add(
                    egui::Slider::new(&mut dump_ui.max_dump_samples, 50..=2000)
                        .text("Max samples in dump"),
                );
                ui.checkbox(
                    &mut dump_ui.include_hovered_tile,
                    "Include hovered tile context",
                );
                ui.add(
                    egui::Slider::new(&mut dump_ui.include_daily_history_days, 0..=240)
                        .text("Daily history (days)"),
                );

                ui.separator();

                ui.horizontal(|ui| {
                    if ui.button("📋 Copy dump (F9)").clicked() {
                        dump_ui.copy_requested = true;
                    }
                    if ui.button("💾 Save dump to file").clicked() {
                        dump_ui.save_requested = true;
                    }
                    if ui.button("🧹 Clear telemetry").clicked() {
                        dump_ui.clear_requested = true;
                    }
                });

                ui.separator();

                ui.label(format!(
                    "Telemetry buffer: {} samples (t≈{:.1}s)",
                    telemetry.samples.len(),
                    telemetry.t_real_s
                ));

                if let Some(last) = dump_ui.last_copy {
                    ui.label(format!(
                        "Last dump: {} chars, {} samples @ t={:.1}s",
                        last.chars, last.samples, last.at_t_real_s
                    ));
                }

                ui.separator();
                ui.label("Paste the copied dump into chat for analysis.");
            });
    }

    if dump_ui.clear_requested {
        telemetry.samples.clear();
        telemetry.t_real_s = 0.0;
        telemetry.last_sample_t_s = 0.0;
        dump_ui.clear_requested = false;
    }

    let want_dump = dump_ui.copy_requested || dump_ui.save_requested;
    if !want_dump {
        return;
    }

    // Build the dump and either copy it to clipboard, save to file, or both.
    let dump = build::build_debug_dump(
        &state,
        &ui_state,
        &city,
        &metrics,
        &hist,
        &map_cfg,
        &grid,
        &hovered,
        day_night.as_deref(),
        q_camera.single().ok(),
        &dump_ui,
        &telemetry,
    );

    let pretty = ron::ser::PrettyConfig::new();
    let dump_ron = ron::ser::to_string_pretty(&dump, pretty).unwrap_or_else(|e| {
        format!(
            "(dump_version: 1, error: \"failed to serialize dump: {:?}\")",
            e
        )
    });

    if dump_ui.copy_requested {
        ctx.copy_text(dump_ron.clone());
        dump_ui.last_copy = Some(DebugDumpCopyInfo {
            at_t_real_s: telemetry.t_real_s,
            chars: dump_ron.len(),
            samples: dump.telemetry.samples.len(),
        });
        info!(
            "Debug dump copied to clipboard ({} chars, {} samples)",
            dump_ron.len(),
            dump.telemetry.samples.len()
        );
    }

    if dump_ui.save_requested {
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let dir = "debug_dumps";
        if let Err(err) = std::fs::create_dir_all(dir) {
            warn!("Failed to create {}: {}", dir, err);
        } else {
            let path = format!("{}/simcity_dump_{}.ron", dir, ts_ms);
            match std::fs::write(&path, dump_ron.as_bytes()) {
                Ok(_) => info!("Saved debug dump to {}", path),
                Err(err) => warn!("Failed to save debug dump to {}: {}", path, err),
            }
        }
    }

    dump_ui.copy_requested = false;
    dump_ui.save_requested = false;
}

#[derive(Debug, serde::Serialize)]
struct DebugDump {
    dump_version: u32,
    generated_at_unix_ms: u64,

    app_state: String,
    sim_speed: String,
    tool: String,
    overlay: String,

    map: DebugDumpMap,
    camera: Option<DebugDumpCamera>,
    hovered_tile: Option<DebugDumpHoveredTile>,

    city: DebugDumpCity,
    ui_metrics: DebugDumpUiMetrics,

    telemetry: DebugDumpTelemetry,
    daily_history: Vec<DebugDumpDailySample>,
    notes: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpMap {
    width: i32,
    height: i32,
    tile_size: f32,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpCamera {
    translation: (f32, f32, f32),
    projection: String,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpHoveredTile {
    pos: (i32, i32),
    overlay_source: String,
    height: u8,
    water: bool,
    terrain: String,
    road: String,
    zone: String,
    building: String,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpCity {
    day: u32,
    money: i64,
    population: u32,
    last_income: i64,
    last_expense: i64,
    happiness: f32,
    time_of_day: Option<f32>,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpUiMetrics {
    citizens: usize,
    vehicles: usize,
    buildings: usize,
    employed: usize,
    unemployed: usize,
    employment_rate: f32,
    avg_commute_secs: f32,
    traffic_avg: f32,
    traffic_max: f32,
    traffic_max_tile: Option<(i32, i32)>,
    traffic_max_tile_vehicles: u16,
    traffic_max_tile_capacity: u16,
    demand_r: f32,
    demand_c: f32,
    demand_i: f32,
    active_emergencies: u32,
    emergencies_resolved: u32,
    emergencies_failed: u32,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpTelemetry {
    window_secs: f32,
    interval_secs: f32,
    max_dump_samples: usize,
    sample_stride: usize,
    summary: DebugDumpTelemetrySummary,
    samples: Vec<DebugTelemetrySample>,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpTelemetrySummary {
    t_span_s: f32,
    money_delta: i64,
    population_delta: i64,
    traffic_avg_min: f32,
    traffic_avg_max: f32,
    vehicles_no_route_max: u32,
    vehicles_zero_speed_max: u32,
    emergencies_active_max: u32,
}

#[derive(Debug, serde::Serialize)]
struct DebugDumpDailySample {
    day: u32,
    population: u32,
    money: i64,
    traffic_avg: f32,
}
