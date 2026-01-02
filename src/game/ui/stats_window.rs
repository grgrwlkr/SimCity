use super::*;
use bevy_egui::{EguiContexts, egui};

/// Resource to control visibility of statistics window
#[derive(Resource, Default)]
pub(super) struct ShowStatsWindow(pub(super) bool);

pub(super) fn stats_ui(
    mut contexts: EguiContexts,
    state: Res<State<AppState>>,
    hist: Res<UiHistory>,
    ui_settings: Res<UiSettings>,
    mut show: ResMut<ShowStatsWindow>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    if !matches!(state.get(), AppState::InGame | AppState::Paused) || !ui_settings.show_stats {
        show.0 = false;
        return;
    }

    if !show.0 {
        return;
    }

    let mut open = show.0;

    egui::Window::new("Statistics")
        .open(&mut open)
        .default_pos(egui::pos2(40.0, 64.0))
        .default_size(egui::vec2(460.0, 340.0))
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

    show.0 = open;
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
