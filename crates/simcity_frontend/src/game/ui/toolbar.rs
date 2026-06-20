use super::common::{TopBarParams, overlay_tooltip, tool_tooltip};
use super::*;
use bevy_egui::{EguiContexts, egui};

/// Bottom toolbar with categorized tools
// egui 0.34 deprecates top-level `Panel::show(ctx)` without a non-deprecated replacement yet.
#[allow(deprecated)]
pub(super) fn bottom_toolbar_ui(mut contexts: EguiContexts, mut p: TopBarParams) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    egui::Panel::bottom("toolbar")
        .exact_size(48.0)
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
                    let resp = ui
                        .button("🚦 Traffic Light (free)")
                        .on_hover_text(tool_tooltip(ToolMode::TrafficLight));
                    if resp.clicked() {
                        p.ui_state.tool = ToolMode::TrafficLight;
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
                    NextState::set_if_neq(&mut *p.next_state, AppState::InGame);
                }
                if ui.button("Load Test City").clicked() {
                    p.commands.write(GameCommand::LoadTestCity);
                    NextState::set_if_neq(&mut *p.next_state, AppState::InGame);
                }

                if matches!(p.state.get(), AppState::InGame | AppState::Paused) {
                    ui.separator();
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
                            NextState::set_if_neq(&mut *p.next_state, AppState::InGame);
                        }
                    }
                    AppState::InGame => {
                        if ui.button("Pause").clicked() {
                            NextState::set_if_neq(&mut *p.next_state, AppState::Paused);
                        }
                    }
                    AppState::Paused => {
                        if ui.button("Resume").clicked() {
                            NextState::set_if_neq(&mut *p.next_state, AppState::InGame);
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
                        ToolMode::TrafficLight => "Traffic Light".to_string(),
                        ToolMode::Erase => "Erase".to_string(),
                        ToolMode::Inspect => "Inspect".to_string(),
                    };
                    ui.label(format!("Selected: {}", tool_text));
                });
            });
        });
}
