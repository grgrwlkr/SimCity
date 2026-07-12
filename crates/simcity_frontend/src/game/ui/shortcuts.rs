use super::*;

#[derive(Resource, Default)]
pub(super) struct ShowShortcuts(pub(super) bool);

pub(super) fn toggle_shortcuts(keys: Res<ButtonInput<KeyCode>>, mut show: ResMut<ShowShortcuts>) {
    // Toggle with ? key (Shift+/ on US keyboard)
    if keys.just_pressed(KeyCode::Slash)
        && (keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight))
    {
        show.0 = !show.0;
    }
}

pub(super) fn shortcuts_ui(mut contexts: EguiContexts, show: Res<ShowShortcuts>) {
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
            ui.label("Ctrl + LMB drag — Orbit camera");
            ui.label("Mouse wheel — Zoom");
            ui.label("Q / E — Rotate camera");
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
            ui.label("Ctrl+Z — Undo");
            ui.label("Ctrl+Y — Redo");
            ui.label("Esc — Back to menu");
            ui.label("F8 — Debug dump window");
            ui.label("F9 — Copy debug dump");
            ui.label("F10 — UI settings panel");

            ui.separator();
            ui.label("Press ? to toggle this panel");
        });
}
