use super::common::TopBarParams;
use super::*;
use crate::game::mcp_status::{MCP_ACTIVE_WINDOW_S, MCP_IDLE_WINDOW_S, McpConnectionStatus};
use bevy::diagnostic::FrameTimeDiagnosticsPlugin;
use bevy_egui::{EguiContexts, egui};

/// Compact top status bar with key metrics
// egui 0.34 deprecates top-level `Panel::show(ctx)` without a non-deprecated replacement yet.
#[allow(deprecated)]
pub(super) fn top_status_bar_ui(mut contexts: EguiContexts, mut p: TopBarParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    egui::Panel::top("status_bar")
        .exact_size(32.0)
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

                // Single game time (GDD 5.2): Day + hour, phase for day/night from City
                let (time_icon, phase) = if p.city.hour >= 6 && p.city.hour < 12 {
                    ("🌅", "Dawn")
                } else if p.city.hour >= 12 && p.city.hour < 18 {
                    ("🌤", "Day")
                } else if p.city.hour >= 18 && p.city.hour < 21 {
                    ("🌆", "Dusk")
                } else {
                    ("🌙", "Night")
                };
                ui.label(format!(
                    "📅 {} Day {} {:02}:00 ({})",
                    time_icon, p.city.day, p.city.hour, phase
                ));
                ui.separator();

                // Sim speed (compact buttons)
                ui.horizontal(|ui| {
                    let resp =
                        ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::Paused, "⏸");
                    resp.on_hover_text("Pause simulation");
                    let resp = ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X1, "▶");
                    resp.on_hover_text("Normal speed (1x)");
                    let resp = ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X2, "▶▶");
                    resp.on_hover_text("Fast speed (2x: 0.8s/hour)");
                    let resp = ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X3, "▶▶▶");
                    resp.on_hover_text("Very fast speed (3x: 0.5s/hour)");
                });
                ui.separator();

                // Show scenario progress if in scenario mode
                if p.scenario_progress.active_id.is_some() {
                    let completion = if p.scenario_progress.objectives_total > 0 {
                        (p.scenario_progress.objectives_completed as f32
                            / p.scenario_progress.objectives_total as f32)
                            * 100.0
                    } else {
                        0.0
                    };
                    ui.label(format!("📋 Scenario: {:.0}%", completion));
                    ui.separator();
                }

                // Show current tool mode
                let tool_name = match p.ui_state.tool {
                    ToolMode::Road(kind) => format!("🛣 {kind:?}"),
                    ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial => {
                        format!("🏘 {:?}", p.ui_state.tool)
                    }
                    ToolMode::FireStation | ToolMode::PoliceStation | ToolMode::Hospital => {
                        format!("🏢 {:?}", p.ui_state.tool)
                    }
                    ToolMode::TrafficLight => "🚦 Traffic Light".to_string(),
                    ToolMode::Erase => "🗑 Erase".to_string(),
                    ToolMode::Inspect => "🔍 Inspect".to_string(),
                };
                ui.label(tool_name);
                ui.separator();

                // Show traffic metrics if available
                if p.metrics.traffic_avg > 0.0 {
                    let traffic_color = if p.metrics.traffic_avg > 0.8 {
                        egui::Color32::LIGHT_RED
                    } else if p.metrics.traffic_avg > 0.5 {
                        egui::Color32::YELLOW
                    } else {
                        egui::Color32::LIGHT_GREEN
                    };
                    ui.colored_label(
                        traffic_color,
                        format!("🚦 Traffic: {:.0}%", p.metrics.traffic_avg * 100.0),
                    );
                    ui.separator();
                }

                if let Some(diags) = p.diagnostics.as_deref() {
                    let fps_raw = diags
                        .get(&FrameTimeDiagnosticsPlugin::FPS)
                        .and_then(|d| d.value())
                        .unwrap_or(0.0) as f32;
                    let fps = diags
                        .get(&FrameTimeDiagnosticsPlugin::FPS)
                        .and_then(|d| d.smoothed())
                        .unwrap_or(fps_raw as f64) as f32;
                    let frame_ms_raw = diags
                        .get(&FrameTimeDiagnosticsPlugin::FRAME_TIME)
                        .and_then(|d| d.value())
                        .unwrap_or(0.0) as f32;
                    let frame_ms = diags
                        .get(&FrameTimeDiagnosticsPlugin::FRAME_TIME)
                        .and_then(|d| d.smoothed())
                        .unwrap_or(frame_ms_raw as f64) as f32;

                    let fps_color = if fps >= 55.0 {
                        egui::Color32::LIGHT_GREEN
                    } else if fps >= 30.0 {
                        egui::Color32::YELLOW
                    } else {
                        egui::Color32::LIGHT_RED
                    };
                    ui.colored_label(fps_color, format!("🎯 FPS: {:.1} ({:.2} ms)", fps, frame_ms))
                        .on_hover_text(format!(
                            "Raw FPS: {:.1}\nRaw frame time: {:.2} ms",
                            fps_raw, frame_ms_raw
                        ));
                    ui.separator();
                }

                // Demand (R/C/I)
                if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                    ui.label(format!(
                        "Demand (R/C/I): {:+.2}/{:+.2}/{:+.2}",
                        p.metrics.demand_r, p.metrics.demand_c, p.metrics.demand_i
                    ))
                    .on_hover_text("R=Residential, C=Commercial, I=Industrial");
                    ui.separator();
                }

                // MCP status (approximation via recent BRP activity)
                let (mcp_label, mcp_color, mcp_tooltip) =
                    mcp_status_label(&p.mcp_status, p.time.elapsed_secs());
                ui.colored_label(mcp_color, mcp_label)
                    .on_hover_text(mcp_tooltip);
                ui.separator();

                // Settings and save (right side)
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                        if ui.button("💾").clicked() {
                            p.commands.write(GameCommand::SaveGame { slot: 1 });
                        }

                        if ui
                            .button("📋")
                            .on_hover_text(format!(
                                "Copy debug dump to clipboard (F9)\nIncludes telemetry for the last {:.0}s",
                                p.debug_dump.window_secs
                            ))
                            .clicked()
                        {
                            p.debug_dump.copy_requested = true;
                        }

                        let resp = ui
                            .selectable_label(p.debug_dump.open, "🐞")
                            .on_hover_text("Debug dump settings");
                        if resp.clicked() {
                            p.debug_dump.open = !p.debug_dump.open;
                        }

                        if p.ui_settings.show_stats {
                            let resp = ui
                                .selectable_label(p.show_stats_window.0, "📈")
                                .on_hover_text("Toggle statistics window");
                            if resp.clicked() {
                                p.show_stats_window.0 = !p.show_stats_window.0;
                            }
                        }

                        // Debug: Dump save contract
                        if ui
                            .button("🔍")
                            .on_hover_text("Dump save contract (debug)")
                            .clicked()
                        {
                            p.commands.write(GameCommand::DumpSaveContract);
                        }

                        // Undo/Redo buttons
                        let can_undo = p.history.as_deref().map(|h| h.can_undo()).unwrap_or(false);
                        let can_redo = p.history.as_deref().map(|h| h.can_redo()).unwrap_or(false);

                        ui.add_enabled_ui(can_redo, |ui| {
                            if ui.button("↶").on_hover_text("Redo (Ctrl+Y)").clicked() {
                                // Redo is handled by hotkey, but button provides visual feedback
                            }
                        });
                        ui.add_enabled_ui(can_undo, |ui| {
                            if ui.button("↷").on_hover_text("Undo (Ctrl+Z)").clicked() {
                                // Undo is handled by hotkey, but button provides visual feedback
                            }
                        });
                    }
                });
            });
        });
}

