use super::common::TopBarParams;
use super::*;
use bevy_egui::{EguiContexts, egui};

/// Compact top status bar with key metrics
pub(super) fn top_status_bar_ui(mut contexts: EguiContexts, mut p: TopBarParams) {
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

                // Day and Game Time (GDD: HH:00 format)
                ui.label(format!("📅 Day {} {:02}:00", p.city.day, p.city.hour));
                ui.separator();

                // Time of day with icon (visual day/night cycle)
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
                let tool_name = match &p.mode.selected {
                    crate::game::map::BuildTool::Road(kind) => format!("🛣 {:?}", kind),
                    crate::game::map::BuildTool::Zone(zone) => format!("🏘 {:?}", zone),
                    crate::game::map::BuildTool::PlaceBuilding(kind) => format!("🏢 {:?}", kind),
                    crate::game::map::BuildTool::TrafficLight => "🚦 Traffic Light".to_string(),
                    crate::game::map::BuildTool::Erase => "🗑 Erase".to_string(),
                    crate::game::map::BuildTool::Inspect => "🔍 Inspect".to_string(),
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

                // Demand (R/C/I)
                if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                    ui.label(format!(
                        "Demand (R/C/I): {:+.2}/{:+.2}/{:+.2}",
                        p.metrics.demand_r, p.metrics.demand_c, p.metrics.demand_i
                    ))
                    .on_hover_text("R=Residential, C=Commercial, I=Industrial");
                    ui.separator();
                }

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