/// Build a compact label for MCP activity based on recent BRP requests.
fn mcp_status_label(status: &McpConnectionStatus, now_s: f32) -> (String, egui::Color32, String) {
    if !status.remote_enabled {
        return (
            "🔌 MCP: off".to_string(),
            egui::Color32::DARK_GRAY,
            "RemotePlugin is not initialized.".to_string(),
        );
    }

    let age = status.last_request_at_s.map(|t| (now_s - t).max(0.0));

    let (label, color) = if status.pending_requests > 0 {
        ("🔌 MCP: active".to_string(), egui::Color32::LIGHT_GREEN)
    } else if let Some(age_s) = age {
        if age_s <= MCP_ACTIVE_WINDOW_S {
            ("🔌 MCP: active".to_string(), egui::Color32::LIGHT_GREEN)
        } else if age_s <= MCP_IDLE_WINDOW_S {
            (
                format!("🔌 MCP: idle ({:.0}s)", age_s),
                egui::Color32::YELLOW,
            )
        } else {
            ("🔌 MCP: idle".to_string(), egui::Color32::GRAY)
        }
    } else {
        ("🔌 MCP: waiting".to_string(), egui::Color32::GRAY)
    };

    let age_text = age
        .map(|value| format!("{:.1}s ago", value))
        .unwrap_or_else(|| "never".to_string());
    let tooltip = format!(
        "BRP HTTP is stateless; this shows recent remote activity.\nPending requests: {}\nLast request: {}",
        status.pending_requests, age_text
    );

    (label, color, tooltip)
}
